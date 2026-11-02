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
//!   gone; so does an account with a sign-in in flight, whose home the sign-in is using.
//! - A lead lands at the provider's acknowledgment of its move with `agent.providerBinding.changed`
//!   in place, or `agent.providerBinding.changeFailed` where the move failed; a first request the
//!   provider then refuses for the new account's login hands the previous account back, recorded
//!   by one `changeFailed`, which also records a hand-back that could not be made.
//! - The leads to move are read against each session's own binding, so a switch to the account
//!   already current still moves a session a failed move left on another; a session whose lead
//!   cannot be read is skipped and logged, and the rest move.
//! - A lead at a level the new account's model cannot run moves to the nearest more careful one
//!   through the level control's own move, with one `levelUnavailable` notice.
//! - At the daemon's start the same move reaches every session the last stop left on another
//!   account than its provider's current one, before the runs the stop left waiting are admitted;
//!   the start waits for the moves, never for a moved lead's first request.

use std::collections::HashMap;
use std::error::Error;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::{BoxFuture, join_all};
use sidekicks_contracts::agent::provider_binding::{
    AgentBindingContinuity, AgentBindingSwitchAccountState, AgentBindingSwitchFailureReason,
    AgentBindingSwitchTarget, AgentProviderBindingChangeFailedPayload,
    AgentProviderBindingChangedPayload, SwitchId,
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
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::account::readiness::derive_account_readiness;
use sidekicks_provider::account::registry::{ProviderAccountRegistry, RegisteredAccount};
use sidekicks_provider::account::sign_in::{AccountsSigningIn, ProviderSignInError};
use sidekicks_provider::driver::contract::account::{
    FirstRequestAfterMove, ProviderSwitchLegs, SessionAccountMove, SessionToMove,
};
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::contract::params_and_results::ListModesParams;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::{CurrentProviderAccount, ProviderAccountReader};
use sidekicks_queue::provider_session::ProviderSessions;
use sidekicks_session::permission_level::read_session_permission_level;
use sidekicks_session::run::agent::{SessionLead, read_provider_session_leads};
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};
use sidekicks_store::events::session::read::DamagedFromSequenceReader;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

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
    /// The accounts with a sign-in in flight, which no switch moves onto.
    pub(crate) signing_in: Arc<AccountsSigningIn>,
    /// Resolves an account's folders, refusing one whose home is gone, and each provider's current
    /// account.
    pub(crate) account_reader: Arc<dyn ProviderAccountReader>,
    /// Each provider's move of its sessions onto another account.
    pub(crate) switch_legs: HashMap<ProviderId, Arc<dyn ProviderSwitchLegs>>,
    /// The drivers, whose level list says what a model runs on an account.
    pub(crate) providers: Arc<ProviderRegistry>,
    /// The level control's own move.
    pub(crate) level_moves: Arc<dyn SessionLevelMoves>,
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

// One lead the switch moves: its session, the conversation that moves with it and the account that
// conversation runs on, and the level the session stands at.
struct LeadToMove {
    session_id: SessionId,
    lead: SessionLead,
    binding_id: RuntimeBindingId,
    from: ProviderAccountId,
    level: PermissionLevel,
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
    /// sign-in in flight, each with the mark unmoved and no session sent anything.
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
                Ok((plan, mark)) => {
                    let moving = plan.leads.iter().map(|lead| lead.session_id).collect();
                    let _unheard = answer.send(Ok((mark, moving)));
                    switch.carry_out(plan, actor, hold).await.await;
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
                let first_requests = self.carry_out(plan, actor.clone(), hold).await;
                // The watch settles on its own; the start goes on.
                drop(tokio::spawn(first_requests));
            }
            Ok::<_, Box<dyn Error + Send + Sync>>(())
        }))
        .await;
        followed.into_iter().collect()
    }

    // The refusals, then the mark moved and the leads to move read, all under the provider's lock.
    async fn begin(
        &self,
        provider: ProviderId,
        account_id: ProviderAccountId,
    ) -> Result<(SwitchPlan, MarkPlaced), HandlerError> {
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
        if self.deps.signing_in.is_signing_in(&account_id) {
            return Err(ProviderSignInError::InFlight.into());
        }
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
        Ok((plan, mark))
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
                            session_id: standing.session_id,
                            lead: standing.lead,
                            binding_id: conversation.id,
                            from,
                            level,
                        });
                    }
                    Ok(leads)
                },
            )
            .await?;
        Ok(leads)
    }

    // Moves every lead of `plan` onto its account, grouped by the account each leaves, settling
    // each at its acknowledgment, then frees the provider's lock and answers the watch of each
    // moved lead's first request on the new account, which ends once every one has settled.
    async fn carry_out(
        self: &Arc<Self>,
        plan: SwitchPlan,
        actor: DeviceId,
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
            return futures::future::ready(()).boxed();
        };
        let mut by_account: HashMap<ProviderAccountId, HashMap<SessionId, LeadToMove>> =
            HashMap::new();
        for lead in leads {
            by_account
                .entry(lead.from.clone())
                .or_default()
                .insert(lead.session_id, lead);
        }
        let mut first_requests = Vec::new();
        for (from, mut leads) in by_account {
            let sessions = leads
                .values()
                .map(|lead| SessionToMove {
                    session_id: lead.session_id,
                    binding_id: lead.binding_id.clone(),
                })
                .collect();
            for moved in legs.move_sessions(from, to.clone(), sessions).await {
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
                        self.land(&lead, &to, &actor).await;
                        first_requests.push(Arc::clone(self).watch_first_request(
                            lead,
                            to.clone(),
                            actor.clone(),
                            first_request,
                        ));
                    }
                    Err(error) => self.record_failed(&lead, &to, &actor, &error).await,
                }
            }
        }
        drop(hold);
        join_all(first_requests).map(drop).boxed()
    }

    // A lead whose move the provider acknowledged: its settlement, then its level moved where the
    // new account cannot run it.
    async fn land(&self, lead: &LeadToMove, to: &ProviderAccountId, actor: &DeviceId) {
        self.record_changed(lead, to, actor).await;
        self.move_level_where_unavailable(lead, to).await;
    }

    // Waits for a moved lead's first request on `to`: one the provider refused for the new
    // account's login was handed the previous account back, which one `changeFailed` records. A
    // hand-back that could not be made leaves the session on `to`, whose login is gone, so it is
    // the same failure to the person, and its cause is logged.
    fn watch_first_request(
        self: Arc<Self>,
        lead: LeadToMove,
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
    async fn move_level_where_unavailable(&self, lead: &LeadToMove, to: &ProviderAccountId) {
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
        self.append(
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

    async fn record_changed(&self, lead: &LeadToMove, to: &ProviderAccountId, actor: &DeviceId) {
        let from = lead.lead.binding.clone();
        let session_id = lead.session_id;
        self.append(
            session_id,
            &SessionEvent::AgentProviderBindingChanged(AgentProviderBindingChangedPayload {
                switch_id: mint_switch_id(),
                declared_losses: Vec::new(),
                continuity: AgentBindingContinuity::InPlace,
                session_id,
                agent_id: lead.lead.agent_id,
                actor: actor.clone(),
                // The lead still follows the current account: only where it landed moved.
                to: from.clone(),
                from,
                landed_provider_account_id: to.clone(),
            }),
        )
        .await;
    }

    async fn record_failed(
        &self,
        lead: &LeadToMove,
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
        lead: &LeadToMove,
        to: &ProviderAccountId,
        actor: &DeviceId,
        account_state: AgentBindingSwitchAccountState,
    ) {
        let session_id = lead.session_id;
        self.append(
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

    // Appends `event` to `session_id`'s log; a failure is logged, since the switch has no caller
    // left to answer by then.
    async fn append(&self, session_id: SessionId, event: &SessionEvent) {
        let appended = match SessionEventDraft::of_session(session_id, event) {
            Ok(draft) => self
                .deps
                .appender
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
                "an account switch's settlement was not appended"
            );
        }
    }
}

// Why the leads could not be read.
#[derive(Debug, thiserror::Error)]
enum SessionLeadsReadError {
    #[error("no connection could read the sessions")]
    Read(#[from] DatabaseReadError),
    #[error("the sessions could not be read")]
    Query(#[from] rusqlite::Error),
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

fn mint_switch_id() -> SwitchId {
    SwitchId::new(mint_uuid_v7().to_string()).expect("a minted UUID is a switch id")
}

// The state a failed move's refusal names of the account: a gone sign-in, a gone home, an account
// not registered, and anything else not decided.
fn account_state_of(error: &DriverError) -> AgentBindingSwitchAccountState {
    let code = match error {
        DriverError::Refused(refusal) => Some(refusal.code),
        DriverError::Unanswered(_)
        | DriverError::SteerTurnEnded(_)
        | DriverError::RunRefused(_)
        | DriverError::CapabilityProbe(_)
        | DriverError::ExecutableUnresolvable(_)
        | DriverError::ModelCatalogUnreadable(_)
        | DriverError::ProviderAxisInvalid(_)
        | DriverError::RuleNotKept(_)
        | DriverError::SkillNotListed(_)
        | DriverError::Internal(_) => None,
    };
    match code {
        Some(RefusalCode::ProviderAccountNotAuthenticated) => {
            AgentBindingSwitchAccountState::ReauthRequired
        }
        Some(RefusalCode::ProviderAccountCredentialHomeUnavailable) => {
            AgentBindingSwitchAccountState::HomeMissing
        }
        Some(RefusalCode::ProviderAccountNotFound) => AgentBindingSwitchAccountState::NotRegistered,
        _ => AgentBindingSwitchAccountState::Indeterminate,
    }
}

#[cfg(test)]
mod tests;
