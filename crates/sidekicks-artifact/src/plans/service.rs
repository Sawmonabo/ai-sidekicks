//! The plan record's intake: a plan a driver hands is kept as a `summary` artifact and recorded
//! `waiting` in one write, `artifact.published` before the `plan.proposed` that names it, which
//! also reopens every older plan of the session still waiting, `superseded`, so one plan waits per
//! session; and a held request the provider let go reopens its plan. No held request outlives the
//! daemon, so at start every plan still waiting on one is reopened the same way. Nothing settles a
//! plan on elapsed time, and no plan moves its run.

use std::error::Error;
use std::sync::Arc;

use bytes::Bytes as ByteBuffer;
use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::artifacts::manifest::ArtifactType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::plan::{PlanHoldEndedReason, PlanId};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::record::JsonRecord;
use sidekicks_provider::port::plan::{PlanPort, ProviderPlan, ProviderPlanHoldEnd};
use sidekicks_session::plan_holds::HeldPlan;
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::session::append_lock::SESSION_APPEND_LOCK;
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};

use crate::manifest_write::{
    PublishedManifestWrite, manifest_write_failure, published_manifest_write,
};
use crate::plans::record::compose_plan_proposed_payload;
use crate::plans::store::{
    hold_end_write, insert_plan_statement, read_held_plans, read_waiting_plans_of_session,
};
use crate::publish::{ArtifactPublishService, DaemonPayload};
use crate::refusals::ArtifactError;
use crate::validation::file_name_metadata;

#[cfg(any(test, feature = "test-support"))]
pub mod test_fixture;
#[cfg(test)]
mod tests;

/// The statements the plans' services prepare on a read connection: the plans of a session still
/// waiting on a held request (`HELD_PLANS_SQL`), those still waiting on a held request or on none
/// (`WAITING_PLANS_OF_SESSION_SQL`), and the verdicts' read of one plan (`PLAN_BY_ID_SQL`).
pub const PLANS_STATEMENT_CAPACITY: usize = 3;

/// The media type a plan's artifact, and its seed copy in a fresh session, is kept under.
pub(crate) const PLAN_MEDIA_TYPE: &str = "text/markdown";

/// Why a plan was not recorded, a hold not ended, a verdict not settled or a seed copy not written;
/// nothing of the failed write is kept.
#[derive(Debug, thiserror::Error)]
pub enum PlanError {
    /// The plan's artifact was not kept, or its write was refused.
    #[error(transparent)]
    Artifact(#[from] ArtifactError),
    /// The write of a lost hold or of a verdict was not kept.
    #[error("a write of a plan's record was not kept")]
    Append(#[from] SessionEventAppendError),
    /// A read of the plan rows did not reach a connection.
    #[error(transparent)]
    Read(#[from] DatabaseReadError),
    /// SQLite refused a read, or a stored column does not read as its type.
    #[error("a read of the plan rows failed")]
    Database(#[from] rusqlite::Error),
    /// Several holds were not ended, every failure kept.
    #[error(transparent)]
    Several(Box<SettleFailures<PlanError>>),
}

/// Records the plans the drivers hand and ends the holds they let go.
pub struct PlansService {
    publisher: Arc<ArtifactPublishService>,
    appender: Arc<SessionEventAppender>,
    reads: Arc<DatabaseReadPool>,
}

impl PlansService {
    /// A service keeping each plan's text through `publisher`, writing through `appender` and
    /// reading the plan rows through `reads`.
    pub fn new(
        publisher: Arc<ArtifactPublishService>,
        appender: Arc<SessionEventAppender>,
        reads: Arc<DatabaseReadPool>,
    ) -> Self {
        Self {
            publisher,
            appender,
            reads,
        }
    }

    /// Records `plan` `waiting`: its artifact, `artifact.published`, the plan's row and
    /// `plan.proposed` naming the artifact, in one write, under the plan id its driver minted. The
    /// same write reopens every older plan of the session still waiting, each with
    /// `plan.hold.ended {superseded}` first, read under the session's append lock; answers the ids
    /// of the plans it reopened. Fails with `session.notFound` or `agent.run.notFound`, as the
    /// store fails, or as the write does, a plan id already recorded among them, and then nothing
    /// of it is written.
    pub async fn take_plan(&self, plan: ProviderPlan) -> Result<Vec<PlanId>, PlanError> {
        let metadata = match &plan.plan_file_path {
            Some(path) => file_name_metadata(path.as_str()),
            None => JsonRecord::default(),
        };
        let payload = DaemonPayload {
            session_id: plan.session_id,
            run_id: Some(plan.run_id),
            artifact_type: ArtifactType::Summary,
            payload: ByteBuffer::from(plan.text.clone().into_bytes()),
            media_type: PLAN_MEDIA_TYPE.to_owned(),
            metadata,
        };
        let appender = Arc::clone(&self.appender);
        let reads = Arc::clone(&self.reads);
        self.publisher
            .store_daemon_payload(payload, move |mut manifest| async move {
                let proposed = compose_plan_proposed_payload(plan, manifest.artifact_id);
                let session_id = proposed.session_id;
                manifest.plan_id = Some(proposed.plan_id);
                let created_at = manifest.created_at.clone();
                let PublishedManifestWrite {
                    mut statements,
                    event: published,
                    manifest,
                } = published_manifest_write(manifest);
                statements.push(insert_plan_statement(&proposed, &created_at));
                let take_statements = statements.len();
                let event = SessionEventDraft::of_session(
                    session_id,
                    &SessionEvent::PlanProposed(proposed),
                )
                .expect("a plan.proposed payload has no check a plan's text can break");
                let hold = SESSION_APPEND_LOCK.acquire(session_id).await;
                let mut is_read_again = false;
                loop {
                    let older = reads
                        .read(ReadLength::Short, move |reader| {
                            Ok::<_, ArtifactError>(read_waiting_plans_of_session(
                                reader,
                                &session_id,
                            )?)
                        })
                        .await?;
                    let mut transactional_prelude = statements.clone();
                    let mut preceding_events = Vec::with_capacity(older.len() + 1);
                    for &plan_id in &older {
                        let (statements, ended) =
                            hold_end_write(session_id, plan_id, PlanHoldEndedReason::Superseded);
                        transactional_prelude.extend(statements);
                        preceding_events.push(ended);
                    }
                    preceding_events.push(published.clone());
                    let appended = appender
                        .append_held(
                            &hold,
                            event.clone(),
                            SessionEventLinkage {
                                occurred_at: Some(created_at.clone()),
                                transactional_prelude,
                                preceding_events,
                                ..SessionEventLinkage::default()
                            },
                        )
                        .await;
                    match appended {
                        Ok(_receipt) => return Ok::<_, ArtifactError>(older),
                        // A write queued before the lock settled an older plan after the read; it
                        // committed before this one, so the read again sees it.
                        Err(failure)
                            if !is_read_again
                                && failure
                                    .refused_statement_index()
                                    .is_some_and(|index| index >= take_statements) =>
                        {
                            is_read_again = true;
                        }
                        Err(failure) => return Err(manifest_write_failure(&manifest, failure)),
                    }
                }
            })
            .await
            .map_err(PlanError::from)
    }

    /// Reopens the plan `hold_end` names, recording `plan.hold.ended` with its reason, when it
    /// still waits on the request its driver held; a plan that holds none, or that is settled,
    /// is left as it is. Fails as the write fails.
    pub async fn end_plan_hold(&self, hold_end: ProviderPlanHoldEnd) -> Result<(), PlanError> {
        self.end_hold(
            HeldPlan {
                plan_id: hold_end.plan_id,
                session_id: hold_end.session_id,
            },
            hold_end.reason,
        )
        .await
    }

    /// Reopens every plan of `session_id` still waiting on a held request, `runEnded`, since no
    /// held request outlives the daemon; a plan that holds none stays waiting. Every plan is tried
    /// before the failures return together.
    pub async fn end_holds_lost_at_restart(&self, session_id: SessionId) -> Result<(), PlanError> {
        let held = self
            .reads
            .read(ReadLength::Short, move |reader| {
                Ok::<_, PlanError>(read_held_plans(reader, Some(&session_id))?)
            })
            .await?;
        let mut outcomes = Vec::with_capacity(held.len());
        for plan in held {
            outcomes.push(self.end_hold(plan, PlanHoldEndedReason::RunEnded).await);
        }
        settle_all(
            outcomes,
            "reopening the plans whose held requests a restart lost",
        )
        .map(drop)
        .map_err(|failures| match failures {
            SettleFailures::One(failure) => failure,
            many @ SettleFailures::Many { .. } => PlanError::Several(Box::new(many)),
        })
    }

    // The hold's end in one write, nothing written when the guard finds the plan holding none.
    async fn end_hold(&self, held: HeldPlan, reason: PlanHoldEndedReason) -> Result<(), PlanError> {
        let (statements, event) = hold_end_write(held.session_id, held.plan_id, reason);
        let appended = self
            .appender
            .append(
                event,
                SessionEventLinkage {
                    transactional_prelude: statements,
                    ..SessionEventLinkage::default()
                },
            )
            .await;
        match appended {
            Ok(_receipt) => Ok(()),
            Err(failure) if failure.refused_statement_index() == Some(0) => Ok(()),
            Err(failure) => Err(failure.into()),
        }
    }
}

impl PlanPort for PlansService {
    fn take_plan(
        &self,
        plan: ProviderPlan,
    ) -> BoxFuture<'_, Result<Vec<PlanId>, Box<dyn Error + Send + Sync>>> {
        PlansService::take_plan(self, plan)
            .map(|taken| taken.map_err(Into::into))
            .boxed()
    }

    fn end_plan_hold(
        &self,
        hold_end: ProviderPlanHoldEnd,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        PlansService::end_plan_hold(self, hold_end)
            .map(|ended| ended.map_err(Into::into))
            .boxed()
    }
}
