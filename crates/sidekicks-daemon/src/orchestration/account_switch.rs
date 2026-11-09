//! The move of a provider's running sessions onto the account made its current one: the refusals
//! that keep the mark where it is, the mark moved, then each session whose lead follows the current
//! account and whose conversation runs on another moved by the provider's own switch legs. A
//! session pinned to an account, or one that has not run, is left: its next run opens on the
//! account it names or on the current one.
//!
//! - A switch runs under its provider's lock from the refusals until the driver has every move
//!   landed or waiting for a turn to end, so a second switch on that provider waits until then;
//!   one asked while the first's moves wait joins them in the driver, which lands the newest. It
//!   decides whether a session whose move waits moves by the account that move heads for, so a
//!   switch back onto the account the session still runs on names it too, and names the account
//!   its binding stands on as the one it leaves, which a refused login hands back.
//! - A dead target refuses before the mark moves or any session is sent anything: an account not
//!   registered or being removed, a home that is gone, or a sign-in its stored reading says is
//!   gone; so does an account with a sign-in or a reset in flight, whose home it is using. The
//!   switch puts the account in flight in the same step that finds it free and holds it there until
//!   every move has landed, so no sign-in or reset starts in the home meanwhile; a second switch
//!   onto the same account shares that hold.
//! - A lead lands between its turns, when its process starts on the new account on Claude Code and
//!   when the held login lands on Codex, with one `agent.providerBinding.changed` onto the account
//!   the driver says it landed on, the driver's move of the lead's binding carrying each binding a
//!   live or interrupted helper or bridged run of its session rides in the same write, so no helper
//!   spends the account the lead left; or with `agent.providerBinding.changeFailed` where the move
//!   failed. A move a newer switch replaced records nothing, since that switch records the landing.
//!   A first request the provider then refuses for the new account's login hands the previous
//!   account back, recorded by one `changeFailed`, which also records a hand-back that could not
//!   be made.
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
use std::sync::{Arc, Mutex, Weak};

use futures::FutureExt as _;
use futures::future::{BoxFuture, join_all};
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
    ProviderSwitchLegs, SessionAccountMove, SessionAccountMoveOutcome, SessionToMove,
};
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::contract::params_and_results::ListModesParams;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::{CurrentProviderAccount, ProviderAccountReader};
use sidekicks_provider::port::session_account_move::SessionAccountMoveRecorder;
use sidekicks_queue::provider_session::ProviderSessions;
use sidekicks_session::permission_level::read_session_permission_level;
use sidekicks_session::run::agent::{SessionLead, read_provider_session_leads, read_session_lead};
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::session::appender::SessionEventAppender;
use sidekicks_store::events::session::read::{DamagedFromSequenceReader, session_read_bound};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use self::landing::append_settlement;

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
    // The in-flight hold of each account a switch moves onto, shared by every switch onto it
    // until the last one's moves land.
    in_flight_holds: Mutex<HashMap<ProviderAccountId, Weak<InFlightGuard>>>,
    // Each session whose move a switch handed its driver and has not seen settle, with the account
    // it moves to, so a later switch decides by where the session is heading rather than where its
    // lead's binding still stands.
    held_moves: Mutex<HeldMoves>,
}

// The moves handed to the drivers and not yet settled, each under the number of the switch that
// handed it, so a switch forgets only its own once they settle.
#[derive(Default)]
struct HeldMoves {
    next_switch: u64,
    targets: HashMap<SessionId, (u64, ProviderAccountId)>,
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
// account that conversation's binding stands on, which the driver hands back after a refused
// login.
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
            in_flight_holds: Mutex::default(),
            held_moves: Mutex::default(),
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
    ) -> Result<(SwitchPlan, MarkPlaced, Arc<InFlightGuard>), HandlerError> {
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
        let in_flight_guard = self.hold_in_flight(&account_id)?;
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

    // The leads on `provider` that follow its current account and whose conversation runs, or
    // is being moved by a switch held in its driver, on an account other than `to`, each with its
    // level and the account its binding stands on; a session whose lead or level cannot be read is
    // logged and left where it is.
    async fn read_leads_off(
        &self,
        provider: ProviderId,
        to: ProviderAccountId,
    ) -> Result<Vec<LeadToMove>, Box<dyn Error + Send + Sync>> {
        let damaged_from = Arc::clone(&self.deps.read_damaged_from_sequence);
        let heading: HashMap<SessionId, ProviderAccountId> = lock(&self.held_moves)
            .targets
            .iter()
            .map(|(session_id, (_switch, target))| (*session_id, target.clone()))
            .collect();
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
                        if heading.get(&standing.session_id).unwrap_or(&from) == &to {
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

    // Puts `account_id` in flight for a switch onto it, sharing the hold of a switch onto it
    // whose moves have not landed. Fails where a sign-in or a reset holds it.
    fn hold_in_flight(
        &self,
        account_id: &ProviderAccountId,
    ) -> Result<Arc<InFlightGuard>, ProviderSignInError> {
        let mut holds = lock(&self.in_flight_holds);
        if let Some(guard) = holds.get(account_id).and_then(Weak::upgrade) {
            return Ok(guard);
        }
        let guard = Arc::new(
            self.deps
                .accounts_in_flight
                .begin(account_id.clone())
                .ok_or(ProviderSignInError::InFlight)?,
        );
        holds.insert(account_id.clone(), Arc::downgrade(&guard));
        Ok(guard)
    }

    // Notes each of `leads` as heading for `to` while its move is held in the driver, under the
    // number this switch is given, which it answers.
    fn hold_moves(&self, leads: &[LeadToMove], to: &ProviderAccountId) -> u64 {
        let mut held = lock(&self.held_moves);
        let switch_number = held.next_switch;
        held.next_switch += 1;
        for lead in leads {
            held.targets
                .insert(lead.landing.session_id, (switch_number, to.clone()));
        }
        switch_number
    }

    // Lets a switch's in-flight hold go, under the lock a later switch shares holds through, so
    // that switch finds either the hold or the account free.
    fn let_go_in_flight(&self, guard: Option<Arc<InFlightGuard>>) {
        let mut holds = lock(&self.in_flight_holds);
        drop(guard);
        holds.retain(|_, guard| guard.strong_count() > 0);
    }

    // Moves every lead of `plan` onto its account, grouped by the account each leaves, every group
    // at once, freeing the provider's lock once the driver has each move landed or waiting and the
    // target's `in_flight_guard` once every move landed, then settling each where the driver says
    // it landed, and answers the watch of each moved lead's first request on the new account,
    // which ends once every one has settled.
    async fn carry_out(
        self: &Arc<Self>,
        plan: SwitchPlan,
        actor: DeviceId,
        in_flight_guard: Option<Arc<InFlightGuard>>,
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
            drop(hold);
            self.let_go_in_flight(in_flight_guard);
            return futures::future::ready(()).boxed();
        };
        let switch_number = self.hold_moves(&leads, &to);
        let mut by_account: HashMap<ProviderAccountId, HashMap<SessionId, LeadToMove>> =
            HashMap::new();
        for lead in leads {
            by_account
                .entry(lead.from.clone())
                .or_default()
                .insert(lead.landing.session_id, lead);
        }
        let mut acceptances = Vec::new();
        let mut moving = Vec::new();
        for (from, leads) in by_account {
            let sessions = leads
                .values()
                .map(|lead| SessionToMove {
                    session_id: lead.landing.session_id,
                    binding_id: lead.binding_id.clone(),
                })
                .collect();
            let (accepted, is_accepted) = oneshot::channel();
            acceptances.push(is_accepted);
            let moves = legs.move_sessions(from, to.clone(), sessions, actor.clone(), accepted);
            moving.push(async move { (leads, moves.await) });
        }
        // Every move landed: the target is let go before the lock where both end together, so a
        // second switch onto it, waiting on that lock, finds it free.
        let landed = async {
            let moved = join_all(moving).await;
            self.let_go_in_flight(in_flight_guard);
            moved
        };
        // A second switch on the provider may begin once the driver holds every move.
        let let_go_lock = async move {
            join_all(acceptances).await;
            drop(hold);
        };
        // Polled in this order, so the moves' end lets the target go first.
        let (moved, ()) = futures::join!(landed, let_go_lock);
        lock(&self.held_moves)
            .targets
            .retain(|_session_id, (switch, _target)| *switch != switch_number);
        let mut first_requests = Vec::new();
        for (mut leads, moves) in moved {
            for moved in moves {
                let (session_id, landing) = match moved {
                    Ok(moved) => (moved.session_id, Ok(moved.outcome)),
                    Err((session_id, error)) => (session_id, Err(error)),
                };
                let Some(lead) = leads.remove(&session_id) else {
                    continue;
                };
                match landing {
                    Ok(SessionAccountMoveOutcome::Landed {
                        provider_account_id,
                        first_request,
                    }) => {
                        let watch = self
                            .land(
                                lead.landing,
                                provider_account_id,
                                actor.clone(),
                                first_request,
                            )
                            .await;
                        first_requests.push(watch);
                    }
                    Ok(SessionAccountMoveOutcome::Replaced { landed_on }) => {
                        tracing::debug!(
                            %session_id,
                            landed_on = landed_on.as_str(),
                            "a newer switch replaced a session's move and records its landing"
                        );
                    }
                    Err(error) => {
                        self.record_failed(&lead.landing, &to, &actor, &error).await;
                    }
                }
            }
        }
        join_all(first_requests).map(drop).boxed()
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

    /// Reads `moved`'s session's lead and level, then lands it on the account its move names on a
    /// task of its own, by `actor` or else this machine's own device, answering that task; `None`
    /// for a move a newer one replaced, which that one records, and, logged, where the switch is
    /// gone, as while the daemon stops, the lead or level cannot be read or the log names no lead.
    pub(crate) async fn land(
        &self,
        moved: SessionAccountMove,
        actor: Option<DeviceId>,
    ) -> Option<JoinHandle<()>> {
        let session_id = moved.session_id;
        let SessionAccountMoveOutcome::Landed {
            provider_account_id: to,
            first_request,
        } = moved.outcome
        else {
            return None;
        };
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
            let watch = switch.land(lead, to, actor, first_request).await;
            watch.await;
        }))
    }
}

impl SessionAccountMoveRecorder for SessionAccountMoveRecord {
    /// Lands the move as [`SessionAccountMoveRecord::land`] does, its task left to run.
    fn record_account_moved(
        &self,
        moved: SessionAccountMove,
        actor: Option<DeviceId>,
    ) -> BoxFuture<'_, ()> {
        async move {
            drop(self.land(moved, actor).await);
        }
        .boxed()
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

mod landing;

#[cfg(test)]
mod tests;
