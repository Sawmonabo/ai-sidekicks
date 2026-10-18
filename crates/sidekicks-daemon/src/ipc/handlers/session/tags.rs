//! The person's session tag verbs: `session.tag.add`, `session.tag.remove`, and
//! `session.tag.list`, the tags in use that `Add tag` suggests.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::session::tags::{
    SessionTagAdd, SessionTagList, SessionTagRemove, SessionTagRequest,
};

use crate::ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use crate::session::tags::SessionTagService;

/// Registers the three tag verbs over `tags`. A change to a session the daemon does not hold is
/// refused `session.notFound`, keeping nothing. Fails the start when a verb is already
/// registered.
pub(crate) fn register_session_tags(
    registry: &mut MethodRegistryBuilder,
    tags: &Arc<SessionTagService>,
) -> Result<(), RegistrationError> {
    let adding = Arc::clone(tags);
    registry.register::<SessionTagAdd, _>(
        move |request: SessionTagRequest, _context: HandlerContext| {
            let tags = Arc::clone(&adding);
            async move {
                tags.add(&request).await?;
                Ok(EmptyPayload {})
            }
            .boxed()
        },
    )?;
    let removing = Arc::clone(tags);
    registry.register::<SessionTagRemove, _>(
        move |request: SessionTagRequest, _context: HandlerContext| {
            let tags = Arc::clone(&removing);
            async move {
                tags.remove(&request).await?;
                Ok(EmptyPayload {})
            }
            .boxed()
        },
    )?;
    let listing = Arc::clone(tags);
    registry.register::<SessionTagList, _>(move |_request: EmptyPayload, _context| {
        let tags = Arc::clone(&listing);
        async move { Ok(tags.list().await?) }.boxed()
    })
}
