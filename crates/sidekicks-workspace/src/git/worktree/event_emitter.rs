//! Worktree lifecycle events: the one seam every worktree state transition appends its event
//! through, for the five `worktree.*` events, and the two session records a tree's life writes: a
//! session swept back to the repository's checkout, and a session's branch changed.
//!
//! - A transition appends its event in the same write as its row change, which rides in the
//!   linkage's `transactional_prelude`. A tree recorded bound at once, a put-back's, appends
//!   `worktree.created` and `worktree.bound` together in that one write.
//! - The `failed` state appends no worktree event; the owning workspace's `workspace.rootLost`
//!   carries it.
//! - No caller gives a state: each event sets the one state it names, so a `worktree.retired`
//!   carrying `dirty`, or any event carrying `failed`, cannot be written.

use std::sync::Arc;

use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::repo::mount::{LifecycleActor, RepoMountId, WorkspaceId};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::UuidTextForm;
use sidekicks_contracts::worktree::events::{
    SessionBranchChangedPayload, SessionSweptToCheckoutPayload, WorktreeCreatedPayload,
    WorktreeRetiredPayload,
};
use sidekicks_contracts::worktree::lifecycle::{
    RemovedWorktreeId, WorktreeId, WorktreeLifecyclePayload, WorktreeState,
};
use uuid::Uuid;

use sidekicks_store::events::log_service::{EventLogAppendReceipt, EventLogService};
use sidekicks_store::events::session::appender::{
    AppendedPayload, SessionEventAppender, SessionEventDraft, SessionEventDraftError,
    SessionEventEmitError, SessionEventLinkage,
};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;

/// What every worktree event names: the session whose log takes it, the tree, and who acted.
#[derive(Clone, Debug)]
pub(crate) struct EmitWorktreeEventInput {
    /// The session whose log takes the event, written into both envelope and payload.
    pub(crate) session_id: SessionId,
    /// The tree the event is about.
    pub(crate) worktree_id: WorktreeId,
    /// The tree's mount, when the caller names it.
    pub(crate) repo_mount_id: Option<RepoMountId>,
    /// The workspace the tree serves, when the caller has one.
    pub(crate) workspace_id: Option<WorkspaceId>,
    /// The person's or agent's id that acted; `None` when the daemon did.
    pub(crate) actor: Option<LifecycleActor>,
}

/// Appends the five worktree lifecycle events and the two session records a tree's life writes.
/// Each emit returns the receipt carrying the sequence the append assigned.
pub(crate) struct WorktreeEventEmitter {
    appender: SessionEventAppender,
}

impl WorktreeEventEmitter {
    /// An emitter appending to `event_log` at the session events' envelope version.
    pub(crate) fn new(event_log: Arc<EventLogService>) -> Self {
        Self {
            appender: SessionEventAppender::new(event_log, SESSION_EVENT_VERSION.clone()),
        }
    }

    /// Appends `worktree.created`: a `worktrees` row was written in state `creating`, from the
    /// kept copy `restored_from` on a put-back. Fails as [`SessionEventEmitError`] says.
    pub(crate) async fn emit_worktree_created(
        &self,
        input: EmitWorktreeEventInput,
        restored_from: Option<RemovedWorktreeId>,
        linkage: SessionEventLinkage,
    ) -> Result<EventLogAppendReceipt, SessionEventEmitError> {
        self.append(created_draft(input, restored_from)?, linkage)
            .await
    }

    /// Appends `worktree.created` then `worktree.bound` in one write, for a row the prelude writes
    /// and binds together, so neither event commits without the other; the created event follows
    /// any the linkage already puts first. Fails as [`SessionEventEmitError`] says.
    pub(crate) async fn emit_worktree_created_and_bound(
        &self,
        input: EmitWorktreeEventInput,
        restored_from: Option<RemovedWorktreeId>,
        mut linkage: SessionEventLinkage,
    ) -> Result<EventLogAppendReceipt, SessionEventEmitError> {
        let bound = SessionEventDraft::new(
            lifecycle_payload(WorktreeTransition::Bound, input.clone()),
            SessionEvent::WorktreeBound,
        )?;
        linkage
            .preceding_events
            .push(created_draft(input, restored_from)?);
        self.append(bound, linkage).await
    }

    /// Appends `worktree.bound`: the checkout is made and bound as an execution root. Fails as
    /// [`SessionEventEmitError`] says.
    pub(crate) async fn emit_worktree_bound(
        &self,
        input: EmitWorktreeEventInput,
        linkage: SessionEventLinkage,
    ) -> Result<EventLogAppendReceipt, SessionEventEmitError> {
        let payload = lifecycle_payload(WorktreeTransition::Bound, input);
        let draft = SessionEventDraft::new(payload, SessionEvent::WorktreeBound)?;
        self.append(draft, linkage).await
    }

    /// Appends `worktree.dirtied`: uncommitted work was seen in the checkout. Fails as
    /// [`SessionEventEmitError`] says.
    pub(crate) async fn emit_worktree_dirtied(
        &self,
        input: EmitWorktreeEventInput,
        linkage: SessionEventLinkage,
    ) -> Result<EventLogAppendReceipt, SessionEventEmitError> {
        let payload = lifecycle_payload(WorktreeTransition::Dirtied, input);
        let draft = SessionEventDraft::new(payload, SessionEvent::WorktreeDirtied)?;
        self.append(draft, linkage).await
    }

    /// Appends `worktree.merged`: the tree's branch has merged back. Fails as
    /// [`SessionEventEmitError`] says.
    pub(crate) async fn emit_worktree_merged(
        &self,
        input: EmitWorktreeEventInput,
        linkage: SessionEventLinkage,
    ) -> Result<EventLogAppendReceipt, SessionEventEmitError> {
        let payload = lifecycle_payload(WorktreeTransition::Merged, input);
        let draft = SessionEventDraft::new(payload, SessionEvent::WorktreeMerged)?;
        self.append(draft, linkage).await
    }

    /// Appends `worktree.retired`, the terminal state, naming the kept copy `removed_worktree_id`
    /// on a discard. It is appended before any disk change, so it does not mean the folder is
    /// gone. Fails as [`SessionEventEmitError`] says.
    pub(crate) async fn emit_worktree_retired(
        &self,
        input: EmitWorktreeEventInput,
        removed_worktree_id: Option<RemovedWorktreeId>,
        linkage: SessionEventLinkage,
    ) -> Result<EventLogAppendReceipt, SessionEventEmitError> {
        let WorktreeLifecyclePayload {
            session_id,
            repo_mount_id,
            workspace_id,
            worktree_id,
            state,
            actor,
        } = lifecycle_payload(WorktreeTransition::Retired, input);
        let payload = WorktreeRetiredPayload {
            session_id,
            repo_mount_id,
            workspace_id,
            worktree_id,
            state,
            actor,
            removed_worktree_id,
        };
        let draft = SessionEventDraft::new(payload, SessionEvent::WorktreeRetired)?;
        self.append(draft, linkage).await
    }

    /// Appends `session.sweptToCheckout`: a removal moved the session back to the repository's
    /// checkout, or cleared its pending move into the removed tree. Fails as
    /// [`SessionEventEmitError`] says.
    pub(crate) async fn emit_session_swept_to_checkout(
        &self,
        payload: SessionSweptToCheckoutPayload,
        linkage: SessionEventLinkage,
    ) -> Result<EventLogAppendReceipt, SessionEventEmitError> {
        let draft = SessionEventDraft::new(payload, SessionEvent::SessionSweptToCheckout)?;
        self.append(draft, linkage).await
    }

    /// Appends `session.branch.changed`: the branch the session's folder is on changed outside the
    /// app, written back to the session's record. Fails as [`SessionEventEmitError`] says.
    pub(crate) async fn emit_branch_changed(
        &self,
        payload: SessionBranchChangedPayload,
        linkage: SessionEventLinkage,
    ) -> Result<EventLogAppendReceipt, SessionEventEmitError> {
        let draft = SessionEventDraft::new(payload, SessionEvent::SessionBranchChanged)?;
        self.append(draft, linkage).await
    }

    async fn append(
        &self,
        draft: SessionEventDraft,
        linkage: SessionEventLinkage,
    ) -> Result<EventLogAppendReceipt, SessionEventEmitError> {
        Ok(self.appender.append(draft, linkage).await?)
    }
}

/// The worktree events, each naming the one state its tree is in after it.
#[derive(Clone, Copy, Debug)]
enum WorktreeTransition {
    Created,
    Bound,
    Dirtied,
    Merged,
    Retired,
}

impl WorktreeTransition {
    fn state(self) -> WorktreeState {
        match self {
            Self::Created => WorktreeState::Creating,
            Self::Bound => WorktreeState::Ready,
            Self::Dirtied => WorktreeState::Dirty,
            Self::Merged => WorktreeState::Merged,
            Self::Retired => WorktreeState::Retired,
        }
    }
}

// The members every worktree event's payload shares, the actor written as `null` when the daemon
// acted.
fn lifecycle_payload(
    transition: WorktreeTransition,
    input: EmitWorktreeEventInput,
) -> WorktreeLifecyclePayload {
    WorktreeLifecyclePayload {
        session_id: input.session_id,
        repo_mount_id: input.repo_mount_id,
        workspace_id: input.workspace_id,
        worktree_id: Some(UuidTextForm::from(Uuid::from(input.worktree_id))),
        state: transition.state(),
        actor: Some(input.actor),
    }
}

fn created_draft(
    input: EmitWorktreeEventInput,
    restored_from: Option<RemovedWorktreeId>,
) -> Result<SessionEventDraft, SessionEventDraftError> {
    let WorktreeLifecyclePayload {
        session_id,
        repo_mount_id,
        workspace_id,
        worktree_id,
        state,
        actor,
    } = lifecycle_payload(WorktreeTransition::Created, input);
    let payload = WorktreeCreatedPayload {
        session_id,
        repo_mount_id,
        workspace_id,
        worktree_id,
        state,
        actor,
        restored_from,
    };
    SessionEventDraft::new(payload, SessionEvent::WorktreeCreated)
}

impl AppendedPayload for WorktreeLifecyclePayload {
    fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    fn actor(&self) -> Option<&LifecycleActor> {
        self.actor.as_ref().and_then(Option::as_ref)
    }
}

impl AppendedPayload for WorktreeCreatedPayload {
    fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    fn actor(&self) -> Option<&LifecycleActor> {
        self.actor.as_ref().and_then(Option::as_ref)
    }
}

impl AppendedPayload for WorktreeRetiredPayload {
    fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    fn actor(&self) -> Option<&LifecycleActor> {
        self.actor.as_ref().and_then(Option::as_ref)
    }
}

// A session record names no actor: the daemon writes it.
impl AppendedPayload for SessionSweptToCheckoutPayload {
    fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    fn actor(&self) -> Option<&LifecycleActor> {
        None
    }
}

impl AppendedPayload for SessionBranchChangedPayload {
    fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    fn actor(&self) -> Option<&LifecycleActor> {
        None
    }
}
