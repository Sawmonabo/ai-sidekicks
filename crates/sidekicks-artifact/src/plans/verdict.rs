//! A plan's verdict: the person keeps planning, builds the plan in its own session or hands it to a
//! fresh one. A verdict settles a plan only while it waits, in one write that takes the caller's
//! own statements after the settle and the verdict's event last; a plan no longer waiting is read
//! back, so the caller answers its stored state. Each plan has a lock, held by every step that
//! reads the plan's state and acts on it before the verdict settles, so two verdicts never both
//! act.
//!
//! A hand-off also writes the plan's text again into the fresh session, under the same stored
//! bytes and naming the same plan, at most once per fresh session; that copy lists there as
//! accepted.

use std::borrow::Cow;
use std::sync::Arc;

use bytes::Bytes as ByteBuffer;
use rusqlite::{OptionalExtension as _, named_params};
use sidekicks_contracts::artifacts::manifest::ArtifactType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::plan::{
    PlanAcceptedPayload, PlanHandedOffPayload, PlanId, PlanKeptPayload, PlanState,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::record::JsonRecord;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};

use crate::manifest_write::{
    PublishedManifestWrite, manifest_write_failure, published_manifest_write,
};
use crate::plans::service::{PLAN_MEDIA_TYPE, PlanError};
use crate::plans::store::settle_verdict_statement;
use crate::publish::{ArtifactPublishService, DaemonPayload};

#[cfg(test)]
mod tests;

/// The index of a settle's write at which the caller's own statements begin, after the settle's
/// guarded update; a refusal at or past it is the caller's statement's.
pub const FIRST_CALLER_STATEMENT_INDEX: usize = 1;

// One plan's row, by its id.
const PLAN_BY_ID_SQL: &str = "SELECT session_id, state, holds_request, fresh_session_id, title
  FROM plans WHERE id = @planId";

// Holds a seed copy's write to one manifest of its plan in its fresh session: the one the write
// itself inserts, so a second copy refuses here and leaves the first.
const ONE_SEED_PER_SESSION_SQL: &str = "SELECT 1 WHERE (
    SELECT count(*) FROM artifact_manifests WHERE session_id = @sessionId AND plan_id = @planId
  ) = 1";

/// A plan's row as a verdict reads it back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredPlan {
    /// The planning session.
    pub session_id: SessionId,
    /// The plan's state word.
    pub state: PlanState,
    /// Whether a held provider request waits on the verdict.
    pub holds_request: bool,
    /// The fresh session the plan was handed to, set exactly while it reads handed off.
    pub fresh_session_id: Option<SessionId>,
    /// The plan's first heading.
    pub title: String,
}

/// What a person decided for a waiting plan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanSettleVerdict {
    /// Keep planning: the plan settles open with `plan.kept`.
    Keep,
    /// Build it in its own session: the plan settles accepted with `plan.accepted`.
    Build,
    /// Build it in a fresh session: the plan settles handed off to it with `plan.handedOff`.
    HandOff {
        /// The fresh session, under the id the verdict fixed.
        fresh_session_id: SessionId,
    },
}

/// How a settle ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PlanSettleOutcome {
    /// The verdict, the caller's statements and the event were written.
    Settled,
    /// The plan no longer waited, so nothing was written; its row as it now stands.
    Unchanged(StoredPlan),
    /// No plan has the id, so nothing was written.
    Gone,
}

/// Settles plans' verdicts under each plan's lock and writes a hand-off's seed copy.
pub struct PlanVerdicts {
    appender: Arc<SessionEventAppender>,
    reads: Arc<DatabaseReadPool>,
    publisher: Arc<ArtifactPublishService>,
    plan_locks: KeyedLock<PlanId>,
}

impl PlanVerdicts {
    /// Verdicts writing through `appender`, reading the plan rows through `reads` and keeping a
    /// seed copy through `publisher`.
    pub fn new(
        appender: Arc<SessionEventAppender>,
        reads: Arc<DatabaseReadPool>,
        publisher: Arc<ArtifactPublishService>,
    ) -> Self {
        Self {
            appender,
            reads,
            publisher,
            plan_locks: KeyedLock::new(),
        }
    }

    /// The per-plan lock a verdict, its hand-off's steps and the hand-off's end each hold, one
    /// holder per plan at a time; code a holder calls takes the hold by reference.
    pub fn plan_lock(&self) -> &KeyedLock<PlanId> {
        &self.plan_locks
    }

    /// The row of `plan_id`, or `None` when no plan has it. Fails as the read fails, or when a
    /// stored column does not read as its type.
    pub async fn read_plan(&self, plan_id: PlanId) -> Result<Option<StoredPlan>, PlanError> {
        self.reads
            .read(ReadLength::Short, move |reader| {
                let stored = reader
                    .prepare_cached(PLAN_BY_ID_SQL)?
                    .query_row(
                        named_params! { "@planId": plan_id.text().as_str() },
                        |row| {
                            Ok(StoredPlan {
                                session_id: text_column(row, 0, |text| SessionId::new(&text))?,
                                state: text_column(row, 1, closed_word)?,
                                holds_request: row.get(2)?,
                                fresh_session_id: optional_text_column(row, 3, |text| {
                                    SessionId::new(&text)
                                })?,
                                title: row.get(4)?,
                            })
                        },
                    )
                    .optional()?;
                Ok::<_, PlanError>(stored)
            })
            .await
    }

    /// Settles the plan `hold` holds, of the planning session `session_id`, with `verdict` from
    /// `device_id`, in one write: the guarded settle at index 0, then `caller_statements`, then the
    /// verdict's event, which records the instant the settle stores. A plan no longer waiting
    /// answers [`PlanSettleOutcome::Unchanged`] and an unknown one [`PlanSettleOutcome::Gone`],
    /// nothing written; any other refusal fails [`PlanError::Append`], whose refused index the
    /// caller reads against [`FIRST_CALLER_STATEMENT_INDEX`].
    pub async fn settle(
        &self,
        hold: &KeyHold<'_, PlanId>,
        session_id: SessionId,
        verdict: PlanSettleVerdict,
        device_id: DeviceId,
        caller_statements: Vec<WriteStatement>,
    ) -> Result<PlanSettleOutcome, PlanError> {
        let plan_id = *hold.key();
        let (state, fresh_session_id, event) = match verdict {
            PlanSettleVerdict::Keep => (
                PlanState::Open,
                None,
                SessionEvent::PlanKept(PlanKeptPayload {
                    plan_id,
                    session_id,
                    device_id: device_id.clone(),
                }),
            ),
            PlanSettleVerdict::Build => (
                PlanState::Accepted,
                None,
                SessionEvent::PlanAccepted(PlanAcceptedPayload {
                    plan_id,
                    session_id,
                    device_id: device_id.clone(),
                }),
            ),
            PlanSettleVerdict::HandOff { fresh_session_id } => (
                PlanState::HandedOff,
                Some(fresh_session_id),
                SessionEvent::PlanHandedOff(PlanHandedOffPayload {
                    plan_id,
                    session_id,
                    fresh_session_id,
                    device_id: device_id.clone(),
                }),
            ),
        };
        let event = SessionEventDraft::of_session(session_id, &event)
            .expect("a plan verdict's payload names only checked ids");
        let resolved_at = WireInstant::now();
        let mut transactional_prelude = Vec::with_capacity(1 + caller_statements.len());
        transactional_prelude.push(settle_verdict_statement(
            &plan_id,
            state,
            fresh_session_id.as_ref(),
            &device_id,
            &resolved_at,
        ));
        transactional_prelude.extend(caller_statements);
        let appended = self
            .appender
            .append(
                event,
                SessionEventLinkage {
                    occurred_at: Some(resolved_at),
                    transactional_prelude,
                    ..SessionEventLinkage::default()
                },
            )
            .await;
        match appended {
            Ok(_receipt) => Ok(PlanSettleOutcome::Settled),
            // Under the hold nothing puts a plan back to waiting, so the row read is final.
            Err(failure) if failure.refused_statement_index() == Some(0) => {
                Ok(match self.read_plan(plan_id).await? {
                    Some(stored) => PlanSettleOutcome::Unchanged(stored),
                    None => PlanSettleOutcome::Gone,
                })
            }
            Err(failure) => Err(failure.into()),
        }
    }

    /// Writes `plan_id`'s text into `fresh_session_id` as a manifest naming the plan, with its
    /// `artifact.published`, unless the session already holds one, which is left as it is. `text`
    /// is the plan's own artifact's bytes, already stored under the planning session's manifest,
    /// so a refused copy never leaves bytes no manifest names. Fails with `session.notFound` once
    /// the fresh session is gone, and as the spool, the store or the write fails.
    pub async fn write_seed_manifest(
        &self,
        fresh_session_id: SessionId,
        plan_id: PlanId,
        text: String,
    ) -> Result<(), PlanError> {
        let payload = DaemonPayload {
            session_id: fresh_session_id,
            run_id: None,
            artifact_type: ArtifactType::Summary,
            payload: ByteBuffer::from(text.into_bytes()),
            media_type: PLAN_MEDIA_TYPE.to_owned(),
            metadata: JsonRecord::default(),
        };
        let appender = Arc::clone(&self.appender);
        self.publisher
            .store_daemon_payload(payload, move |mut manifest| async move {
                manifest.plan_id = Some(plan_id);
                let created_at = manifest.created_at.clone();
                let PublishedManifestWrite {
                    mut statements,
                    event,
                    manifest,
                } = published_manifest_write(manifest);
                // Last, so the session and run checks keep the indexes the failure reads.
                let guard_index = statements.len();
                statements.push(one_seed_per_session_statement(fresh_session_id, plan_id));
                let appended = appender
                    .append(
                        event,
                        SessionEventLinkage {
                            occurred_at: Some(created_at),
                            transactional_prelude: statements,
                            ..SessionEventLinkage::default()
                        },
                    )
                    .await;
                match appended {
                    Ok(_receipt) => Ok(()),
                    Err(failure) if failure.refused_statement_index() == Some(guard_index) => {
                        Ok(())
                    }
                    Err(failure) => Err(manifest_write_failure(&manifest, failure)),
                }
            })
            .await
            .map_err(PlanError::from)
    }
}

// The guard that leaves `fresh_session_id` one manifest of `plan_id`.
fn one_seed_per_session_statement(fresh_session_id: SessionId, plan_id: PlanId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(ONE_SEED_PER_SESSION_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@sessionId", fresh_session_id.text().as_str()),
            text_binding("@planId", plan_id.text().as_str()),
        ]),
        expected_row_count: Some(1),
    }
}
