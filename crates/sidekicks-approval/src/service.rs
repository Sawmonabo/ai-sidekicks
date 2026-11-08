//! The approval service: raises an ask, records its one answer, and cancels the asks a run's end,
//! a session's close or a provider's take-back leaves open. Each step is one write carrying its row
//! change, its guards and its `approval.*` event, so the log and the rows never disagree, and a
//! decision read before the write is checked again by a guarded statement inside it.
//!
//! - Nothing settles an ask on elapsed time: an ask waits until it is answered, or until its run
//!   ends, its session closes or its provider takes it back, which cancel it.
//! - The first answer from any device settles an ask. The same answer sent again, under the same
//!   client resolution id, is answered with what was saved; any other is refused.
//! - Whoever raised a card waits on a wait armed before the card's write and settled in process by
//!   the write that settles the card, so a decline's words reach them as the card settles.
//! - Each write that changes a run's open asks has the run's hold reconciled once it commits.
//! - An answer to a card no live call holds, no provider ask held for it and no waiter on the
//!   daemon's own card, is kept as an orphaned answer in the answer's own write for the call made
//!   again and the run's continue, and its run's hold is reconciled before the answer returns.
//! - An approval marks the session's working folder stale once it commits, since work the person
//!   has not seen may land there; a decline and a cancel mark nothing.
//! - An approval that corrected the command or path records the corrected words with the answer,
//!   and the provider ask that carries them out takes the correction once, in a guarded write. A
//!   decline records the person's words with the answer, so a resend hands its provider the same.

mod cancel;
pub mod session_sweep;

use std::error::Error;
use std::sync::Arc;

use sidekicks_contracts::approval::events::{ApprovalRequestedPayload, ApprovalResolvedPayload};
use sidekicks_contracts::approval::holder::ApprovalHolder;
use sidekicks_contracts::approval::{
    ApprovalCategory, ApprovalDecision, ApprovalLateCreateReason, ApprovalRequestId,
    ApprovalResolutionInvalidReason, ApprovalResolveRequest, ApprovalResolveResponse,
    ApprovalScope, ApprovalState, RememberedRuleSense, RememberedScope, RememberedScopeKind,
};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::release_manifest::Sha256Hex;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::{ClientUuid, mint_uuid_v7};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_std::keyed_wait::{ArmedWait, KeyedWaits};
use sidekicks_std::port_registration::{PortRegistration, PortRegistrationError};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::events::log_service::EventAppendError;
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventDraftError,
    SessionEventLinkage,
};
use sidekicks_store::events::session::pending::PendingSessions;
use sidekicks_workspace::git::worktree::watch::WorkingFolderWatcher;

use crate::events::resolved_event;
use crate::orphaned_answers::{OrphanedAnswers, insert_orphaned_answer_statement};
use crate::refusals::{
    approval_already_resolved, approval_late_create, approval_not_found,
    approval_persistence_unavailable, approval_request_canceled, approval_resolution_invalid,
};
use crate::request_create::{ApprovalRequestCreateRequest, ApprovalRequestOrigin};
use crate::run_blocking::ApprovalRunHolds;
use crate::store::{
    ApprovalCorrectionUse, ApprovalRequestReader, ApprovalSettlement, InsertedApprovalRequest,
    InsertedApprovalResolution, StoredApprovalRequest, StoredApprovalResolution,
    insert_correction_use_statement, insert_request_statement, insert_resolution_statement,
    run_live_statement, session_open_statement, settle_pending_statement,
};
use crate::workflow_gate::{ApprovalWaitAnswer, ApprovalWaits};

// The positions of a create's guards among its statements.
const SESSION_OPEN_GUARD_INDEX: usize = 0;
const RUN_LIVE_GUARD_INDEX: usize = 1;
// The positions of an answer's pending guard and its run's live guard among its statements; a
// cancel's pending guard is its only statement.
const PENDING_GUARD_INDEX: usize = 0;
const ANSWER_RUN_LIVE_GUARD_INDEX: usize = 1;

/// What a raised card's wait is keyed by: its run, so the run's end settles every card of the run,
/// and its own id.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct RaisedCardKey {
    /// The run the card holds.
    pub(crate) run_id: RunId,
    /// The card.
    pub(crate) approval_request_id: ApprovalRequestId,
}

/// How a raised card settled, as whoever raised it hears it: approved, declined with the person's
/// words where they typed any, canceled unanswered with its run, its session or its provider's
/// take-back, or left unsettled by the daemon's stop.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RaisedRequestSettlement {
    /// The person approved it.
    Approved,
    /// The person declined it.
    Rejected {
        /// The `why not` words, where the person typed any.
        decline_reason: Option<NonEmptyText>,
        /// When the decline was recorded, the instant its resolve wrote.
        resolved_at: WireInstant,
    },
    /// It ended unanswered.
    Canceled,
    /// The daemon stopped before it settled.
    Stopped,
}

/// A card just raised: its id and the wait for how it settles. Dropping the wait withdraws it and
/// leaves the card standing.
pub(crate) struct RaisedCard {
    /// The card.
    pub(crate) approval_request_id: ApprovalRequestId,
    /// How it settles.
    pub(crate) settled: ArmedWait<RaisedCardKey, RaisedRequestSettlement>,
}

/// One answer as [`ApprovalService::resolve`] settled it: what the caller is answered, the ask as
/// the answer settled it, with the stored answer, and whether this answer is orphaned.
#[derive(Clone, Debug)]
pub(crate) struct ResolvedAnswer {
    /// What the caller is answered.
    pub(crate) response: ApprovalResolveResponse,
    /// The ask the answer settled.
    pub(crate) request: StoredApprovalRequest,
    /// Whether this answer is orphaned, no live call holding its card when it was recorded.
    pub(crate) is_orphaned: bool,
}

/// The members of one `approval.resolve` answer, read out of whichever decision it carries.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ResolveAnswer<'request> {
    /// The ask.
    pub(crate) approval_request_id: ApprovalRequestId,
    /// The id the answering client minted.
    pub(crate) client_resolution_id: &'request ClientUuid,
    /// The answer.
    pub(crate) decision: ApprovalDecision,
    /// The scope the answer names; the ask's own when absent.
    pub(crate) effective_scope: Option<&'request ApprovalScope>,
    /// The command or path as the person corrected it, on an approval.
    pub(crate) edited_action: Option<&'request NonEmptyText>,
    /// The `why not` words, on a decline.
    pub(crate) decline_reason: Option<&'request NonEmptyText>,
    /// The rule the answer asks for.
    pub(crate) remembered_scope: Option<&'request RememberedScope>,
}

impl<'request> ResolveAnswer<'request> {
    /// The members `request` carries, whichever its decision.
    pub(crate) fn of(request: &'request ApprovalResolveRequest) -> Self {
        match request {
            ApprovalResolveRequest::Approved {
                approval_request_id,
                client_resolution_id,
                effective_scope,
                edited_action,
                remembered_scope,
                ..
            } => Self {
                approval_request_id: *approval_request_id,
                client_resolution_id,
                decision: ApprovalDecision::Approved,
                effective_scope: effective_scope.as_ref(),
                edited_action: edited_action.as_ref(),
                decline_reason: None,
                remembered_scope: remembered_scope.as_ref(),
            },
            ApprovalResolveRequest::Rejected {
                approval_request_id,
                client_resolution_id,
                effective_scope,
                decline_reason,
                remembered_scope,
                ..
            } => Self {
                approval_request_id: *approval_request_id,
                client_resolution_id,
                decision: ApprovalDecision::Rejected,
                effective_scope: effective_scope.as_ref(),
                edited_action: None,
                decline_reason: decline_reason.as_ref(),
                remembered_scope: remembered_scope.as_ref(),
            },
        }
    }
}

/// Why the approval service refused or failed a call.
#[derive(Debug, thiserror::Error)]
pub enum ApprovalServiceError {
    /// A refusal by its code: the ask unknown, already answered or canceled, an answer that does
    /// not fit it, a create after its run or session ended, a record that could not be kept, or
    /// the session's own refusal of the write.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// SQLite refused a read, or a stored column does not read as its type.
    #[error("a read of the approval requests failed")]
    Read(#[from] rusqlite::Error),
    /// The read pool did not run the read.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The approval event breaks a check of its type.
    #[error("the approval event could not be drafted")]
    Draft(#[from] SessionEventDraftError),
    /// The event log did not keep a cancel.
    #[error("the approval request was not canceled")]
    Cancel(#[source] SessionEventAppendError),
    /// An answer reached a workflow wait's card before the workflow engine registered its waits.
    #[error(transparent)]
    WaitsUnregistered(#[from] PortRegistrationError),
    /// The workflow wait holding the card could not take its answer.
    #[error("the workflow wait did not take the approval's answer")]
    Wait(#[source] Box<dyn Error + Send + Sync>),
}

impl From<ApprovalServiceError> for HandlerError {
    /// A refusal answers by its code; the rest are faults in the daemon.
    fn from(error: ApprovalServiceError) -> Self {
        match error {
            ApprovalServiceError::Refused(refusal) => Self::Refused(refusal),
            fault @ (ApprovalServiceError::Read(_)
            | ApprovalServiceError::Pool(_)
            | ApprovalServiceError::Draft(_)
            | ApprovalServiceError::Cancel(_)
            | ApprovalServiceError::WaitsUnregistered(_)
            | ApprovalServiceError::Wait(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// Raises asks, records their answers, and cancels the ones their run, their session or their
/// provider leaves open. Shared by `Arc`.
pub struct ApprovalService {
    /// Where the asks are read.
    reads: Arc<DatabaseReadPool>,
    /// Where the approval events are appended.
    pub(crate) events: Arc<SessionEventAppender>,
    /// Where a correction's one use is recorded.
    writer: Arc<DatabaseWriter>,
    /// Whose folders an approval marks stale.
    working_folders: Arc<WorkingFolderWatcher>,
    /// Reconciles a run's hold once its open asks change.
    run_holds: Arc<ApprovalRunHolds>,
    /// The answers kept while no live call held their card.
    orphaned_answers: OrphanedAnswers,
    /// Whoever waits on a raised card, until it settles.
    raised_cards: KeyedWaits<RaisedCardKey, RaisedRequestSettlement>,
    /// Closed sessions whose pending asks the sweep has yet to cancel.
    closed_sessions: PendingSessions,
    /// Where an answer to a workflow wait's card goes, registered once by the workflow engine.
    waits: PortRegistration<Arc<dyn ApprovalWaits>>,
}

impl ApprovalService {
    /// The service reading through `reads`, recording through `events` and `writer`, marking
    /// `working_folders` stale and reconciling runs through `run_holds`; no closed session's asks
    /// are canceled until [`ApprovalService::start`].
    pub fn new(
        reads: Arc<DatabaseReadPool>,
        events: Arc<SessionEventAppender>,
        writer: Arc<DatabaseWriter>,
        working_folders: Arc<WorkingFolderWatcher>,
        run_holds: Arc<ApprovalRunHolds>,
    ) -> Self {
        Self {
            orphaned_answers: OrphanedAnswers::new(Arc::clone(&reads), Arc::clone(&writer)),
            reads,
            events,
            writer,
            working_folders,
            run_holds,
            raised_cards: KeyedWaits::default(),
            closed_sessions: PendingSessions::default(),
            waits: PortRegistration::new("approval waits"),
        }
    }

    /// The workflow waits' port, which the workflow engine registers once; until then an answer
    /// to a wait's card is refused as a fault.
    pub fn waits(&self) -> &PortRegistration<Arc<dyn ApprovalWaits>> {
        &self.waits
    }

    /// Raises one ask, pending until it is answered or canceled, and answers its id with the wait
    /// for how it settles, armed before the write. `origin` carries what only the daemon knows:
    /// the provider ask it was minted for, the tool call it holds and that call's input digest.
    /// Refuses
    /// `approval.requestCanceled` with its `reason` when the session has closed or the run has
    /// ended, the session's own refusal of the write, and `approval.persistenceUnavailable` when
    /// the record could not be kept.
    pub(crate) async fn create(
        &self,
        request: ApprovalRequestCreateRequest,
        origin: ApprovalRequestOrigin,
    ) -> Result<RaisedCard, ApprovalServiceError> {
        let ApprovalRequestCreateRequest {
            session_id,
            run_id,
            requested_by,
            category,
            scope,
            resource_descriptor,
        } = request;
        let approval_request_id =
            ApprovalRequestId::try_from(mint_uuid_v7()).expect("a minted UUID is an ask's id");
        let created_at = WireInstant::now();
        let holder = ApprovalHolder::Run { run_id };
        let payload = ApprovalRequestedPayload {
            session_id,
            holder: holder.clone(),
            approval_request_id,
            category,
            scope: scope.clone(),
            requested_by: requested_by.clone(),
            resource_descriptor: resource_descriptor.to_record(),
            ask_id: origin.ask_id.clone(),
            tool_call_id: origin.tool_call_id.clone(),
            input_digest: origin.input_digest.clone(),
        };
        let inserted = InsertedApprovalRequest {
            approval_request_id,
            session_id,
            holder: holder.clone(),
            requested_by,
            category,
            scope,
            resource_descriptor,
            ask_id: origin.ask_id,
            tool_call_id: origin.tool_call_id,
            input_digest: origin.input_digest,
            created_at: created_at.clone(),
        };
        let draft = SessionEventDraft::new(payload, SessionEvent::ApprovalRequested)?;
        let linkage = SessionEventLinkage {
            occurred_at: Some(created_at),
            transactional_prelude: vec![
                session_open_statement(&session_id),
                run_live_statement(&session_id, &run_id),
                insert_request_statement(&inserted),
            ],
            ..SessionEventLinkage::default()
        };
        // Armed before the write, so an answer that lands the moment it commits finds its waiter.
        let settled = self.raised_cards.arm(RaisedCardKey {
            run_id,
            approval_request_id,
        });
        if let Err(failure) = self.events.append(draft, linkage).await {
            let refusal = match failure.refused_statement_index() {
                Some(SESSION_OPEN_GUARD_INDEX) => approval_late_create(
                    session_id,
                    &holder,
                    ApprovalLateCreateReason::SessionClosed,
                ),
                Some(RUN_LIVE_GUARD_INDEX) => {
                    approval_late_create(session_id, &holder, ApprovalLateCreateReason::RunEnded)
                }
                Some(_) | None => refusal_of_failed_write(failure),
            };
            return Err(refusal.into());
        }
        self.run_holds.spawn_reconcile(run_id);
        Ok(RaisedCard {
            approval_request_id,
            settled,
        })
    }

    /// Records one answer to an ask, stamped with `device_id`, the device whose connection carried
    /// it; the scope defaults to the ask's own. The rule the answer asks for is stored with it but
    /// not recorded here: its record follows once its keeper kept it. A pending provider card whose
    /// ask `is_ask_held` does not hold, or a daemon card with no waiter, has its answer kept in the
    /// same write and its run's hold reconciled before this returns. Refuses `approval.notFound`,
    /// `approval.requestCanceled` for an ask canceled or whose run has ended,
    /// `approval.alreadyResolved` for an ask another answer settled (the same answer sent again
    /// under its client resolution id is answered with what was saved),
    /// `approval.resolutionInvalid` for an answer that does not fit its ask, the session's own
    /// refusal of the write, and `approval.persistenceUnavailable` when the record could not be
    /// kept. An answer to a workflow wait's card is handed, with its write, to the registered
    /// [`ApprovalWaits`], which settles the card in the step's own write; this writes nothing for
    /// it but the cancel of a card whose wait no longer waits, refused `approval.requestCanceled`.
    pub(crate) async fn resolve(
        &self,
        request: &ApprovalResolveRequest,
        device_id: DeviceId,
        is_ask_held: impl FnOnce(RunId, &NonEmptyText) -> bool + Send,
    ) -> Result<ResolvedAnswer, ApprovalServiceError> {
        let answer = ResolveAnswer::of(request);
        let approval_request_id = answer.approval_request_id;
        let stored = self
            .read_request(approval_request_id)
            .await?
            .ok_or_else(|| approval_not_found(approval_request_id))?;
        if stored.state != ApprovalState::Pending {
            return Ok(ResolvedAnswer {
                response: answer_settled(&stored, &answer)?,
                request: stored,
                is_orphaned: false,
            });
        }
        let effective_scope = answer
            .effective_scope
            .cloned()
            .unwrap_or_else(|| stored.scope.clone());
        refuse_unfit_answer(&stored, &answer, &effective_scope)?;
        let resolved_at = WireInstant::now();
        let payload = ApprovalResolvedPayload {
            session_id: stored.session_id,
            holder: stored.holder.clone(),
            approval_request_id,
            category: stored.category,
            scope: stored.scope.clone(),
            effective_scope: effective_scope.clone(),
            device_id: device_id.clone(),
            client_resolution_id: answer.client_resolution_id.clone(),
            remembered_scope: answer.remembered_scope.cloned(),
            edited_action: answer.edited_action.cloned(),
            decline_reason: answer.decline_reason.cloned(),
        };
        let resolution = InsertedApprovalResolution {
            approval_request_id,
            device_id,
            client_resolution_id: answer.client_resolution_id.clone(),
            decision: answer.decision,
            effective_scope,
            asked_scope: answer.remembered_scope.cloned(),
            edited_action: answer.edited_action.cloned(),
            decline_reason: answer.decline_reason.cloned(),
            resolved_at: resolved_at.clone(),
        };
        let settlement = ApprovalSettlement::Decided(answer.decision);
        let run_id = match stored.holder.clone() {
            ApprovalHolder::Run { run_id } => run_id,
            ApprovalHolder::Wait {
                workflow_run_id,
                wait_id,
                node_id,
            } => {
                let wait_answer = ApprovalWaitAnswer::of(
                    &stored,
                    workflow_run_id,
                    wait_id,
                    node_id,
                    payload,
                    &resolution,
                );
                return self
                    .hand_wait_answer(stored, &answer, wait_answer, resolution)
                    .await;
            }
        };
        let raised_key = RaisedCardKey {
            run_id,
            approval_request_id,
        };
        let is_orphaned = match &stored.ask_id {
            Some(ask_id) => !is_ask_held(run_id, ask_id),
            None => !self.raised_cards.is_armed(&raised_key),
        };
        let mut transactional_prelude = vec![
            settle_pending_statement(&approval_request_id, settlement, &resolved_at),
            run_live_statement(&stored.session_id, &run_id),
            insert_resolution_statement(&resolution),
        ];
        if is_orphaned {
            transactional_prelude.push(insert_orphaned_answer_statement(
                &stored,
                run_id,
                &resolved_at,
            ));
        }
        let draft = SessionEventDraft::new(payload, resolved_event(answer.decision))?;
        let linkage = SessionEventLinkage {
            occurred_at: Some(resolved_at.clone()),
            transactional_prelude,
            ..SessionEventLinkage::default()
        };
        if let Err(failure) = self.events.append(draft, linkage).await {
            return match failure.refused_statement_index() {
                // Settled between the read and the write; the ask reads back while its session
                // stands.
                Some(PENDING_GUARD_INDEX) => self.read_back_settled(&answer).await,
                // The run ended before its end canceled the ask, which that cancel is about to do.
                Some(ANSWER_RUN_LIVE_GUARD_INDEX) => {
                    Err(approval_request_canceled(approval_request_id).into())
                }
                Some(_) | None => Err(refusal_of_failed_write(failure).into()),
            };
        }
        // A call of the app's tools made again since the keep was decided waits on the card, and
        // the settlement below reaches it, so the orphaned answer's call hand is its.
        let call_claim =
            if is_orphaned && stored.ask_id.is_none() && self.raised_cards.is_armed(&raised_key) {
                Some(self.orphaned_answers.claim_call(approval_request_id).await)
            } else {
                None
            };
        self.raised_cards.settle_all(
            &raised_key,
            match answer.decision {
                ApprovalDecision::Approved => RaisedRequestSettlement::Approved,
                ApprovalDecision::Rejected => RaisedRequestSettlement::Rejected {
                    decline_reason: resolution.decline_reason.clone(),
                    resolved_at: resolved_at.clone(),
                },
            },
        );
        if is_orphaned {
            self.run_holds.reconcile_or_log(run_id).await;
        } else {
            self.run_holds.spawn_reconcile(run_id);
        }
        if answer.decision == ApprovalDecision::Approved {
            self.mark_working_folder_stale(stored.session_id).await;
        }
        // The answer is committed and handed to its waiter, so a claim that failed is logged:
        // its mark left open, the call made again may take the answer once more.
        if let Some(Err(failure)) = call_claim {
            tracing::warn!(
                approval_request_id = %approval_request_id,
                error = &failure as &(dyn Error + 'static),
                "the call hand of an orphaned answer could not be claimed"
            );
        }
        Ok(resolved_answer_of(stored, resolution, is_orphaned))
    }

    /// What an answer that lost to another settlement of its ask between the read and the write
    /// is answered: the saved answer when it is the same one sent again, else the refusal naming
    /// how the ask settled; the ask reads back while its session stands.
    pub(crate) async fn read_back_settled(
        &self,
        answer: &ResolveAnswer<'_>,
    ) -> Result<ResolvedAnswer, ApprovalServiceError> {
        let settled = self
            .read_request(answer.approval_request_id)
            .await?
            .ok_or_else(|| approval_not_found(answer.approval_request_id))?;
        Ok(ResolvedAnswer {
            response: answer_settled(&settled, answer)?,
            request: settled,
            is_orphaned: false,
        })
    }

    /// Cancels one ask its provider took back before anyone answered it; an ask already settled
    /// keeps how it settled. Fails as the read fails and when the cancel was not kept.
    pub(crate) async fn withdraw(
        &self,
        approval_request_id: ApprovalRequestId,
    ) -> Result<(), ApprovalServiceError> {
        let Some(stored) = self.read_request(approval_request_id).await? else {
            return Ok(());
        };
        if stored.state == ApprovalState::Pending
            && self.cancel(&stored, None).await?
            && let Some(run_id) = stored.holder.run_id()
        {
            self.run_holds.spawn_reconcile(run_id);
        }
        Ok(())
    }

    /// Takes the correction an approved card carries for the provider ask that carries it out:
    /// true once, for an ask on the card's own run whose command or path is exactly the corrected
    /// one, and false for any other ask, a card that is not approved or names no correction, and a
    /// correction already carried out, which the guarded write refuses even across a restart.
    /// Refuses `approval.persistenceUnavailable` when the use could not be recorded.
    pub(crate) async fn take_correction(
        &self,
        approval_request_id: ApprovalRequestId,
        run_id: RunId,
        corrected_subject: &str,
    ) -> Result<bool, ApprovalServiceError> {
        let Some(stored) = self.read_request(approval_request_id).await? else {
            return Ok(false);
        };
        let is_carried_out_here = stored.state == ApprovalState::Approved
            && stored.holder.run_id() == Some(run_id)
            && stored
                .resolution
                .as_ref()
                .and_then(|resolution| resolution.edited_action.as_ref())
                .is_some_and(|edited_action| edited_action.as_str() == corrected_subject);
        if !is_carried_out_here {
            return Ok(false);
        }
        let correction_use = insert_correction_use_statement(&ApprovalCorrectionUse {
            approval_request_id,
            session_id: stored.session_id,
            used_at: WireInstant::now(),
        });
        match self.writer.write(vec![correction_use]).await {
            Ok(_results) => Ok(true),
            Err(refused) if refused.refused_statement_index().is_some() => Ok(false),
            Err(failure) => Err(approval_persistence_unavailable(failure).into()),
        }
    }

    /// The answers kept while no live call held their card.
    pub fn orphaned_answers(&self) -> &OrphanedAnswers {
        &self.orphaned_answers
    }

    /// Whether `run_id` holds an ask the person has not answered yet. Fails as the read fails.
    pub async fn has_pending_ask(&self, run_id: RunId) -> Result<bool, ApprovalServiceError> {
        let pending = self
            .read(move |reader| reader.list_pending_for_run(&run_id))
            .await?;
        Ok(!pending.is_empty())
    }

    /// Arms a wait on how the run's standing card `approval_request_id` settles, for a call made
    /// again that returns to it, only while no one waits on it, so two calls never take one card;
    /// `None` where a wait is armed already. A settlement before the arm finds no waiter.
    pub(crate) fn arm_unawaited_card(
        &self,
        run_id: RunId,
        approval_request_id: ApprovalRequestId,
    ) -> Option<ArmedWait<RaisedCardKey, RaisedRequestSettlement>> {
        self.raised_cards.arm_unless_armed(RaisedCardKey {
            run_id,
            approval_request_id,
        })
    }

    /// The ask under `approval_request_id`, or `None` when the daemon holds none. Fails as the
    /// read fails.
    pub(crate) async fn read_request(
        &self,
        approval_request_id: ApprovalRequestId,
    ) -> Result<Option<StoredApprovalRequest>, ApprovalServiceError> {
        self.read(move |reader| reader.read_request(&approval_request_id))
            .await
    }

    /// The ask minted for the run's provider ask `ask_id`, or `None` when it has none. Fails as the
    /// read fails.
    pub(crate) async fn read_ask_request(
        &self,
        run_id: RunId,
        ask_id: NonEmptyText,
    ) -> Result<Option<StoredApprovalRequest>, ApprovalServiceError> {
        self.read(move |reader| reader.read_ask_request(&run_id, &ask_id))
            .await
    }

    /// The run's pending asks a call made again may return to, in one read: the oldest that holds
    /// `tool_call_id` where one does, else every one of `input_digest`, oldest first. Fails as the
    /// read fails.
    pub(crate) async fn read_pending_call_requests(
        &self,
        run_id: RunId,
        tool_call_id: Option<ToolCallId>,
        input_digest: Option<Sha256Hex>,
    ) -> Result<Vec<StoredApprovalRequest>, ApprovalServiceError> {
        let mut pending = self
            .read(move |reader| reader.list_pending_for_run(&run_id))
            .await?;
        if let Some(tool_call_id) = tool_call_id
            && let Some(at) = pending
                .iter()
                .position(|stored| stored.tool_call_id.as_ref() == Some(&tool_call_id))
        {
            return Ok(vec![pending.swap_remove(at)]);
        }
        let Some(input_digest) = input_digest else {
            return Ok(Vec::new());
        };
        pending.retain(|stored| stored.input_digest.as_ref() == Some(&input_digest));
        Ok(pending)
    }

    /// Marks the session's working folder stale once an action was allowed, since work the person
    /// has not seen may land there. The allow already stands, so a folder that could not be marked
    /// is logged rather than failing it.
    pub(crate) async fn mark_working_folder_stale(&self, session_id: SessionId) {
        if let Err(error) = self.working_folders.raise_staleness(&session_id).await {
            tracing::warn!(
                %session_id,
                error = &error as &(dyn Error + 'static),
                "approval_working_folder_stale_failed"
            );
        }
    }

    /// Runs `read` over the asks on the read pool, as a short read of a few rows. Fails as the
    /// read fails.
    pub(crate) async fn read<Output: Send + 'static>(
        &self,
        read: impl FnOnce(&ApprovalRequestReader<'_>) -> rusqlite::Result<Output> + Send + 'static,
    ) -> Result<Output, ApprovalServiceError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok::<_, ApprovalServiceError>(read(&ApprovalRequestReader::new(connection))?)
            })
            .await
    }
}

/// The refusal of a failed write: a write the session refused is answered by the session's own
/// code; any other failure means the record could not be kept, so the action it gates does not
/// proceed.
pub(crate) fn refusal_of_failed_write(failure: SessionEventAppendError) -> DomainError {
    match failure {
        SessionEventAppendError::Append(EventAppendError::SessionWriteRefused(refusal)) => {
            refusal.into()
        }
        other @ (SessionEventAppendError::Append(_) | SessionEventAppendError::OccurredAt(_)) => {
            approval_persistence_unavailable(other)
        }
    }
}

/// The answer `resolution` as its ask's resolve answers it: the response, and the ask as the
/// answer settled it with its stored answer.
pub(crate) fn resolved_answer_of(
    stored: StoredApprovalRequest,
    resolution: InsertedApprovalResolution,
    is_orphaned: bool,
) -> ResolvedAnswer {
    let state = ApprovalSettlement::Decided(resolution.decision).state();
    ResolvedAnswer {
        response: ApprovalResolveResponse {
            approval_request_id: stored.approval_request_id,
            state,
            device_id: resolution.device_id.clone(),
            effective_scope: resolution.effective_scope.clone(),
            resolved_at: resolution.resolved_at.clone(),
        },
        request: StoredApprovalRequest {
            state,
            updated_at: resolution.resolved_at.clone(),
            resolution: Some(StoredApprovalResolution {
                device_id: resolution.device_id,
                client_resolution_id: resolution.client_resolution_id,
                decision: resolution.decision,
                effective_scope: resolution.effective_scope,
                remembered_scope: None,
                asked_scope: resolution.asked_scope,
                edited_action: resolution.edited_action,
                decline_reason: resolution.decline_reason,
                resolved_at: resolution.resolved_at,
            }),
            ..stored
        },
        is_orphaned,
    }
}

// What an answer to an ask already settled gets: the saved answer when it is the same one sent
// again, under its client resolution id with its decision, scopes, correction and decline words,
// else the refusal naming how the ask was settled.
fn answer_settled(
    stored: &StoredApprovalRequest,
    answer: &ResolveAnswer<'_>,
) -> Result<ApprovalResolveResponse, DomainError> {
    if stored.state == ApprovalState::Canceled {
        return Err(approval_request_canceled(stored.approval_request_id));
    }
    match &stored.resolution {
        Some(resolution)
            if &resolution.client_resolution_id == answer.client_resolution_id
                && resolution.decision == answer.decision
                && &resolution.effective_scope
                    == answer.effective_scope.unwrap_or(&stored.scope)
                && resolution.asked_scope.as_ref() == answer.remembered_scope
                && resolution.edited_action.as_ref() == answer.edited_action
                && resolution.decline_reason.as_ref() == answer.decline_reason =>
        {
            Ok(ApprovalResolveResponse {
                approval_request_id: stored.approval_request_id,
                state: ApprovalSettlement::Decided(resolution.decision).state(),
                device_id: resolution.device_id.clone(),
                effective_scope: resolution.effective_scope.clone(),
                resolved_at: resolution.resolved_at.clone(),
            })
        }
        Some(_) | None => Err(approval_already_resolved(stored.approval_request_id)),
    }
}

// Refuses an answer its ask cannot take. A free-text scope has no order a narrowing could be
// checked against, so only the ask's own is taken. A correction is taken only where the ask offers
// one, and never beside a rule. A rule names exactly the subject the card showed, only where the
// ask offers one, and a block only on a network request.
fn refuse_unfit_answer(
    stored: &StoredApprovalRequest,
    answer: &ResolveAnswer<'_>,
    effective_scope: &ApprovalScope,
) -> Result<(), DomainError> {
    let refuse = |reason| {
        Err(approval_resolution_invalid(
            stored.approval_request_id,
            reason,
        ))
    };
    if effective_scope != &stored.scope {
        return refuse(ApprovalResolutionInvalidReason::EffectiveScopeBroader);
    }
    if answer.edited_action.is_some() && !stored.resource_descriptor.editable {
        return refuse(ApprovalResolutionInvalidReason::EditNotOffered);
    }
    let Some(rule) = answer.remembered_scope else {
        return Ok(());
    };
    if answer.edited_action.is_some() {
        return refuse(ApprovalResolutionInvalidReason::EditWithRule);
    }
    if rule.sense == RememberedRuleSense::Block
        && stored.category != ApprovalCategory::NetworkAccess
    {
        return refuse(ApprovalResolutionInvalidReason::BlockOutsideNetworkAccess);
    }
    if !stored.standing_allow_offered
        || (rule.kind == RememberedScopeKind::Project && !stored.project_scope_offered)
    {
        return refuse(ApprovalResolutionInvalidReason::RuleNotOffered);
    }
    if rule.pattern.as_str() != stored.resource_descriptor.subject.as_str() {
        return refuse(ApprovalResolutionInvalidReason::SubjectMismatch);
    }
    Ok(())
}

#[cfg(any(test, feature = "test-support"))]
pub mod test_fixture;
#[cfg(test)]
pub(crate) mod tests;
