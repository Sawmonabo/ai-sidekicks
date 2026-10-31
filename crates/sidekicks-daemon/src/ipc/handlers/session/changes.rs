//! A person's changes to one session: `session.rename`; `session.archive`, `session.reactivate`
//! and `session.close`, its moves between the live list, the archived ones and closed; and
//! `session.pin`, `session.unpin`, `session.mute` and `session.unmute`, the marks the daemon holds
//! for every device. A change that finds the session already as it asks appends nothing.

use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::method::Method;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::{
    SessionArchive, SessionClose, SessionMute, SessionPin, SessionReactivate, SessionRename,
    SessionRenameRequest, SessionTargetRequest, SessionUnmute, SessionUnpin,
};
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_session::changes::{SessionChangeError, SessionChanges};

/// One change to the session a request names, run on its own `SessionChanges` handle.
type SessionTargetChange =
    fn(Arc<SessionChanges>, SessionId) -> BoxFuture<'static, Result<(), SessionChangeError>>;

/// Registers the eight session change verbs, each refusing by the codes its method lists and
/// keeping nothing when refused. Fails the start when a verb is already registered.
pub(crate) fn register_session_changes(
    registry: &mut MethodRegistryBuilder,
    changes: Arc<SessionChanges>,
) -> Result<(), RegistrationError> {
    let renaming = Arc::clone(&changes);
    registry.register::<SessionRename, _>(
        move |request: SessionRenameRequest, _context: HandlerContext| {
            let changes = Arc::clone(&renaming);
            async move { Ok(changes.rename(request).await?) }.boxed()
        },
    )?;
    register_target_change::<SessionArchive>(
        registry,
        Arc::clone(&changes),
        |changes, session_id| async move { changes.archive(session_id).await }.boxed(),
    )?;
    register_target_change::<SessionReactivate>(
        registry,
        Arc::clone(&changes),
        |changes, session_id| async move { changes.reactivate(session_id).await }.boxed(),
    )?;
    register_target_change::<SessionClose>(
        registry,
        Arc::clone(&changes),
        |changes, session_id| async move { changes.close(session_id).await }.boxed(),
    )?;
    register_target_change::<SessionPin>(registry, Arc::clone(&changes), |changes, session_id| {
        async move { changes.pin(session_id).await }.boxed()
    })?;
    register_target_change::<SessionUnpin>(
        registry,
        Arc::clone(&changes),
        |changes, session_id| async move { changes.unpin(session_id).await }.boxed(),
    )?;
    register_target_change::<SessionMute>(
        registry,
        Arc::clone(&changes),
        |changes, session_id| async move { changes.mute(session_id).await }.boxed(),
    )?;
    register_target_change::<SessionUnmute>(registry, changes, |changes, session_id| {
        async move { changes.unmute(session_id).await }.boxed()
    })
}

/// Registers `M`, a verb on one session that answers `{}` once `change` has run on it. Fails the
/// start when `M` is already registered.
fn register_target_change<M>(
    registry: &mut MethodRegistryBuilder,
    changes: Arc<SessionChanges>,
    change: SessionTargetChange,
) -> Result<(), RegistrationError>
where
    M: Method<Params = SessionTargetRequest, Result = EmptyPayload> + 'static,
{
    registry.register::<M, _>(
        move |request: SessionTargetRequest, _context: HandlerContext| {
            let changing = change(Arc::clone(&changes), request.session_id);
            async move {
                changing.await?;
                Ok(EmptyPayload {})
            }
            .boxed()
        },
    )
}
