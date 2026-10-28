//! The person's session group verbs: `session.group.create`, `session.group.move`,
//! `session.group.rename` and `session.group.ungroup`. A client reads every change from the live
//! sessions list.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::session::groups::{
    SessionGroupCreate, SessionGroupCreateRequest, SessionGroupMove, SessionGroupMoveRequest,
    SessionGroupRename, SessionGroupRenameRequest, SessionGroupUngroup, SessionGroupUngroupRequest,
};
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_session::groups::service::SessionGroupService;

/// Registers the four group verbs. A verb refused `session.notFound`, `session.group.refused` or
/// `session.group.nameTaken` keeps nothing. Fails the start when a verb is already registered.
pub(crate) fn register_session_groups(
    registry: &mut MethodRegistryBuilder,
    groups: Arc<SessionGroupService>,
) -> Result<(), RegistrationError> {
    let creating = Arc::clone(&groups);
    registry.register::<SessionGroupCreate, _>(
        move |request: SessionGroupCreateRequest, _context: HandlerContext| {
            let groups = Arc::clone(&creating);
            async move { Ok(groups.create(&request).await?) }.boxed()
        },
    )?;
    let moving = Arc::clone(&groups);
    registry.register::<SessionGroupMove, _>(
        move |request: SessionGroupMoveRequest, _context: HandlerContext| {
            let groups = Arc::clone(&moving);
            async move {
                groups.move_session(&request).await?;
                Ok(EmptyPayload {})
            }
            .boxed()
        },
    )?;
    let renaming = Arc::clone(&groups);
    registry.register::<SessionGroupRename, _>(
        move |request: SessionGroupRenameRequest, _context: HandlerContext| {
            let groups = Arc::clone(&renaming);
            async move {
                groups.rename(&request).await?;
                Ok(EmptyPayload {})
            }
            .boxed()
        },
    )?;
    registry.register::<SessionGroupUngroup, _>(
        move |request: SessionGroupUngroupRequest, _context: HandlerContext| {
            let groups = Arc::clone(&groups);
            async move {
                groups.ungroup(&request).await?;
                Ok(EmptyPayload {})
            }
            .boxed()
        },
    )
}
