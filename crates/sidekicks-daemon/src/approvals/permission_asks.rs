//! The approval pipeline's intake of provider permission asks, and the way back of each answer.
//!
//! - Each ask passes the permission check, which answers it itself where the daemon has an answer
//!   and else raises its card. A daemon answer goes straight back to its provider with no record,
//!   and an allow among them marks the session's working folder stale, as an approved card does.
//! - An ask the check could not decide is refused at its provider, so no call waits on a check that
//!   failed, and the failure goes on to the driver that handed it.
//! - An ask is held by its run and its provider's request id from its arrival until its run ends or
//!   its provider takes it back, so a second delivery of an ask still waiting raises nothing, and
//!   one already answered, by its card or by the daemon, gets the kept answer again. A delivery
//!   under a held request id that names another action is another ask: the held one's card is
//!   withdrawn while it waits, and the new one is checked afresh.
//! - A card's answer is recorded, kept with the held ask, then handed to the provider that holds
//!   the call, decision first, with the rule it made, which is recorded once the provider kept it.
//!   A hand that failed before the provider took it is handed again when the client sends the
//!   answer again; one the provider took, or may have taken, is never handed blind a second time.
//! - A card the daemon raised itself names no provider ask: its answer goes to whoever raised it,
//!   and the session rule it made is recorded at once, kept and honored by the daemon alone; the
//!   same answer sent again records a rule whose record failed.

use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, Mutex, MutexGuard};

use futures::future::BoxFuture;
use sidekicks_contracts::approval::{
    ApprovalDecision, ApprovalRequestId, ApprovalResolveRequest, ApprovalResolveResponse,
    ApprovalState, RememberedScope, RememberedScopeKind,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::NonEmptyText;
use tokio_util::sync::CancellationToken;

use crate::permission_check::{PermissionCheck, PermissionCheckError, ProviderAskVerdict};
use crate::refusals::{approval_request_canceled, approval_rule_not_kept};
use crate::rules::{ApprovalRuleError, ApprovalRules};
use crate::service::{ApprovalService, ApprovalServiceError, ResolveAnswer, ResolvedAnswer};
use crate::store::{StoredApprovalRequest, StoredApprovalResolution};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_policy::ask_rule::{ProviderAskActionKind, ProviderAskRule};
use sidekicks_provider::driver::contract::{
    DriverError, ProviderRequestAnswer, RespondToRequestParams,
};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::port::permission_ask::{
    PermissionAskPort, ProviderAnswerCorrection, ProviderAnswerRule, ProviderAskAction,
    ProviderPermissionAnswer, ProviderPermissionAsk, ProviderPermissionAskWithdrawal,
};
use sidekicks_session::run::read::read_run_provider;
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};

/// What the agent reads when its call was refused because the check itself failed.
pub(crate) const CHECK_FAILED_REFUSAL: &str = "This call could not be checked, so it did not run.";

/// Why an ask could not be taken or an answer could not be carried back.
#[derive(Debug, thiserror::Error)]
pub(crate) enum PermissionAskError {
    /// A refusal by its code: the approval service's, or `approval.rule.notKept` once the call was
    /// answered but its provider could not keep the rule.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// The approval service failed.
    #[error(transparent)]
    Service(#[from] ApprovalServiceError),
    /// The check could not decide the ask.
    #[error(transparent)]
    Check(#[from] PermissionCheckError),
    /// The rule an answer made could not be recorded.
    #[error(transparent)]
    Rule(#[from] ApprovalRuleError),
    /// The driver could not answer its provider.
    #[error(transparent)]
    Driver(#[from] DriverError),
    /// SQLite refused the read of the run's provider.
    #[error("the run's provider could not be read")]
    Read(#[from] rusqlite::Error),
    /// The read pool did not run the read.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The run is bound to no provider, so no driver holds its ask.
    #[error("run {run_id} is bound to no provider")]
    NoProvider {
        /// The run.
        run_id: RunId,
    },
    /// The card's answer made a rule, but the card names no action for a rule to cover.
    #[error("card {approval_request_id} names no action for its rule to cover")]
    RuleWithoutAction {
        /// The card.
        approval_request_id: ApprovalRequestId,
    },
    /// The check failed, and so did refusing the call at its provider.
    #[error(transparent)]
    Unrefused(Box<CleanupFailures<PermissionAskError>>),
}

impl From<PermissionAskError> for HandlerError {
    /// A refusal answers by its code, a service's, a rule's or a driver's failure as each answers;
    /// the rest are faults in the daemon.
    fn from(error: PermissionAskError) -> Self {
        match error {
            PermissionAskError::Refused(refusal) => Self::Refused(refusal),
            PermissionAskError::Service(service) => Self::from(service),
            PermissionAskError::Rule(rule) => Self::from(rule),
            PermissionAskError::Driver(driver) => Self::from(driver),
            fault @ (PermissionAskError::Check(_)
            | PermissionAskError::Read(_)
            | PermissionAskError::Pool(_)
            | PermissionAskError::NoProvider { .. }
            | PermissionAskError::RuleWithoutAction { .. }
            | PermissionAskError::Unrefused(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// Where a held ask stands.
enum HeldAskState {
    /// Its check runs or its card waits for the person.
    Waiting,
    /// Its card or the daemon answered it: the answer, the rule it made, and whether a hand of it
    /// is under way or reached the provider, so no second hand goes out blind.
    Answered {
        answer: ProviderPermissionAnswer,
        made_rule: Option<ProviderAnswerRule>,
        is_handed: bool,
    },
}

/// A provider's ask from its arrival until its run ends or its provider takes it back.
struct HeldAsk {
    /// The session.
    session_id: SessionId,
    /// The daemon's own id for the ask, which its card carries; minted per delivery.
    ask_id: NonEmptyText,
    /// What the held call would do.
    action: ProviderAskAction,
    /// Canceled once the provider takes the ask back.
    withdrawal: CancellationToken,
    /// Where it stands.
    state: HeldAskState,
}

/// The held asks by run and the provider's request id.
type HeldAsks = HashMap<(RunId, String), HeldAsk>;

/// What the intake raises cards through and answers providers with.
pub(crate) struct PermissionAsksDeps {
    /// Where the run's provider is read.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// Records answers and cancels asks.
    pub(crate) approvals: Arc<ApprovalService>,
    /// Decides each ask.
    pub(crate) check: Arc<PermissionCheck>,
    /// Records the rule an answer made.
    pub(crate) rules: Arc<ApprovalRules>,
    /// The drivers that answer their providers.
    pub(crate) providers: Arc<ProviderRegistry>,
}

/// Takes each admitted provider ask and carries each card's answer back; shared by `Arc`.
pub(crate) struct PermissionAsks {
    deps: PermissionAsksDeps,
    held: Mutex<HeldAsks>,
}

impl PermissionAsks {
    /// The intake over `deps`, holding no ask.
    pub(crate) fn new(deps: PermissionAsksDeps) -> Self {
        Self {
            deps,
            held: Mutex::new(HashMap::new()),
        }
    }

    /// Answers the ask itself where the check has an answer, else raises its card under an ask id
    /// the daemon mints; a second delivery of an ask still waiting raises nothing, and one already
    /// answered gets that answer again. Fails, once the call is refused at its provider, as the
    /// check fails or as withdrawing the card of another ask held under its request id fails; and
    /// as handing an answer fails.
    pub(crate) async fn take_ask(
        &self,
        ask: ProviderPermissionAsk,
    ) -> Result<(), PermissionAskError> {
        let key = (ask.run_id, ask.request_id.clone());
        let ask_id =
            NonEmptyText::new(mint_uuid_v7().to_string()).expect("a minted UUID is not empty");
        let withdrawal = CancellationToken::new();
        let (redelivered, replaced) = {
            let mut held = self.lock_held();
            match held.get_mut(&key) {
                Some(HeldAsk {
                    action,
                    state: HeldAskState::Waiting,
                    ..
                }) if *action == ask.action => return Ok(()),
                Some(HeldAsk {
                    action,
                    state:
                        HeldAskState::Answered {
                            answer, is_handed, ..
                        },
                    ..
                }) if *action == ask.action => {
                    *is_handed = true;
                    (Some(answer.clone()), None)
                }
                Some(_) | None => {
                    let replaced = held.insert(
                        key.clone(),
                        HeldAsk {
                            session_id: ask.session_id,
                            ask_id: ask_id.clone(),
                            action: ask.action.clone(),
                            withdrawal: withdrawal.clone(),
                            state: HeldAskState::Waiting,
                        },
                    );
                    (None, replaced)
                }
            }
        };
        // It was answered: the provider asks again for the answer it may have lost.
        if let Some(answer) = redelivered {
            return self.hand_answer(&key, answer).await;
        }
        // One request id names one ask while it is held, so another action under it is another
        // ask, and an answer kept for the one held never goes to it.
        if let Some(replaced) = replaced {
            tracing::warn!(
                run_id = %ask.run_id,
                request_id = %ask.request_id,
                "permission_ask_redelivered_with_another_action"
            );
            if matches!(replaced.state, HeldAskState::Waiting)
                && let Err(failure) = self.cancel_held(ask.run_id, replaced).await
            {
                self.let_go(&key, &ask_id);
                return Err(self.refuse_unchecked(&ask, failure).await);
            }
        }
        let verdict = match self
            .deps
            .check
            .check_provider_ask(&ask, &ask_id, &withdrawal)
            .await
        {
            Ok(verdict) => verdict,
            Err(failure) => {
                self.let_go(&key, &ask_id);
                if matches!(failure, PermissionCheckError::Withdrawn) {
                    return Ok(());
                }
                return Err(self.refuse_unchecked(&ask, failure.into()).await);
            }
        };
        let answer = match verdict {
            ProviderAskVerdict::CardRaised(card) => {
                // Withdrawn while the card was raised: the card is canceled once it stands.
                if withdrawal.is_cancelled() {
                    self.deps
                        .approvals
                        .withdraw(card.approval_request_id)
                        .await?;
                }
                return Ok(());
            }
            ProviderAskVerdict::Allowed => allow(None),
            ProviderAskVerdict::AnsweredByRule(rule) => allow(Some(rule)),
            ProviderAskVerdict::Denied { refusal } => ProviderPermissionAnswer::Refuse {
                reason: Some(refusal.to_owned()),
                made_rule: None,
            },
        };
        self.keep_answer(&key, &ask_id, &answer);
        if withdrawal.is_cancelled() {
            return Ok(());
        }
        let is_allowed = matches!(answer, ProviderPermissionAnswer::Allow { .. });
        self.hand_answer(&key, answer).await?;
        if is_allowed {
            self.deps
                .approvals
                .mark_working_folder_stale(ask.session_id)
                .await;
        }
        Ok(())
    }

    /// Settles the card of an ask its provider took back, canceled; an answered one keeps its
    /// answer. Fails as the read of its card or the cancel fails.
    pub(crate) async fn withdraw_ask(
        &self,
        withdrawal: ProviderPermissionAskWithdrawal,
    ) -> Result<(), PermissionAskError> {
        let taken_back = {
            let mut held = self.lock_held();
            let key = held
                .iter()
                .find(|((_, request_id), ask)| {
                    *request_id == withdrawal.request_id && ask.session_id == withdrawal.session_id
                })
                .map(|(key, _)| key.clone());
            key.and_then(|key| held.remove(&key).map(|ask| (key.0, ask)))
        };
        let Some((run_id, ask)) = taken_back else {
            return Ok(());
        };
        self.cancel_held(run_id, ask).await
    }

    /// Records one answer, then hands it to the provider that holds the call, decision first,
    /// then records the rule it made once the provider kept it; a card the daemon raised itself
    /// records its rule at once. What is handed is the stored answer, its correction, its decline's
    /// words and its rule, never a resend's. The same answer sent again hands it again only where
    /// no earlier hand reached, or may have reached, the provider, and records a daemon card's rule
    /// whose record failed. Fails with the approval service's refusals; `approval.requestCanceled`,
    /// the answer not recorded and the card withdrawn, for a provider's pending card whose ask is
    /// no longer held; `approval.rule.notKept` when the call was answered but its provider could
    /// not keep the rule, which is then not recorded; [`PermissionAskError::RuleWithoutAction`] for
    /// a daemon card that names no action for its rule; and as reaching the provider or recording
    /// the rule fails, the answer kept.
    pub(crate) async fn resolve(
        &self,
        request: &ApprovalResolveRequest,
        device_id: DeviceId,
    ) -> Result<ApprovalResolveResponse, PermissionAskError> {
        let answer = ResolveAnswer::of(request);
        // A provider's card whose ask is no longer held, its withdrawal or its replacement not
        // kept, has no call left to answer, so the card is withdrawn and the answer refused before
        // it is recorded.
        if let Some(stored) = self
            .deps
            .approvals
            .read_request(answer.approval_request_id)
            .await?
            && stored.state == ApprovalState::Pending
            && let Some(ask_id) = &stored.ask_id
            && self.find_held(stored.run_id, ask_id).is_none()
        {
            self.deps
                .approvals
                .withdraw(stored.approval_request_id)
                .await?;
            return Err(approval_request_canceled(stored.approval_request_id).into());
        }
        let ResolvedAnswer {
            response,
            request: stored,
        } = self.deps.approvals.resolve(request, device_id).await?;
        let Some(ask_id) = stored.ask_id.clone() else {
            // A card's rule is the one its stored answer asked for, recorded once: the answer sent
            // again records the rule whose record failed the first time, and nothing once it was
            // ever recorded, revoked since or not.
            if let Some(scope) = stored.asked_scope() {
                self.record_daemon_rule(&stored, scope).await?;
            }
            return Ok(response);
        };
        let Some((request_id, answer, made_rule)) = self.claim_hand(&stored, &ask_id).await? else {
            return Ok(response);
        };
        match self.hand_answer(&(stored.run_id, request_id), answer).await {
            Ok(()) => {
                if let Some(made_rule) = made_rule {
                    self.deps.rules.record(&stored, &made_rule).await?;
                }
                Ok(response)
            }
            Err(PermissionAskError::Driver(DriverError::RuleNotKept(not_kept))) => {
                Err(approval_rule_not_kept(stored.approval_request_id, not_kept).into())
            }
            Err(failure) => Err(failure),
        }
    }

    /// Lets go of the asks of a run that ended, whose cards its end cancels.
    pub(crate) fn forget_run(&self, run_id: RunId) {
        self.lock_held().retain(|(held_run_id, _), ask| {
            let is_kept = *held_run_id != run_id;
            if !is_kept {
                ask.withdrawal.cancel();
            }
            is_kept
        });
    }

    // Keeps the stored answer with the held ask and claims its hand: the answer to hand, its
    // request id and the rule the stored answer asked for, or `None` where no ask is held for it,
    // or a hand of it is under way or reached its provider.
    async fn claim_hand(
        &self,
        stored: &StoredApprovalRequest,
        ask_id: &NonEmptyText,
    ) -> Result<
        Option<(String, ProviderPermissionAnswer, Option<ProviderAnswerRule>)>,
        PermissionAskError,
    > {
        let Some((request_id, action)) = self.find_held(stored.run_id, ask_id) else {
            return Ok(None);
        };
        let made_rule = match stored.asked_scope() {
            Some(scope) => Some(ProviderAnswerRule {
                rule: rule_of(scope, ProviderAskActionKind::from(&action)),
                project_folders: match scope.kind {
                    RememberedScopeKind::Project => {
                        self.deps
                            .rules
                            .read_project_folders(stored.session_id, false)
                            .await?
                    }
                    RememberedScopeKind::Session => Vec::new(),
                },
            }),
            None => None,
        };
        let resolution = stored
            .resolution
            .as_ref()
            .expect("an ask the service settled holds its answer");
        let composed = compose_answer(stored.approval_request_id, resolution, made_rule.clone());
        let mut held = self.lock_held();
        let Some(ask) = held.get_mut(&(stored.run_id, request_id.clone())) else {
            return Ok(None);
        };
        let claimed = match &mut ask.state {
            HeldAskState::Answered {
                is_handed: true, ..
            } => None,
            HeldAskState::Answered {
                answer,
                made_rule,
                is_handed,
            } => {
                *is_handed = true;
                Some((answer.clone(), made_rule.clone()))
            }
            HeldAskState::Waiting => {
                ask.state = HeldAskState::Answered {
                    answer: composed.clone(),
                    made_rule: made_rule.clone(),
                    is_handed: true,
                };
                Some((composed, made_rule))
            }
        };
        Ok(claimed.map(|(answer, made_rule)| (request_id, answer, made_rule)))
    }

    // The session rule an answer made on a card the daemon raised itself, recorded at once: no
    // provider holds it.
    async fn record_daemon_rule(
        &self,
        stored: &StoredApprovalRequest,
        scope: &RememberedScope,
    ) -> Result<(), PermissionAskError> {
        let Some(action) = &stored.resource_descriptor.action else {
            return Err(PermissionAskError::RuleWithoutAction {
                approval_request_id: stored.approval_request_id,
            });
        };
        let made_rule = ProviderAnswerRule {
            rule: rule_of(scope, ProviderAskActionKind::from(action)),
            project_folders: Vec::new(),
        };
        Ok(self.deps.rules.record(stored, &made_rule).await?)
    }

    // Hands a held ask's kept answer, its hand already claimed. A failure before the provider took
    // it lets the hand be claimed again; one after which the provider may have taken it, or kept
    // it without its rule, never does, so no second hand goes out blind.
    async fn hand_answer(
        &self,
        key: &(RunId, String),
        answer: ProviderPermissionAnswer,
    ) -> Result<(), PermissionAskError> {
        let handed = self.hand(key.0, key.1.clone(), answer).await;
        if let Err(failure) = &handed
            && !matches!(
                failure,
                PermissionAskError::Driver(
                    DriverError::RuleNotKept(_) | DriverError::Unanswered(_)
                )
            )
            && let Some(HeldAsk {
                state: HeldAskState::Answered { is_handed, .. },
                ..
            }) = self.lock_held().get_mut(key)
        {
            *is_handed = false;
        }
        handed
    }

    // Hands `answer` to the driver of the run's provider.
    async fn hand(
        &self,
        run_id: RunId,
        request_id: String,
        answer: ProviderPermissionAnswer,
    ) -> Result<(), PermissionAskError> {
        let provider = self
            .deps
            .reads
            .read(ReadLength::Short, move |connection| {
                Ok::<_, PermissionAskError>(read_run_provider(connection, &run_id)?)
            })
            .await?
            .ok_or(PermissionAskError::NoProvider { run_id })?;
        let driver = self.deps.providers.lookup(&provider.provider)?;
        driver
            .respond_to_request(RespondToRequestParams {
                run_id,
                request_id,
                response: ProviderRequestAnswer::Permission(answer),
            })
            .await?;
        Ok(())
    }

    // Refuses the call the check could not decide, then answers the check's failure, with the
    // refusal's beside it when that failed too.
    async fn refuse_unchecked(
        &self,
        ask: &ProviderPermissionAsk,
        check_failure: PermissionAskError,
    ) -> PermissionAskError {
        let refusal = ProviderPermissionAnswer::Refuse {
            reason: Some(CHECK_FAILED_REFUSAL.to_owned()),
            made_rule: None,
        };
        match self.hand(ask.run_id, ask.request_id.clone(), refusal).await {
            Ok(()) => check_failure,
            Err(refusal_failure) => PermissionAskError::Unrefused(Box::new(CleanupFailures::new(
                check_failure,
                vec![refusal_failure],
                "refusing a call whose check failed",
            ))),
        }
    }

    // Cancels a held ask its provider took back or another ask replaced, and its card while that
    // waits; an answered card keeps its answer.
    async fn cancel_held(&self, run_id: RunId, ask: HeldAsk) -> Result<(), PermissionAskError> {
        ask.withdrawal.cancel();
        if let Some(stored) = self
            .deps
            .approvals
            .read_ask_request(run_id, ask.ask_id)
            .await?
        {
            self.deps
                .approvals
                .withdraw(stored.approval_request_id)
                .await?;
        }
        Ok(())
    }

    // Keeps the daemon's answer with the delivery `ask_id` held under `key`, its hand claimed, as a
    // card's answer is kept, so a redelivery gets it again and no second check runs.
    fn keep_answer(
        &self,
        key: &(RunId, String),
        ask_id: &NonEmptyText,
        answer: &ProviderPermissionAnswer,
    ) {
        if let Some(ask) = self.lock_held().get_mut(key)
            && ask.ask_id == *ask_id
        {
            ask.state = HeldAskState::Answered {
                answer: answer.clone(),
                made_rule: None,
                is_handed: true,
            };
        }
    }

    // Lets go of the delivery `ask_id` held under `key`, unless another delivery holds it now.
    fn let_go(&self, key: &(RunId, String), ask_id: &NonEmptyText) {
        let mut held = self.lock_held();
        if held.get(key).is_some_and(|ask| ask.ask_id == *ask_id) {
            held.remove(key);
        }
    }

    // The request id and action of the ask held on the run under `ask_id`.
    fn find_held(
        &self,
        run_id: RunId,
        ask_id: &NonEmptyText,
    ) -> Option<(String, ProviderAskAction)> {
        self.lock_held()
            .iter()
            .find(|((held_run_id, _), ask)| *held_run_id == run_id && ask.ask_id == *ask_id)
            .map(|((_, request_id), ask)| (request_id.clone(), ask.action.clone()))
    }

    fn lock_held(&self) -> MutexGuard<'_, HeldAsks> {
        // The map holds whole entries only, so a panic elsewhere leaves nothing half written.
        lock(&self.held)
    }
}

impl PermissionAskPort for PermissionAsks {
    fn take_ask(
        &self,
        ask: ProviderPermissionAsk,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        Box::pin(async move { Ok(PermissionAsks::take_ask(self, ask).await?) })
    }

    fn withdraw_ask(
        &self,
        withdrawal: ProviderPermissionAskWithdrawal,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        Box::pin(async move { Ok(PermissionAsks::withdraw_ask(self, withdrawal).await?) })
    }
}

fn allow(answered_by_rule: Option<ProviderAskRule>) -> ProviderPermissionAnswer {
    ProviderPermissionAnswer::Allow {
        correction: None,
        made_rule: None,
        answered_by_rule,
    }
}

// The rule `scope` names over an action of kind `action`.
fn rule_of(scope: &RememberedScope, action: ProviderAskActionKind) -> ProviderAskRule {
    ProviderAskRule {
        kind: scope.kind,
        sense: scope.sense,
        action,
        subject: scope.pattern.as_str().to_owned(),
    }
}

// The provider's answer to card `approval_request_id`'s stored answer: an allow with the
// correction it carries, or a refusal with the decline's words, each with the rule it made.
fn compose_answer(
    approval_request_id: ApprovalRequestId,
    resolution: &StoredApprovalResolution,
    made_rule: Option<ProviderAnswerRule>,
) -> ProviderPermissionAnswer {
    match resolution.decision {
        ApprovalDecision::Approved => ProviderPermissionAnswer::Allow {
            correction: resolution.edited_action.as_ref().map(|edited_action| {
                ProviderAnswerCorrection {
                    edited_action: edited_action.as_str().to_owned(),
                    approval_request_id,
                }
            }),
            made_rule,
            answered_by_rule: None,
        },
        ApprovalDecision::Rejected => ProviderPermissionAnswer::Refuse {
            reason: resolution
                .decline_reason
                .as_ref()
                .map(|reason| reason.as_str().to_owned()),
            made_rule,
        },
    }
}

#[cfg(test)]
pub(crate) mod tests;
