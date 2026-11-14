//! The settlement of a pending switch that stays on the agent's provider: under the agent's lock
//! the switch is read again and its axes checked again, then `agent.providerBinding.changed` lands
//! the binding it moves to in place, or `agent.providerBinding.changeFailed` records why it could
//! not. Each terminal event commits with a compare-and-set on the switch id in its own write, so a
//! switch replaced or canceled meanwhile is abandoned with nothing written.

use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::definition::binding::AgentProviderBinding;
use sidekicks_contracts::agent::provider_binding::{
    AgentBindingContinuity, AgentBindingSwitchAccountState, AgentBindingSwitchDisposition,
    AgentBindingSwitchFailureReason, AgentBindingSwitchTarget,
    AgentProviderBindingChangeFailedPayload, AgentProviderBindingChangedPayload, InPlaceContinuity,
    SwitchId,
};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_provider::driver::binding_switch::{check_binding_switch, moved_options};
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::error_causes::ProviderAxis;
use sidekicks_provider::runtime_binding::store::write_output_speed;
use sidekicks_session::agents::projection::{AgentRow, StoredPendingSwitch, clear_pending_switch};
use sidekicks_session::run::stored_leg::read_agent_leg;
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::events::session::appender::{SessionEventDraft, SessionEventLinkage};

use super::{ProviderSwitchError, ProviderSwitches};
use crate::orchestration::binding_switch::account_state_of;

// Where the compare-and-set on the switch id sits in a settlement's write.
const SWITCH_STANDS_INDEX: usize = 0;

/// What settling a pending switch came to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SwitchSettlement {
    /// The switch left the agent's row before it settled, replaced or canceled; nothing was
    /// written and no terminal event records it.
    Abandoned,
    /// The switch settled with its one terminal event: `applied` or `failed`.
    Settled(Box<AgentBindingSwitchDisposition>),
}

impl ProviderSwitches {
    /// Settles `switch_id`, the switch `agent_id` has pending, whose target names no provider
    /// other than the binding's: `applied` in place, with the agent's own leg taking a speed it
    /// names, or `failed` where its axes no longer check; `Abandoned` once the switch has left the
    /// row. A driver error that refuses no axis of the target surfaces with nothing written.
    pub(crate) async fn settle_in_place(
        &self,
        agent_id: AgentId,
        switch_id: SwitchId,
    ) -> Result<SwitchSettlement, ProviderSwitchError> {
        let _hold = self.locks.acquire(agent_id).await;
        let row = self.read_row(agent_id).await?;
        let Some(pending) = row
            .pending_switch
            .clone()
            .filter(|pending| pending.switch.switch_id == switch_id)
        else {
            return Ok(SwitchSettlement::Abandoned);
        };
        let target = &pending.switch.pending_axes;
        if let Err(error) = check_binding_switch(
            &self.providers,
            agent_id,
            row.session_id,
            &row.binding,
            target,
        )
        .await
        {
            let Some((reason, account_state)) = failure_of(&error, target) else {
                return Err(error.into());
            };
            return self
                .settle_failed(&row, &pending, reason, account_state)
                .await;
        }
        let to = target_binding(&row.binding, target);
        let leg = read_agent_leg(&self.pool, row.session_id, agent_id).await?;
        let landed_provider_account_id = match (&leg, &to.provider_account_id) {
            (Some(leg), _) => leg.spawn_config.provider_account_id.clone(),
            (None, Some(pinned)) => pinned.clone(),
            (None, None) => {
                let current = self
                    .account_reader
                    .current_account(to.provider_name.clone())
                    .await
                    .map_err(ProviderSwitchError::AccountRead)?;
                match current.into_required() {
                    Ok(current) => current,
                    Err(error) => {
                        let account_state = Some(account_state_of(&error));
                        return self
                            .settle_failed(
                                &row,
                                &pending,
                                AgentBindingSwitchFailureReason::AccountUnavailable,
                                account_state,
                            )
                            .await;
                    }
                }
            }
        };
        let speed_patch = target
            .output_speed
            .as_ref()
            .zip(leg.as_ref())
            .map(|(output_speed, leg)| write_output_speed(&leg.id, output_speed));
        let changed =
            SessionEvent::AgentProviderBindingChanged(AgentProviderBindingChangedPayload {
                switch_id: switch_id.clone(),
                declared_losses: Vec::new(),
                continuity: AgentBindingContinuity::InPlace,
                session_id: row.session_id,
                agent_id,
                actor: pending.actor.clone(),
                from: row.binding.clone(),
                to,
                landed_provider_account_id,
            });
        if !self
            .commit_settlement(row.session_id, agent_id, &switch_id, &changed, speed_patch)
            .await?
        {
            return Ok(SwitchSettlement::Abandoned);
        }
        Ok(SwitchSettlement::Settled(Box::new(
            AgentBindingSwitchDisposition::Applied {
                switch_id,
                continuity: InPlaceContinuity::Value,
                declared_losses: BoundedVec::new(Vec::new()).expect("no loss is an empty list"),
            },
        )))
    }

    /// Fails `pending`, the switch `row`'s agent has pending, for `reason`, with `account_state`
    /// exactly on `accountUnavailable`: `agent.providerBinding.changeFailed` keeps the binding and
    /// clears the switch; `Abandoned`, with nothing written, once the switch has left the row. It
    /// takes no lock of its own, since the compare-and-set is what keeps a newer switch.
    pub(crate) async fn settle_failed(
        &self,
        row: &AgentRow,
        pending: &StoredPendingSwitch,
        reason: AgentBindingSwitchFailureReason,
        account_state: Option<AgentBindingSwitchAccountState>,
    ) -> Result<SwitchSettlement, ProviderSwitchError> {
        let switch_id = pending.switch.switch_id.clone();
        let failed = SessionEvent::AgentProviderBindingChangeFailed(
            AgentProviderBindingChangeFailedPayload {
                switch_id: switch_id.clone(),
                reason,
                account_state,
                session_id: row.session_id,
                agent_id: row.agent_id,
                actor: pending.actor.clone(),
                from: row.binding.clone(),
                attempted: pending.switch.pending_axes.clone(),
            },
        );
        if !self
            .commit_settlement(row.session_id, row.agent_id, &switch_id, &failed, None)
            .await?
        {
            return Ok(SwitchSettlement::Abandoned);
        }
        Ok(SwitchSettlement::Settled(Box::new(
            AgentBindingSwitchDisposition::Failed {
                switch_id,
                reason,
                account_state,
            },
        )))
    }

    // Appends `event` with, in its write, the compare-and-set that clears `switch_id` from
    // `agent_id`'s row, then `patch`; answers false, with nothing written, when the switch has left
    // the row.
    async fn commit_settlement(
        &self,
        session_id: SessionId,
        agent_id: AgentId,
        switch_id: &SwitchId,
        event: &SessionEvent,
        patch: Option<WriteStatement>,
    ) -> Result<bool, ProviderSwitchError> {
        let mut transactional_prelude = vec![clear_pending_switch(&agent_id, switch_id)];
        transactional_prelude.extend(patch);
        let appended = self
            .appender
            .append(
                SessionEventDraft::of_session(session_id, event)?,
                SessionEventLinkage {
                    transactional_prelude,
                    ..SessionEventLinkage::default()
                },
            )
            .await;
        match appended {
            Ok(_receipt) => Ok(true),
            Err(error) if error.refused_statement_index() == Some(SWITCH_STANDS_INDEX) => Ok(false),
            Err(error) => Err(error.into()),
        }
    }
}

// The binding `target` moves `binding` to: each member it names set, an option it names set to its
// value with every other kept, a window of `null` back to the default, and an account it names
// pinned.
fn target_binding(
    binding: &AgentProviderBinding,
    target: &AgentBindingSwitchTarget,
) -> AgentProviderBinding {
    AgentProviderBinding {
        provider_name: target
            .provider_name
            .clone()
            .unwrap_or_else(|| binding.provider_name.clone()),
        model_id: target
            .model_id
            .clone()
            .unwrap_or_else(|| binding.model_id.clone()),
        provider_account_id: target
            .provider_account_id
            .clone()
            .or_else(|| binding.provider_account_id.clone()),
        effort: target.effort.clone().or_else(|| binding.effort.clone()),
        output_speed: target
            .output_speed
            .clone()
            .or_else(|| binding.output_speed.clone()),
        options: match &target.options {
            Some(moved) => moved_options(binding.options.as_ref(), moved),
            None => binding.options.clone(),
        },
        larger_window: target.larger_window.unwrap_or(binding.larger_window),
    }
}

// Why a re-check's refusal of `target` fails the switch, with the account's state exactly on an
// account failure; `None` for a driver error that refuses nothing of the target, which surfaces.
fn failure_of(
    error: &DriverError,
    target: &AgentBindingSwitchTarget,
) -> Option<(
    AgentBindingSwitchFailureReason,
    Option<AgentBindingSwitchAccountState>,
)> {
    match error {
        DriverError::ProviderAxisInvalid(invalid) => {
            let reason = match invalid.axis {
                ProviderAxis::ProviderName => AgentBindingSwitchFailureReason::ProviderUnavailable,
                ProviderAxis::ModelId | ProviderAxis::LargerWindow => {
                    AgentBindingSwitchFailureReason::ModelUnavailable
                }
                ProviderAxis::Effort => AgentBindingSwitchFailureReason::EffortUnavailable,
                ProviderAxis::OutputSpeed => {
                    AgentBindingSwitchFailureReason::OutputSpeedUnavailable
                }
                ProviderAxis::Options => AgentBindingSwitchFailureReason::TargetUnstartable,
            };
            Some((reason, None))
        }
        // The check's one capability refusal is the speed's, asked only for a target naming one.
        DriverError::Refused(refusal)
            if refusal.code == RefusalCode::ProviderCapabilityUnsupported
                && target.output_speed.is_some() =>
        {
            Some((
                AgentBindingSwitchFailureReason::OutputSpeedUnavailable,
                None,
            ))
        }
        DriverError::Refused(refusal) if refusal.code.as_str().starts_with("provider.account.") => {
            Some((
                AgentBindingSwitchFailureReason::AccountUnavailable,
                Some(account_state_of(error)),
            ))
        }
        DriverError::Refused(_)
        | DriverError::Unanswered(_)
        | DriverError::SteerTurnEnded(_)
        | DriverError::RunRefused(_)
        | DriverError::CapabilityProbe(_)
        | DriverError::ExecutableUnresolvable(_)
        | DriverError::ModelCatalogUnreadable(_)
        | DriverError::RuleNotKept(_)
        | DriverError::SkillNotListed(_)
        | DriverError::NoPersonServerEntry(_)
        | DriverError::SignInFailed(_)
        | DriverError::Internal(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use futures::FutureExt as _;
    use rstest::rstest;
    use rusqlite::Connection;
    use serde_json::json;
    use sidekicks_contracts::agent::provider_binding::{
        AgentBindingSwitchAccountState, AgentBindingSwitchBoundary, AgentBindingSwitchDisposition,
        AgentBindingSwitchFailureReason, AgentBindingSwitchPending, AgentBindingSwitchTarget,
        PendingSwitchStatus, SwitchId,
    };
    use sidekicks_contracts::event::registry::SessionEventType;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::provider::driver::capabilities::ProviderModel;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::text::FreeFormText;
    use sidekicks_ipc::domain_error::DomainError;
    use sidekicks_provider::driver::capabilities::{
        DriverCapabilities, DriverCapabilityFlag, DriverCapabilityFlags,
    };
    use sidekicks_provider::driver::contract::MockProviderDriver;
    use sidekicks_provider::driver::contract::error::DriverError;
    use sidekicks_provider::driver::registry::test_token;
    use sidekicks_provider::driver::test_registry::{
        bind_run_to_first_provider, first_provider, new_run_id,
    };
    use sidekicks_session::agents::projection::test_fixture::{run_statements, write_log_row};
    use sidekicks_session::agents::projection::{StoredPendingSwitch, write_pending_switch};

    use super::{SwitchSettlement, failure_of};
    use crate::orchestration::binding_switch::mint_switch_id;
    use crate::orchestration::provider_switch::tests::{Fixture, MODEL, pending_ids};

    // The agent's model, listing only the `low` effort.
    fn low_effort_catalog() -> Vec<ProviderModel> {
        vec![ProviderModel {
            id: test_token(MODEL),
            name: test_token(MODEL),
            capabilities: Vec::new(),
            effort_levels: Some(vec![test_token("low")]),
            output_speed_levels: None,
            fast: false,
            larger_window: false,
            is_default: false,
            context_window: None,
        }]
    }

    // The types of the events `session_id`'s log holds, in order.
    fn logged_types(connection: &Connection, session_id: SessionId) -> Vec<String> {
        connection
            .prepare("SELECT type FROM session_events WHERE session_id = ?1 ORDER BY sequence")
            .expect("the test's read prepares")
            .query_map([session_id.text().as_str()], |row| row.get(0))
            .expect("the log reads")
            .collect::<Result<_, _>>()
            .expect("each type reads")
    }

    // A pending switch to the `low` effort, as another device's acceptance stores it.
    fn newer_switch(switch_id: &SwitchId) -> StoredPendingSwitch {
        StoredPendingSwitch {
            switch: AgentBindingSwitchPending {
                status: PendingSwitchStatus::Value,
                switch_id: switch_id.clone(),
                applies_at: AgentBindingSwitchBoundary::TurnBoundary,
                interrupt_requested: false,
                pending_axes: AgentBindingSwitchTarget {
                    provider_name: None,
                    model_id: None,
                    provider_account_id: None,
                    effort: Some(test_token("low")),
                    output_speed: None,
                    options: None,
                    larger_window: None,
                },
                replaced_switch_id: None,
            },
            actor: serde_json::from_value(json!("device-2")).expect("the test names a device"),
            interrupt_dispatch: None,
        }
    }

    // What a settlement in the case table comes to.
    #[derive(Clone, Copy, Debug)]
    enum Outcome {
        Applied,
        Failed,
        Abandoned,
    }

    // A pending switch to the `high` effort settles with one terminal event: `changed` where the
    // re-check passes, `changeFailed` for want of the effort where it refuses, and nothing where a
    // later switch replaced it first. Killed by the re-check skipped, a `changed` for a refused
    // re-check, two events for one switch, and a stale switch settled over the newer one.
    #[rstest]
    #[case::applies(false, Vec::new(), Outcome::Applied, &["agent.providerBinding.changed"])]
    #[case::replaced_before_the_call(true, Vec::new(), Outcome::Abandoned, &[])]
    #[case::refused_by_the_re_check(
        false,
        low_effort_catalog(),
        Outcome::Failed,
        &["agent.providerBinding.changeFailed"]
    )]
    #[tokio::test]
    async fn a_pending_switch_settles_once_as_its_re_check_and_its_row_allow(
        #[case] is_replaced: bool,
        #[case] re_check_catalog: Vec<ProviderModel>,
        #[case] outcome: Outcome,
        #[case] logged: &[&str],
    ) {
        let reads = Arc::new(AtomicUsize::new(0));
        let fixture = Fixture::with_driver(|_| {
            let reads = Arc::clone(&reads);
            let mut driver = MockProviderDriver::new();
            driver.expect_list_models().returning(move |_| {
                // The acceptance reads an empty catalog, which accepts any effort.
                let rows = if reads.fetch_add(1, Ordering::SeqCst) == 0 {
                    Vec::new()
                } else {
                    re_check_catalog.clone()
                };
                async move { Ok(rows) }.boxed()
            });
            driver
        })
        .await;
        let (switch_id, _) = pending_ids(
            fixture
                .accept(json!({ "effort": "high" }))
                .await
                .expect("the switch is accepted"),
        );
        let newer = mint_switch_id();
        if is_replaced {
            run_statements(
                &fixture.database.reader(),
                &[write_pending_switch(
                    &fixture.agent_id,
                    &newer_switch(&newer),
                )],
            );
        }

        let settled = fixture
            .switches
            .settle_in_place(fixture.agent_id, switch_id.clone())
            .await
            .expect("the settlement answers");

        assert_eq!(
            logged_types(&fixture.database.reader(), fixture.session_id),
            logged
                .iter()
                .map(|logged| (*logged).to_owned())
                .collect::<Vec<_>>()
        );
        let row = fixture.row();
        let (expected, effort) = match outcome {
            Outcome::Applied => (
                AgentBindingSwitchDisposition::Applied {
                    switch_id,
                    continuity: super::InPlaceContinuity::Value,
                    declared_losses: super::BoundedVec::new(Vec::new()).expect("an empty list"),
                },
                Some(test_token("high")),
            ),
            Outcome::Failed => (
                AgentBindingSwitchDisposition::Failed {
                    switch_id,
                    reason: AgentBindingSwitchFailureReason::EffortUnavailable,
                    account_state: None,
                },
                None,
            ),
            Outcome::Abandoned => {
                assert_eq!(settled, SwitchSettlement::Abandoned);
                assert_eq!(fixture.pending_id(), Some(newer));
                return;
            }
        };
        assert_eq!(settled, SwitchSettlement::Settled(Box::new(expected)));
        assert_eq!(row.binding.effort, effort);
        assert_eq!(row.pending_switch, None);
    }

    // A switch replaced after the settlement read the row, while its re-check reads the catalog,
    // is abandoned by the compare-and-set in the terminal event's own write: nothing is appended
    // and the newer switch stands. Killed by the id compared only before the append.
    #[tokio::test]
    async fn a_switch_replaced_during_its_re_check_appends_nothing() {
        let reads = Arc::new(AtomicUsize::new(0));
        let newer = mint_switch_id();
        let fixture = Fixture::with_driver(|seeded| {
            let reads = Arc::clone(&reads);
            let newer = newer.clone();
            let mut driver = MockProviderDriver::new();
            driver.expect_list_models().returning(move |_| {
                if reads.fetch_add(1, Ordering::SeqCst) == 1 {
                    run_statements(
                        &Connection::open(&seeded.path).expect("the test opens the database"),
                        &[write_pending_switch(
                            &seeded.agent_id,
                            &newer_switch(&newer),
                        )],
                    );
                }
                async { Ok(Vec::new()) }.boxed()
            });
            driver
        })
        .await;
        let (switch_id, _) = pending_ids(
            fixture
                .accept(json!({ "effort": "high" }))
                .await
                .expect("the switch is accepted"),
        );

        let settled = fixture
            .switches
            .settle_in_place(fixture.agent_id, switch_id)
            .await
            .expect("the settlement answers");

        assert_eq!(settled, SwitchSettlement::Abandoned);
        assert_eq!(fixture.pending_id(), Some(newer));
        assert_eq!(fixture.row().binding.effort, None);
        assert_eq!(
            logged_types(&fixture.database.reader(), fixture.session_id),
            Vec::<String>::new()
        );
    }

    // An in-place speed switch on a session that ran writes the speed into the agent's own leg in
    // its settlement's write, so the next spawn runs at it. Killed by the speed patch dropped or
    // aimed at no leg.
    #[tokio::test]
    async fn an_in_place_speed_switch_moves_the_agents_leg_to_the_target_speed() {
        let fixture = Fixture::with_driver(|_| {
            let mut driver = MockProviderDriver::new();
            driver
                .expect_list_models()
                .returning(|_| async { Ok(Vec::new()) }.boxed());
            driver
        })
        .await;
        fixture
            .switches
            .providers
            .record_capabilities(
                &first_provider(),
                DriverCapabilities {
                    flags: DriverCapabilityFlags::from_fn(|flag| {
                        flag == DriverCapabilityFlag::OutputSpeed
                    }),
                    contract_version: FreeFormText::new("1".to_owned()).expect("a version"),
                },
            )
            .expect("the first provider is registered");
        // The agent's run, which its log names, bound to a leg.
        let run_id = new_run_id();
        write_log_row(
            &fixture.database.reader(),
            fixture.session_id,
            1,
            (
                SessionEventType::AgentRunQueued,
                &json!({ "agentId": fixture.agent_id }),
            ),
            Some(run_id),
            "2026-10-28T09:02:00.000Z",
        );
        let leg_id = bind_run_to_first_provider(&fixture.database, run_id);
        // A leg with a conversation to resume is the one a session that ran keeps.
        fixture
            .database
            .reader()
            .execute(
                "UPDATE runtime_bindings SET resume_handle = 'conversation-1' WHERE id = ?1",
                [leg_id.as_str()],
            )
            .expect("the leg takes its conversation");
        let (switch_id, _) = pending_ids(
            fixture
                .accept(json!({ "outputSpeed": "fast" }))
                .await
                .expect("the switch is accepted"),
        );

        let settled = fixture
            .switches
            .settle_in_place(fixture.agent_id, switch_id)
            .await
            .expect("the settlement answers");

        assert!(
            matches!(
                &settled,
                SwitchSettlement::Settled(disposition)
                    if matches!(**disposition, AgentBindingSwitchDisposition::Applied { .. })
            ),
            "the switch applies: {settled:?}"
        );
        let speed: Option<String> = fixture
            .database
            .reader()
            .query_row(
                "SELECT json_extract(spawn_config, '$.outputSpeed') FROM runtime_bindings
                  WHERE id = ?1",
                [leg_id.as_str()],
                |row| row.get(0),
            )
            .expect("the leg reads");
        assert_eq!(speed.as_deref(), Some("fast"));
    }

    // A re-check refused for no account registered, or for the account named not found, fails the
    // switch with `notRegistered`, and one refused for no current account stays undecided. Killed
    // by either code read as undecided, and by the current account's refusal read as unregistered.
    #[rstest]
    #[case::no_account_registered(
        RefusalCode::ProviderAccountNotRegistered,
        AgentBindingSwitchAccountState::NotRegistered
    )]
    #[case::account_not_found(
        RefusalCode::ProviderAccountNotFound,
        AgentBindingSwitchAccountState::NotRegistered
    )]
    #[case::no_current_account(
        RefusalCode::ProviderAccountCurrentNotSet,
        AgentBindingSwitchAccountState::Indeterminate
    )]
    fn an_account_refusal_fails_the_switch_with_the_state_it_names(
        #[case] code: RefusalCode,
        #[case] account_state: AgentBindingSwitchAccountState,
    ) {
        let refusal = DriverError::from(DomainError::new("the account refused", code));
        let no_move = AgentBindingSwitchTarget {
            provider_name: None,
            model_id: None,
            provider_account_id: None,
            effort: None,
            output_speed: None,
            options: None,
            larger_window: None,
        };

        assert_eq!(
            failure_of(&refusal, &no_move),
            Some((
                AgentBindingSwitchFailureReason::AccountUnavailable,
                Some(account_state)
            ))
        );
    }
}
