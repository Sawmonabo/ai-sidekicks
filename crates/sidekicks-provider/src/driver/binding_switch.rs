//! The check an agent's provider switch passes before it is accepted: every axis the switch names
//! is held against the target driver and its model catalog, and the answer is where the switch
//! applies on that provider; and the options a switch lands, its own laid over the agent's.

use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::definition::binding::AgentProviderBinding;
use sidekicks_contracts::agent::provider_binding::{
    AgentBindingSwitchBoundary, AgentBindingSwitchTarget,
};
use sidekicks_contracts::provider::declaration::{ProviderOptionSetting, ProviderOptionSettings};
use sidekicks_contracts::provider::driver::capabilities::find_provider_model_row;
use sidekicks_contracts::session::id::SessionId;

use crate::driver::capabilities::DriverCapabilityFlag;
use crate::driver::contract::error::DriverError;
use crate::driver::contract::params_and_results::{LeadBindingCheckParams, ListModelsParams};
use crate::driver::error_causes::ProviderAxisInvalid;
use crate::driver::registry::ProviderRegistry;

/// Checks every axis `target` names against the provider it lands on before anything of the
/// switch is spent, and answers where the switch applies: the end of the run in flight when the
/// provider moves, else the widest boundary of the axes it names.
pub async fn check_binding_switch(
    providers: &ProviderRegistry,
    agent_id: AgentId,
    session_id: SessionId,
    current: &AgentProviderBinding,
    target: &AgentBindingSwitchTarget,
) -> Result<AgentBindingSwitchBoundary, DriverError> {
    let provider = target
        .provider_name
        .as_ref()
        .unwrap_or(&current.provider_name);
    let is_provider_moved = target
        .provider_name
        .as_ref()
        .is_some_and(|named| *named != current.provider_name);
    // The registry's one refusal is a provider no driver answers.
    let Ok(driver) = providers.lookup(provider) else {
        return Err(ProviderAxisInvalid::provider_not_registered(agent_id, provider).into());
    };
    let descriptor = providers.descriptor(provider)?;
    if target.output_speed.is_some() {
        providers.check_capability(provider, DriverCapabilityFlag::OutputSpeed)?;
    }
    let model_id = target.model_id.as_ref().unwrap_or(&current.model_id);
    // The options checked are the ones the switch lands: the target's over the agent's own.
    if let Some(target_options) = &target.options {
        driver.check_lead_binding(LeadBindingCheckParams {
            agent_id,
            model_id: model_id.clone(),
            effort: target.effort.clone().or_else(|| current.effort.clone()),
            options: moved_options(current.options.as_ref(), target_options),
        })?;
    }
    let names_catalog_axis = target.model_id.is_some()
        || target.effort.is_some()
        || target.output_speed.is_some()
        || target.larger_window.is_some();
    if names_catalog_axis {
        // Only the agent's own provider reads its catalog against the session and its account.
        let (session_id, provider_account_id) = if is_provider_moved {
            (None, None)
        } else {
            (Some(session_id), current.provider_account_id.clone())
        };
        let rows = driver
            .list_models(ListModelsParams {
                session_id,
                provider_account_id,
            })
            .await?;
        // A model the catalog does not list may still run; the provider's own check decides it,
        // its window, its effort and its speed when the switch applies.
        let is_model_listed = rows.iter().any(|row| row.id.as_str() == model_id.as_str());
        if let Some(Some(window)) = target.larger_window
            && is_model_listed
        {
            let has_larger_row = find_provider_model_row(&rows, model_id.as_str(), true).is_some();
            ProviderAxisInvalid::check_larger_window(agent_id, window, has_larger_row)?;
        }
        let is_larger_window = match target.larger_window {
            Some(window) => window.is_some(),
            None => current.larger_window.is_some(),
        };
        if let Some(row) = find_provider_model_row(&rows, model_id.as_str(), is_larger_window) {
            if let Some(effort) = &target.effort {
                ProviderAxisInvalid::check_effort(
                    agent_id,
                    effort.as_str(),
                    row.effort_levels.as_deref(),
                )?;
            }
            if let Some(speed) = &target.output_speed {
                // The row's own levels where the catalog lists them, else the driver's fixed set.
                match row.output_speed_levels.as_deref() {
                    Some(levels) => ProviderAxisInvalid::check_output_speed(
                        agent_id,
                        speed.as_str(),
                        Some(levels),
                    )?,
                    None => ProviderAxisInvalid::check_output_speed(
                        agent_id,
                        speed.as_str(),
                        descriptor.output_speed_levels,
                    )?,
                }
            }
        }
    }
    let boundaries = &descriptor.switch_boundaries;
    let named_boundaries = [
        (target.model_id.is_some(), boundaries.model_id),
        (target.effort.is_some(), boundaries.effort),
        (target.output_speed.is_some(), boundaries.output_speed),
        (target.options.is_some(), boundaries.options),
        (target.larger_window.is_some(), boundaries.larger_window),
    ];
    let is_run_boundary = is_provider_moved
        || named_boundaries.iter().any(|&(is_named, boundary)| {
            is_named && boundary == AgentBindingSwitchBoundary::RunBoundary
        });
    Ok(if is_run_boundary {
        AgentBindingSwitchBoundary::RunBoundary
    } else {
        AgentBindingSwitchBoundary::TurnBoundary
    })
}

/// The options a switch lands: `current` with each setting of `moved` in place of the one for its
/// option, in order, then each option of `moved` that `current` does not set; `None` when the
/// result holds no setting.
pub fn moved_options(
    current: Option<&ProviderOptionSettings>,
    moved: &ProviderOptionSettings,
) -> Option<ProviderOptionSettings> {
    let current = current.map_or(&[][..], ProviderOptionSettings::as_slice);
    let moved = moved.as_slice();
    let mut settings: Vec<ProviderOptionSetting> = current
        .iter()
        .map(|setting| {
            moved
                .iter()
                .find(|moved| moved.id == setting.id)
                .unwrap_or(setting)
                .clone()
        })
        .collect();
    settings.extend(
        moved
            .iter()
            .filter(|setting| !current.iter().any(|kept| kept.id == setting.id))
            .cloned(),
    );
    ProviderOptionSettings::new(settings)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures::FutureExt;
    use rstest::rstest;
    use serde_json::Value;
    use sidekicks_contracts::agent::definition::binding::AgentProviderBinding;
    use sidekicks_contracts::agent::provider_binding::{
        AgentBindingSwitchBoundary, AgentBindingSwitchTarget,
    };
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::provider::account::record::ProviderAccountId;
    use sidekicks_contracts::provider::declaration::{
        ProviderDeclarationId, ProviderOptionSetting, ProviderOptionSettings, ProviderValue,
    };
    use sidekicks_contracts::provider::driver::capabilities::ProviderModel;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_contracts::wire::text::FreeFormText;
    use sidekicks_ipc::registry::HandlerError;

    use super::check_binding_switch;
    use crate::driver::PROVIDERS;
    use crate::driver::capabilities::{
        DriverCapabilities, DriverCapabilityFlag, DriverCapabilityFlags,
    };
    use crate::driver::contract::params_and_results::{LeadBindingCheckParams, ListModelsParams};
    use crate::driver::contract::{MockProviderDriver, ProviderDriver};
    use crate::driver::registry::test_token;
    use crate::driver::test_registry::{
        first_provider, fixed_session_id, new_agent_id, registry_of_first_providers,
    };

    fn row(model_id: &str, effort_levels: &[&str]) -> ProviderModel {
        ProviderModel {
            id: test_token(model_id),
            name: test_token(model_id),
            capabilities: Vec::new(),
            effort_levels: Some(
                effort_levels
                    .iter()
                    .map(|level| test_token(level))
                    .collect(),
            ),
            output_speed_levels: None,
            fast: false,
            larger_window: false,
            is_default: false,
            context_window: None,
        }
    }

    fn no_move() -> AgentBindingSwitchTarget {
        AgentBindingSwitchTarget {
            provider_name: None,
            model_id: None,
            provider_account_id: None,
            effort: None,
            output_speed: None,
            options: None,
            larger_window: None,
        }
    }

    fn account() -> ProviderAccountId {
        ProviderAccountId::new("account-1".to_owned()).expect("an account id")
    }

    // Each row is killed by dropping its check: the unregistered provider, the speed flag (whose
    // catalog read the mock refuses), the listed model's effort and speed, the larger window; by
    // refusing a model the catalog does not list, or its window; by taking the narrowest boundary
    // across a provider move; and by reading another provider's catalog against this session's
    // account.
    #[rstest]
    #[case::unregistered_provider(
        AgentBindingSwitchTarget {
            provider_name: Some(PROVIDERS[1].provider_id()),
            effort: Some(test_token("high")),
            ..no_move()
        },
        1, false, None,
        Err((RefusalCode::AgentProviderAxisInvalid, Some("providerName")))
    )]
    #[case::speed_without_the_flag(
        AgentBindingSwitchTarget { output_speed: Some(test_token("on")), ..no_move() },
        1, false, None,
        Err((RefusalCode::ProviderCapabilityUnsupported, None))
    )]
    #[case::effort_the_model_does_not_list(
        AgentBindingSwitchTarget { effort: Some(test_token("turbo")), ..no_move() },
        1, false, Some(vec![row("model-a", &["low", "high"])]),
        Err((RefusalCode::AgentProviderAxisInvalid, Some("effort")))
    )]
    #[case::speed_neither_row_nor_driver_lists(
        AgentBindingSwitchTarget { output_speed: Some(test_token("warp")), ..no_move() },
        1, true, Some(vec![row("model-a", &["high"])]),
        Err((RefusalCode::AgentProviderAxisInvalid, Some("outputSpeed")))
    )]
    #[case::larger_window_with_no_larger_row(
        AgentBindingSwitchTarget {
            larger_window: Some(Some(SafeInt::new(1_000_000).expect("a window"))),
            ..no_move()
        },
        1, false, Some(vec![row("model-a", &["high"])]),
        Err((RefusalCode::AgentProviderAxisInvalid, Some("largerWindow")))
    )]
    #[case::unlisted_model_with_any_effort_and_window(
        AgentBindingSwitchTarget {
            model_id: Some(test_token("model-new")),
            larger_window: Some(Some(SafeInt::new(1_000_000).expect("a window"))),
            effort: Some(test_token("anything")),
            ..no_move()
        },
        1, false, Some(vec![row("model-a", &["high"])]),
        Ok(AgentBindingSwitchBoundary::TurnBoundary)
    )]
    #[case::provider_move_with_an_effort(
        AgentBindingSwitchTarget {
            provider_name: Some(PROVIDERS[1].provider_id()),
            effort: Some(test_token("high")),
            ..no_move()
        },
        2, false, Some(vec![row("model-a", &["high"])]),
        Ok(AgentBindingSwitchBoundary::RunBoundary)
    )]
    #[case::effort_alone(
        AgentBindingSwitchTarget { effort: Some(test_token("high")), ..no_move() },
        1, false, Some(vec![row("model-a", &["high"])]),
        Ok(AgentBindingSwitchBoundary::TurnBoundary)
    )]
    #[tokio::test]
    async fn a_switch_is_checked_on_every_axis_it_names(
        #[case] target: AgentBindingSwitchTarget,
        #[case] registered: usize,
        #[case] has_output_speed: bool,
        #[case] catalog: Option<Vec<ProviderModel>>,
        #[case] expected: Result<AgentBindingSwitchBoundary, (RefusalCode, Option<&'static str>)>,
    ) {
        let session_id = fixed_session_id();
        let catalog_reader = PROVIDERS
            .iter()
            .position(|descriptor| target.provider_name == Some(descriptor.provider_id()))
            .unwrap_or(0);
        // A driver given no catalog has no `list_models` expectation, so a read fails the test.
        let drivers = (0..registered)
            .map(|index| {
                let mut driver = MockProviderDriver::new();
                if let Some(rows) = catalog.clone().filter(|_| index == catalog_reader) {
                    let read_against = if index == 0 {
                        ListModelsParams {
                            session_id: Some(session_id),
                            provider_account_id: Some(account()),
                        }
                    } else {
                        ListModelsParams {
                            session_id: None,
                            provider_account_id: None,
                        }
                    };
                    driver
                        .expect_list_models()
                        .withf(move |params| *params == read_against)
                        .times(1)
                        .returning(move |_| {
                            let rows = rows.clone();
                            async move { Ok(rows) }.boxed()
                        });
                }
                Arc::new(driver) as Arc<dyn ProviderDriver>
            })
            .collect();
        let providers = registry_of_first_providers(drivers);
        for descriptor in &PROVIDERS[..registered] {
            providers
                .record_capabilities(
                    &descriptor.provider_id(),
                    DriverCapabilities {
                        flags: DriverCapabilityFlags::from_fn(|flag| {
                            flag == DriverCapabilityFlag::OutputSpeed && has_output_speed
                        }),
                        contract_version: FreeFormText::new("1".to_owned()).expect("a version"),
                    },
                )
                .expect("the provider is registered");
        }
        let current = AgentProviderBinding {
            provider_name: first_provider(),
            model_id: test_token("model-a"),
            effort: None,
            output_speed: None,
            options: None,
            larger_window: None,
            provider_account_id: Some(account()),
        };

        let answered =
            check_binding_switch(&providers, new_agent_id(), session_id, &current, &target)
                .await
                .map_err(|error| {
                    let HandlerError::Refused(refusal) = HandlerError::from(error) else {
                        panic!("a switch check refuses, it never faults");
                    };
                    let axis = refusal
                        .detail
                        .as_deref()
                        .and_then(|detail| detail.get("axis"))
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    (refusal.code, axis)
                });

        assert_eq!(
            answered,
            expected.map_err(|(code, axis)| (code, axis.map(str::to_owned)))
        );
    }

    fn options(settings: &[(&str, bool)]) -> Option<ProviderOptionSettings> {
        ProviderOptionSettings::new(
            settings
                .iter()
                .map(|&(id, is_on)| ProviderOptionSetting {
                    id: ProviderDeclarationId::new(id.to_owned()).expect("the id fits"),
                    value: ProviderValue::Switch(is_on),
                })
                .collect(),
        )
    }

    // The driver checks the options the switch lands, the target's over the agent's own, never
    // the target's alone. Kills: checking the target's options alone.
    #[tokio::test]
    async fn a_switch_checks_the_options_it_lands() {
        let landed = options(&[("plan", false), ("sandbox", true)]);
        let mut driver = MockProviderDriver::new();
        driver
            .expect_check_lead_binding()
            .withf(move |params: &LeadBindingCheckParams| params.options == landed)
            .times(1)
            .returning(|_| Ok(()));
        let providers = registry_of_first_providers(vec![Arc::new(driver) as _]);
        let current = AgentProviderBinding {
            provider_name: first_provider(),
            model_id: test_token("model-a"),
            effort: None,
            output_speed: None,
            options: options(&[("plan", true)]),
            larger_window: None,
            provider_account_id: Some(account()),
        };
        let target = AgentBindingSwitchTarget {
            options: options(&[("sandbox", true), ("plan", false)]),
            ..no_move()
        };

        check_binding_switch(
            &providers,
            new_agent_id(),
            fixed_session_id(),
            &current,
            &target,
        )
        .await
        .expect("the landed options pass");
    }
}
