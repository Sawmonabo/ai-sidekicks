//! Workspace and mount events: the one seam every workspace state transition appends its event
//! through, for `workspace.preparing`, `workspace.prepared`, `workspace.rootLost` and
//! `workspace.archived` (which also names the mount whose detach caused it), and the
//! `repoMount.health.changed` a session on a mount hears when the mount's health changes. A mount's
//! attach and detach are project changes, not session events, so nothing here records them.
//!
//! No caller gives a state: each event sets the one state it names, so a `workspace.prepared`
//! carrying `archived` cannot be written.

use std::sync::Arc;

use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::repo::mount::{
    LifecycleActor, RepoMountHealth, RepoMountHealthChangedPayload, RepoMountId, WorkspaceId,
    WorkspaceLifecyclePayload, WorkspaceState,
};
use sidekicks_contracts::session::id::SessionId;

use sidekicks_store::events::log_service::{EventLogAppendReceipt, EventLogService};
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventEmitError, SessionEventLinkage,
};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;

/// What every workspace event names: the session whose log takes it, the workspace, the mount when
/// the event names one, and who acted.
#[derive(Clone, Debug)]
pub(crate) struct EmitWorkspaceEventInput {
    /// The session whose log takes the event, written into both envelope and payload.
    pub(crate) session_id: SessionId,
    /// The workspace the event is about.
    pub(crate) workspace_id: WorkspaceId,
    /// The workspace's mount, set on `workspace.preparing` and on a detach's `workspace.archived`,
    /// so a reader knowing only the mount can place the event.
    pub(crate) repo_mount_id: Option<RepoMountId>,
    /// The person's or agent's id that acted; `None` when the daemon did.
    pub(crate) actor: Option<LifecycleActor>,
}

/// Appends workspace lifecycle and mount health events, one per call. Each emit returns the
/// receipt carrying the sequence the append assigned.
pub struct WorkspaceEventEmitter {
    appender: SessionEventAppender,
}

impl WorkspaceEventEmitter {
    /// An emitter appending to `event_log` at the session events' envelope version.
    pub fn new(event_log: Arc<EventLogService>) -> Self {
        Self {
            appender: SessionEventAppender::new(event_log, SESSION_EVENT_VERSION.clone()),
        }
    }

    /// Appends `workspace.preparing`: the workspace's preparation began. Fails as
    /// [`SessionEventEmitError`] says.
    pub(crate) async fn emit_workspace_preparing(
        &self,
        input: EmitWorkspaceEventInput,
        linkage: SessionEventLinkage,
    ) -> Result<EventLogAppendReceipt, SessionEventEmitError> {
        self.append_workspace_event(WorkspaceTransition::Preparing, input, linkage)
            .await
    }

    /// Appends `workspace.prepared`: the workspace is ready for runs. Fails as
    /// [`SessionEventEmitError`] says.
    pub(crate) async fn emit_workspace_prepared(
        &self,
        input: EmitWorkspaceEventInput,
        linkage: SessionEventLinkage,
    ) -> Result<EventLogAppendReceipt, SessionEventEmitError> {
        self.append_workspace_event(WorkspaceTransition::Prepared, input, linkage)
            .await
    }

    /// Appends `workspace.rootLost`: the workspace's working root became unavailable, and it needs
    /// preparing again before further use. Fails as [`SessionEventEmitError`] says.
    pub(crate) async fn emit_workspace_root_lost(
        &self,
        input: EmitWorkspaceEventInput,
        linkage: SessionEventLinkage,
    ) -> Result<EventLogAppendReceipt, SessionEventEmitError> {
        self.append_workspace_event(WorkspaceTransition::RootLost, input, linkage)
            .await
    }

    /// Appends `workspace.archived`: the workspace reached its terminal state; the input names the
    /// mount when the archival is a detach's. Fails as [`SessionEventEmitError`] says.
    pub(crate) async fn emit_workspace_archived(
        &self,
        input: EmitWorkspaceEventInput,
        linkage: SessionEventLinkage,
    ) -> Result<EventLogAppendReceipt, SessionEventEmitError> {
        self.append_workspace_event(WorkspaceTransition::Archived, input, linkage)
            .await
    }

    /// Appends `repoMount.health.changed` on `session_id`'s log: the mount `repo_mount_id` now
    /// reads `health`. The payload names no session, so it is given beside it. Fails as
    /// [`SessionEventEmitError`] says.
    pub(crate) async fn emit_mount_health_changed(
        &self,
        session_id: SessionId,
        repo_mount_id: RepoMountId,
        health: RepoMountHealth,
        linkage: SessionEventLinkage,
    ) -> Result<EventLogAppendReceipt, SessionEventEmitError> {
        let event = SessionEvent::RepoMountHealthChanged(RepoMountHealthChangedPayload {
            repo_mount_id,
            health,
        });
        let draft = SessionEventDraft::of_session(session_id, &event)?;
        Ok(self.appender.append(draft, linkage).await?)
    }

    async fn append_workspace_event(
        &self,
        transition: WorkspaceTransition,
        input: EmitWorkspaceEventInput,
        linkage: SessionEventLinkage,
    ) -> Result<EventLogAppendReceipt, SessionEventEmitError> {
        let payload = WorkspaceLifecyclePayload {
            session_id: input.session_id,
            repo_mount_id: input.repo_mount_id,
            workspace_id: Some(input.workspace_id),
            worktree_id: None,
            state: transition.state(),
            // Written as `null` when the daemon acted.
            actor: Some(input.actor),
        };
        let draft = SessionEventDraft::new(payload, transition.event())?;
        Ok(self.appender.append(draft, linkage).await?)
    }
}

/// The workspace lifecycle events, each naming the one state its workspace is in after it.
#[derive(Clone, Copy, Debug)]
enum WorkspaceTransition {
    Preparing,
    Prepared,
    RootLost,
    Archived,
}

impl WorkspaceTransition {
    fn state(self) -> WorkspaceState {
        match self {
            Self::Preparing => WorkspaceState::Preparing,
            Self::Prepared => WorkspaceState::Ready,
            Self::RootLost => WorkspaceState::RootLost,
            Self::Archived => WorkspaceState::Archived,
        }
    }

    fn event(self) -> fn(WorkspaceLifecyclePayload) -> SessionEvent {
        match self {
            Self::Preparing => SessionEvent::WorkspacePreparing,
            Self::Prepared => SessionEvent::WorkspacePrepared,
            Self::RootLost => SessionEvent::WorkspaceRootLost,
            Self::Archived => SessionEvent::WorkspaceArchived,
        }
    }
}
