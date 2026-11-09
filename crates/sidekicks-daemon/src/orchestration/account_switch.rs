//! The move of a provider's running sessions onto the account made its current one: the refusals
//! that keep the mark where it is, the mark moved, then each session whose lead follows the current
//! account and whose conversation runs on another moved by the provider's own switch legs. A
//! session pinned to an account, or one that has not run, is left: its next run opens on the
//! account it names or on the current one.
//!
//! - Everything a switch does runs under its provider's lock, from the refusals until every move
//!   has landed, so a second switch on that provider waits for the first.
//! - A dead target refuses before the mark moves or any session is sent anything: an account not
//!   registered or being removed, a home that is gone, or a sign-in its stored reading says is
//!   gone; so does an account with a sign-in or a reset in flight, whose home it is using. The
//!   switch puts the account in flight in the same step that finds it free and holds it there until
//!   every move has landed, letting it go with the provider's lock, so no sign-in or reset starts
//!   in the home meanwhile and a second switch onto it, waiting on that lock, finds it free.
//! - A lead lands at the provider's acknowledgment of its move with `agent.providerBinding.changed`
//!   in place, each binding a live or interrupted helper or bridged run of its session rides moved
//!   onto the same account first, so no helper spends the account the lead left; or with
//!   `agent.providerBinding.changeFailed` where the move failed; a first request the provider then
//!   refuses for the new account's login hands the previous account back, recorded by one
//!   `changeFailed`, which also records a hand-back that could not be made.
//! - The leads to move are read against each session's own binding, so a switch to the account
//!   already current still moves a session a failed move left on another; a session whose lead
//!   cannot be read is skipped and logged, and the rest move.
//! - A lead at a level the new account's model cannot run moves to the nearest more careful one
//!   through the level control's own move, with one `levelUnavailable` notice.
//! - At the daemon's start the same move reaches every session the last stop left on another
//!   account than its provider's current one, before the runs the stop left waiting are admitted;
//!   the start waits for the moves, never for a moved lead's first request.
//! - A session a driver moves with no switch waiting on the move, as one attached to a service
//!   that changes account outside a switch or one a switch did not name, lands through
//!   [`SessionAccountMoveRecord`] as a switch's lead lands: the same `changed`, by the person whose
//!   switch moved it or else this machine's own device, the level move and the first request's
//!   hand-back. The record only reads the session's lead and level and lands it on a task of its
//!   own, so a driver may report from inside its own session's task or its service's start.

use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, Weak};

use futures::FutureExt as _;
use futures::future::{BoxFuture, join_all};
use sidekicks_contracts::agent::provider_binding::{
    AgentBindingContinuity, AgentBindingSwitchAccountState, AgentBindingSwitchFailureReason,
    AgentBindingSwitchTarget, AgentProviderBindingChangeFailedPayload,
    AgentProviderBindingChangedPayload,
};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::methods::ProviderAccountNotAuthenticatedDetails;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::account::record::readiness::ProviderReadiness;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::controls::events::{SessionNotice, SessionNoticePostedPayload};
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::account::readiness::derive_account_readiness;
use sidekicks_provider::account::registry::{ProviderAccountRegistry, RegisteredAccount};
use sidekicks_provider::account::sign_in::{AccountsInFlight, InFlightGuard, ProviderSignInError};
use sidekicks_provider::driver::contract::account::{
    FirstRequestAfterMove, ProviderSwitchLegs, SessionAccountMove, SessionToMove,
};
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::contract::params_and_results::ListModesParams;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::{CurrentProviderAccount, ProviderAccountReader};
use sidekicks_provider::port::session_account_move::SessionAccountMoveRecorder;
use sidekicks_provider::runtime_binding::writer::RuntimeBindingWriter;
use sidekicks_queue::provider_session::ProviderSessions;
use sidekicks_session::agent_tree::read::AgentTreeReadError;
use sidekicks_session::permission_level::read_session_permission_level;
use sidekicks_session::run::agent::{SessionLead, read_provider_session_leads, read_session_lead};
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};
use sidekicks_store::events::session::read::{DamagedFromSequenceReader, session_read_bound};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::orchestration::binding_switch::{account_state_of, mint_switch_id};

/// The level control's own move of a session's level, which a switch takes a lead through when its
/// new account cannot run the level it stands at.
pub(crate) trait SessionLevelMoves: Send + Sync {
    /// Moves `session_id` to `level` as the level control does: its process, its record and the
    /// notice every client reads the level from. Fails as that move fails, nothing changed.
    fn change_level(
        &self,
        session_id: SessionId,
        level: PermissionLevel,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;
}

impl SessionLevelMoves for ProviderSessions {
    fn change_level(
        &self,
        session_id: SessionId,
        level: PermissionLevel,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            ProviderSessions::change_level(self, session_id, level)
                .await
                .map_err(Into::into)
        }
        .boxed()
    }
}

/// What the switch acts through.
pub(crate) struct AccountSwitchDeps {
    /// The accounts, whose current mark the switch moves.
    pub(crate) accounts: Arc<ProviderAccountRegistry>,
    /// The accounts with a sign-in or a reset in flight, which no switch moves onto, and where a
    /// switch holds its account in flight until its moves land.
    pub(crate) accounts_in_flight: Arc<AccountsInFlight>,
    /// Resolves an account's folders, refusing one whose home is gone, and each provider's current
    /// account.
    pub(crate) account_reader: Arc<dyn ProviderAccountReader>,
    /// Each provider's move of its sessions onto another account.
    pub(crate) switch_legs: HashMap<ProviderId, Arc<dyn ProviderSwitchLegs>>,
    /// The drivers, whose level list says what a model runs on an account.
    pub(crate) providers: Arc<ProviderRegistry>,
    /// The level control's own move.
    pub(crate) level_moves: Arc<dyn SessionLevelMoves>,
    /// The binding writer, which moves the bindings a moved lead's helpers ride.
    pub(crate) bindings: Arc<dyn RuntimeBindingWriter>,
    /// Where each settlement and notice is appended.
    pub(crate) appender: Arc<SessionEventAppender>,
    /// The daemon's read connections.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The last good point of each session whose history is damaged.
    pub(crate) read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
}

/// The current-account switch, one for the daemon; see the module doc.
pub(crate) struct AccountSwitch {
    deps: AccountSwitchDeps,
    locks: KeyedLock<ProviderId>,
}

/// A switch that made its account current: the account as it now reads, whether the mark moved
/// onto it, the one whose mark moved off it, the sessions being moved, and the work that moves
/// them.
pub(crate) struct CurrentAccountMade {
    /// The account now current.
    pub(crate) account: RegisteredAccount,
    /// Whether the mark moved onto the account; `false` where it already stood there.
    pub(crate) is_mark_moved: bool,
    /// The account that was current before, as it now reads; `None` where none was or the account
    /// already was.
    pub(crate) left: Option<RegisteredAccount>,
    /// The sessions being moved onto the account.
    pub(crate) moving_sessions: Vec<SessionId>,
    /// Ends once every move has landed and each moved lead's first request on the account has
    /// been answered or is no longer to come.
    pub(crate) settled: JoinHandle<()>,
}

// One lead whose move lands: its session, the lead, and the level the session stands at.
struct LandingLead {
    session_id: SessionId,
    lead: SessionLead,
    level: PermissionLevel,
}

// One lead the switch moves: the lead as it lands, the conversation that moves with it and the
// account that conversation runs on.
struct LeadToMove {
    landing: LandingLead,
    binding_id: RuntimeBindingId,
    from: ProviderAccountId,
}

// What a switch moves once the mark stands on `to`.
struct SwitchPlan {
    provider: ProviderId,
    to: ProviderAccountId,
    leads: Vec<LeadToMove>,
}

// Where the switch's refusals left the mark: the account now current, whether the mark moved onto
// it, and the account it moved off, as it now reads.
struct MarkPlaced {
    account: RegisteredAccount,
    is_moved: bool,
    left: Option<RegisteredAccount>,
}

// The switch's answer to its caller, sent before the moves land.
type SwitchAnswer = Result<(MarkPlaced, Vec<SessionId>), HandlerError>;

impl AccountSwitch {
    /// The switch over `deps`.
    pub(crate) fn new(deps: AccountSwitchDeps) -> Self {
        Self {
            deps,
            locks: KeyedLock::new(),
        }
    }

    /// Makes `account_id` its provider's current account for `actor`, then moves every running
    /// session of that provider not already on it. Answers once the mark has moved; the moves land
    /// after, under the provider's lock. Refused `provider.account.notFound` for an account not
    /// registered or being removed, `provider.account.credentialHome.unavailable` for a home that
    /// is gone, `provider.account.notAuthenticated` with the account's remedy for a sign-in its
    /// stored reading says is gone and `provider.account.signInInFlight` for an account with a
    /// sign-in or a reset in flight, each with the mark unmoved and no session sent anything.
    pub(crate) async fn make_current(
        self: &Arc<Self>,
        account_id: ProviderAccountId,
        actor: DeviceId,
    ) -> Result<CurrentAccountMade, HandlerError> {
        let provider = self.deps.accounts.read(account_id.clone()).await?.provider;
        let (answer, answered) = oneshot::channel::<SwitchAnswer>();
        let switch = Arc::clone(self);
        // A switch once begun lands whole, whether or not its caller still waits.
        let settled = tokio::spawn(async move {
            let hold = switch.locks.acquire(provider.clone()).await;
            match switch.begin(provider, account_id).await {
                Err(refusal) => {
                    let _unheard = answer.send(Err(refusal));
                }
                Ok((plan, mark, in_flight_guard)) => {
                    let moving = plan
                        .leads
                        .iter()
                        .map(|lead| lead.landing.session_id)
                        .collect();
                    let _unheard = answer.send(Ok((mark, moving)));
                    let first_requests = switch
                        .carry_out(plan, actor, Some(in_flight_guard), hold)
                        .await;
                    first_requests.await;
                }
            }
        });
        let (mark, moving_sessions) = answered
            .await
            .map_err(|_ended| HandlerError::Internal(Box::new(SwitchEnded)))??;
        Ok(CurrentAccountMade {
            account: mark.account,
            is_mark_moved: mark.is_moved,
            left: mark.left,
            moving_sessions,
            settled,
        })
    }

    /// Moves every session the last stop left on another account than its provider's current one
    /// onto that account, provider by provider under each one's lock, settled for `actor`, this
    /// machine's own device; answers once every move has landed, each moved lead's first request
    /// watched on its own task, since an idle session's may come only when the person next writes.
    /// Fails as a provider's current account or its list of sessions cannot be read, every
    /// provider tried.
    pub(crate) async fn follow_current_accounts(
        self: &Arc<Self>,
        actor: &DeviceId,
    ) -> Result<(), Box<dyn Error + Send + Sync>> {
        let followed = join_all(self.deps.switch_legs.keys().map(|provider| async move {
            let hold = self.locks.acquire(provider.clone()).await;
            if let Some(plan) = self.plan_follow(provider.clone()).await? {
                let first_requests = self.carry_out(plan, actor.clone(), None, hold).await;
                // The watch settles on its own; the start goes on.
                drop(tokio::spawn(first_requests));
            }
            Ok::<_, Box<dyn Error + Send + Sync>>(())
        }))
        .await;
        followed.into_iter().collect()
    }

    // The refusals, then the mark moved and the leads to move read, all under the provider's lock;
    // answers the account's in-flight guard too, which keeps a sign-in or a reset out of its home.
    async fn begin(
        &self,
        provider: ProviderId,
        account_id: ProviderAccountId,
    ) -> Result<(SwitchPlan, MarkPlaced, InFlightGuard), HandlerError> {
        let account = self.deps.accounts.read(account_id.clone()).await?;
        self.deps
            .account_reader
            .resolve_account_folders(account_id.clone())
            .await
            .map_err(DriverError::from)?;
        if let ProviderReadiness::ReauthRequired { remedy, .. } = derive_account_readiness(&account)
        {
            return Err(DomainError::new(
                "The provider account's sign-in is gone",
                RefusalCode::ProviderAccountNotAuthenticated,
            )
            .with_detail(ProviderAccountNotAuthenticatedDetails { remedy })
            .into());
        }
        let in_flight_guard = self
            .deps
            .accounts_in_flight
            .begin(account_id.clone())
            .ok_or(ProviderSignInError::InFlight)?;
        // An account already current keeps the mark, and its sessions still on another move.
        let is_moved = !account.is_default;
        let (account, left) = if account.is_default {
            (account, None)
        } else {
            let left = self
                .deps
                .accounts
                .list(Some(provider.clone()))
                .await?
                .into_iter()
                .find(|other| other.is_default)
                .map(|other| RegisteredAccount {
                    is_default: false,
                    ..other
                });
            let account = self.deps.accounts.make_current(account_id.clone()).await?;
            (account, left)
        };
        let leads = self
            .read_leads_off(provider.clone(), account_id.clone())
            .await
            .map_err(HandlerError::Internal)?;
        let plan = SwitchPlan {
            provider,
            to: account_id,
            leads,
        };
        let mark = MarkPlaced {
            account,
            is_moved,
            left,
        };
        Ok((plan, mark, in_flight_guard))
    }

    // The leads to move onto `provider`'s current account at the start, `None` where it has none.
    async fn plan_follow(
        &self,
        provider: ProviderId,
    ) -> Result<Option<SwitchPlan>, Box<dyn Error + Send + Sync>> {
        let CurrentProviderAccount::Current(to) = self
            .deps
            .account_reader
            .current_account(provider.clone())
            .await?
        else {
            return Ok(None);
        };
        let leads = self.read_leads_off(provider.clone(), to.clone()).await?;
        Ok(Some(SwitchPlan {
            provider,
            to,
            leads,
        }))
    }

    // The leads on `provider` that follow its current account and whose conversation runs on an
    // account other than `to`, each with its level; a session whose lead or level cannot be read is
    // logged and left where it is.
    async fn read_leads_off(
        &self,
        provider: ProviderId,
        to: ProviderAccountId,
    ) -> Result<Vec<LeadToMove>, Box<dyn Error + Send + Sync>> {
        let damaged_from = Arc::clone(&self.deps.read_damaged_from_sequence);
        let leads = self
            .deps
            .reads
            .read(
                ReadLength::Short,
                move |reader| -> Result<_, SessionLeadsReadError> {
                    let mut leads = Vec::new();
                    for standing in read_provider_session_leads(reader, &provider, &*damaged_from)?
                    {
                        let standing = match standing {
                            Ok(standing) => standing,
                            Err(unreadable) => {
                                skip_unreadable(unreadable.session_id, &unreadable);
                                continue;
                            }
                        };
                        let Some(conversation) = standing.conversation else {
                            continue;
                        };
                        let from = conversation.spawn_config.provider_account_id;
                        if from == to {
                            continue;
                        }
                        let level =
                            match read_session_permission_level(reader, &standing.session_id) {
                                Ok(level) => level,
                                Err(error) => {
                                    skip_unreadable(standing.session_id, &error);
                                    continue;
                                }
                            };
                        leads.push(LeadToMove {
                            landing: LandingLead {
                                session_id: standing.session_id,
                                lead: standing.lead,
                                level,
                            },
                            binding_id: conversation.id,
                            from,
                        });
                    }
                    Ok(leads)
                },
            )
            .await?;
        Ok(leads)
    }

    // Moves every lead of `plan` onto its account, grouped by the account each leaves, settling
    // each at its acknowledgment, then lets the target's `in_flight_guard` go and frees the
    // provider's lock, in that order, and answers the watch of each moved lead's first request on
    // the new account, which ends once every one has settled.
    async fn carry_out(
        self: &Arc<Self>,
        plan: SwitchPlan,
        actor: DeviceId,
        in_flight_guard: Option<InFlightGuard>,
        hold: KeyHold<'_, ProviderId>,
    ) -> BoxFuture<'static, ()> {
        let SwitchPlan {
            provider,
            to,
            leads,
        } = plan;
        let Some(legs) = self.deps.switch_legs.get(&provider) else {
            if !leads.is_empty() {
                tracing::warn!(
                    provider = provider.as_str(),
                    "the provider moves no session between accounts, so its sessions stay"
                );
            }
            drop(in_flight_guard);
            drop(hold);
            return futures::future::ready(()).boxed();
        };
        let mut by_account: HashMap<ProviderAccountId, HashMap<SessionId, LeadToMove>> =
            HashMap::new();
        for lead in leads {
            by_account
                .entry(lead.from.clone())
                .or_default()
                .insert(lead.landing.session_id, lead);
        }
        let mut first_requests = Vec::new();
        for (from, mut leads) in by_account {
            let sessions = leads
                .values()
                .map(|lead| SessionToMove {
                    session_id: lead.landing.session_id,
                    binding_id: lead.binding_id.clone(),
                })
                .collect();
            for moved in legs
                .move_sessions(from, to.clone(), sessions, actor.clone())
                .await
            {
                let (session_id, landing) = match moved {
                    Ok(SessionAccountMove {
                        session_id,
                        first_request,
                    }) => (session_id, Ok(first_request)),
                    Err((session_id, error)) => (session_id, Err(error)),
                };
                let Some(lead) = leads.remove(&session_id) else {
                    continue;
                };
                match landing {
                    Ok(first_request) => {
                        let watch = self
                            .land(lead.landing, to.clone(), actor.clone(), first_request)
                            .await;
                        first_requests.push(watch);
                    }
                    Err(error) => {
                        self.record_failed(&lead.landing, &to, &actor, &error).await;
                    }
                }
            }
        }
        // Let go before the lock, so a second switch onto the account waiting on it finds the
        // account free.
        drop(in_flight_guard);
        drop(hold);
        join_all(first_requests).map(drop).boxed()
    }

    // A lead whose move landed on `to`, a switch's or one a driver reported: the bindings its
    // helpers ride moved onto `to`, its settlement by `actor`, then its level moved where `to`
    // cannot run it; answers the watch of its first request there, which records a hand-back.
    async fn land(
        self: &Arc<Self>,
        lead: LandingLead,
        to: ProviderAccountId,
        actor: DeviceId,
        first_request: BoxFuture<'static, Result<FirstRequestAfterMove, DriverError>>,
    ) -> BoxFuture<'static, ()> {
        self.move_child_bindings(&lead, &to).await;
        self.record_changed(&lead, &to, &actor).await;
        self.move_level_where_unavailable(&lead, &to).await;
        Arc::clone(self).watch_first_request(lead, to, actor, first_request)
    }

    // Waits for a moved lead's first request on `to`: one the provider refused for the new
    // account's login was handed the previous account back, which one `changeFailed` records. A
    // hand-back that could not be made leaves the session on `to`, whose login is gone, so it is
    // the same failure to the person, and its cause is logged.
    fn watch_first_request(
        self: Arc<Self>,
        lead: LandingLead,
        to: ProviderAccountId,
        actor: DeviceId,
        first_request: BoxFuture<'static, Result<FirstRequestAfterMove, DriverError>>,
    ) -> BoxFuture<'static, ()> {
        async move {
            match first_request.await {
                Ok(FirstRequestAfterMove::Ran | FirstRequestAfterMove::Unobserved) => return,
                Ok(FirstRequestAfterMove::HandedBack) => {}
                Err(error) => tracing::warn!(
                    session_id = %lead.session_id,
                    error = &error as &(dyn Error + 'static),
                    "a refused login after an account switch could not be handed back"
                ),
            }
            self.record_failed_with(
                &lead,
                &to,
                &actor,
                AgentBindingSwitchAccountState::ReauthRequired,
            )
            .await;
        }
        .boxed()
    }

    // Moves a lead at `reviewed` to `ask` where its model lists no `reviewed` on `to`, then posts
    // the notice naming the level it left.
    async fn move_level_where_unavailable(&self, lead: &LandingLead, to: &ProviderAccountId) {
        if lead.level != PermissionLevel::Reviewed {
            return;
        }
        let session_id = lead.session_id;
        let binding = &lead.lead.binding;
        let Ok(driver) = self.deps.providers.lookup(&binding.provider_name) else {
            return;
        };
        // No session is named, so the list is read on `to` rather than the process's own catalog.
        let modes = match driver
            .list_modes(ListModesParams {
                session_id: None,
                provider_account_id: Some(to.clone()),
                model: Some(lead.lead.running_model.clone()),
            })
            .await
        {
            Ok(modes) => modes,
            Err(error) => {
                tracing::warn!(
                    %session_id,
                    error = &error as &(dyn Error + 'static),
                    "the levels of a switched session's new account could not be read"
                );
                return;
            }
        };
        let reviewed = <&'static str>::from(PermissionLevel::Reviewed);
        if modes.iter().any(|mode| mode.id.as_str() == reviewed) {
            return;
        }
        if let Err(error) = self
            .deps
            .level_moves
            .change_level(session_id, PermissionLevel::Ask)
            .await
        {
            tracing::warn!(
                %session_id,
                error = &*error as &(dyn Error + 'static),
                "a switched session's level its new account cannot run was not moved"
            );
            return;
        }
        append_settlement(
            &self.deps.appender,
            session_id,
            &SessionEvent::SessionNoticePosted(SessionNoticePostedPayload::Notice(
                SessionNotice::LevelUnavailable {
                    session_id,
                    level: PermissionLevel::Reviewed,
                },
            )),
        )
        .await;
    }

    async fn record_changed(&self, lead: &LandingLead, to: &ProviderAccountId, actor: &DeviceId) {
        append_settlement(
            &self.deps.appender,
            lead.session_id,
            &binding_changed(lead.session_id, &lead.lead, to, actor),
        )
        .await;
    }

    async fn record_failed(
        &self,
        lead: &LandingLead,
        to: &ProviderAccountId,
        actor: &DeviceId,
        error: &DriverError,
    ) {
        tracing::warn!(
            session_id = %lead.session_id,
            error = error as &(dyn Error + 'static),
            "a session was not moved onto the account made current"
        );
        self.record_failed_with(lead, to, actor, account_state_of(error))
            .await;
    }

    async fn record_failed_with(
        &self,
        lead: &LandingLead,
        to: &ProviderAccountId,
        actor: &DeviceId,
        account_state: AgentBindingSwitchAccountState,
    ) {
        let session_id = lead.session_id;
        append_settlement(
            &self.deps.appender,
            session_id,
            &SessionEvent::AgentProviderBindingChangeFailed(
                AgentProviderBindingChangeFailedPayload {
                    switch_id: mint_switch_id(),
                    reason: AgentBindingSwitchFailureReason::AccountUnavailable,
                    account_state: Some(account_state),
                    session_id,
                    agent_id: lead.lead.agent_id,
                    actor: actor.clone(),
                    from: lead.lead.binding.clone(),
                    // An account move sets only the account.
                    attempted: AgentBindingSwitchTarget {
                        provider_name: None,
                        model_id: None,
                        provider_account_id: Some(to.clone()),
                        effort: None,
                        output_speed: None,
                        options: None,
                        larger_window: None,
                    },
                },
            ),
        )
        .await;
    }
}

/// The record of each session a driver moved onto another account with no switch waiting on the
/// move: it lands as a switch's lead lands, through the switch's own landing. It holds the switch
/// weakly, since the switch holds the provider registry whose drivers hold this record, so a strong
/// hold would keep them all alive for good.
pub(crate) struct SessionAccountMoveRecord {
    switch: Weak<AccountSwitch>,
    machine_device_id: DeviceId,
}

impl SessionAccountMoveRecord {
    /// The record landing each move through `switch` while it lives, by `machine_device_id` where
    /// no person's switch moved the session.
    pub(crate) fn new(switch: &Arc<AccountSwitch>, machine_device_id: DeviceId) -> Self {
        Self {
            switch: Arc::downgrade(switch),
            machine_device_id,
        }
    }

    /// Reads `moved`'s session's lead and level, then lands it on `to` on a task of its own, by
    /// `actor` or else this machine's own device, answering that task; `None`, logged, where the
    /// switch is gone, as while the daemon stops, the lead or level cannot be read or the log
    /// names no lead.
    pub(crate) async fn land(
        &self,
        moved: SessionAccountMove,
        to: ProviderAccountId,
        actor: Option<DeviceId>,
    ) -> Option<JoinHandle<()>> {
        let session_id = moved.session_id;
        let Some(switch) = self.switch.upgrade() else {
            tracing::warn!(
                %session_id,
                "the switch is gone, so a session moved onto another account goes unrecorded"
            );
            return None;
        };
        let damaged_from = Arc::clone(&switch.deps.read_damaged_from_sequence);
        let read = switch
            .deps
            .reads
            .read(
                ReadLength::Short,
                move |reader| -> Result<_, SessionLeadsReadError> {
                    let read_bound = session_read_bound(&*damaged_from, &session_id, None);
                    let Some(lead) = read_session_lead(reader, &session_id, read_bound)? else {
                        return Ok(None);
                    };
                    let level = read_session_permission_level(reader, &session_id)?;
                    Ok(Some(LandingLead {
                        session_id,
                        lead,
                        level,
                    }))
                },
            )
            .await;
        let lead = match read {
            Ok(Some(lead)) => lead,
            Ok(None) => {
                tracing::warn!(
                    %session_id,
                    "a session moved onto another account names no lead, so nothing records it"
                );
                return None;
            }
            Err(error) => {
                skip_unreadable(session_id, &error);
                return None;
            }
        };
        let actor = actor.unwrap_or_else(|| self.machine_device_id.clone());
        Some(tokio::spawn(async move {
            let watch = switch.land(lead, to, actor, moved.first_request).await;
            watch.await;
        }))
    }
}

impl SessionAccountMoveRecorder for SessionAccountMoveRecord {
    /// Lands the move as [`SessionAccountMoveRecord::land`] does, its task left to run.
    fn record_account_moved(
        &self,
        moved: SessionAccountMove,
        provider_account_id: ProviderAccountId,
        actor: Option<DeviceId>,
    ) -> BoxFuture<'_, ()> {
        async move {
            drop(self.land(moved, provider_account_id, actor).await);
        }
        .boxed()
    }
}

// `agent.providerBinding.changed` for `session_id`'s `lead`, landed on `to` in place, by `actor`.
fn binding_changed(
    session_id: SessionId,
    lead: &SessionLead,
    to: &ProviderAccountId,
    actor: &DeviceId,
) -> SessionEvent {
    let from = lead.binding.clone();
    SessionEvent::AgentProviderBindingChanged(AgentProviderBindingChangedPayload {
        switch_id: mint_switch_id(),
        declared_losses: Vec::new(),
        continuity: AgentBindingContinuity::InPlace,
        session_id,
        agent_id: lead.agent_id,
        actor: actor.clone(),
        // The lead still follows the current account: only where it landed moved.
        to: from.clone(),
        from,
        landed_provider_account_id: to.clone(),
    })
}

// Appends `event` to `session_id`'s log through `appender`; a failure is logged, since no caller is
// left to answer by then.
async fn append_settlement(
    appender: &SessionEventAppender,
    session_id: SessionId,
    event: &SessionEvent,
) {
    let appended = match SessionEventDraft::of_session(session_id, event) {
        Ok(draft) => appender
            .append(draft, SessionEventLinkage::default())
            .await
            .map(|_receipt| ())
            .map_err(|error| Box::new(error) as Box<dyn Error + Send + Sync>),
        Err(error) => Err(Box::new(error) as Box<dyn Error + Send + Sync>),
    };
    if let Err(error) = appended {
        tracing::warn!(
            %session_id,
            error = &*error as &(dyn Error + 'static),
            "an account move's settlement was not appended"
        );
    }
}

// Why the leads, or the bindings a lead's helpers ride, could not be read.
#[derive(Debug, thiserror::Error)]
enum SessionLeadsReadError {
    #[error("no connection could read the sessions")]
    Read(#[from] DatabaseReadError),
    #[error("the sessions could not be read")]
    Query(#[from] rusqlite::Error),
    #[error("the session's agent tree could not be read")]
    Tree(#[from] AgentTreeReadError),
}

// Logs a session the switch skips because `error` kept its lead or level from reading.
fn skip_unreadable(session_id: SessionId, error: &(dyn Error + 'static)) {
    tracing::warn!(
        %session_id,
        error,
        "a session whose lead could not be read was left on its account"
    );
}

// The switch's own task ended before it answered.
#[derive(Debug, thiserror::Error)]
#[error("the account switch ended before it answered")]
struct SwitchEnded;

mod helper_bindings;

#[cfg(test)]
mod tests;
