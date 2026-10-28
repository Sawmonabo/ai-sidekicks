//! `artifact.list`: a session's plans and the files and folders its chat wrote, each listed once
//! with its newest manifest.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_artifact::list::list_artifacts;
use sidekicks_contracts::artifacts::methods::ArtifactList;
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;

/// Registers `artifact.list`, read through `reads`. Fails the start when the method is already
/// registered.
pub(crate) fn register_artifact_list(
    registry: &mut MethodRegistryBuilder,
    reads: Arc<DatabaseReadPool>,
) -> Result<(), RegistrationError> {
    registry.register::<ArtifactList, _>(move |request, _context: HandlerContext| {
        let reads = Arc::clone(&reads);
        async move { Ok(list_artifacts(&reads, request.session_id).await?) }.boxed()
    })
}
