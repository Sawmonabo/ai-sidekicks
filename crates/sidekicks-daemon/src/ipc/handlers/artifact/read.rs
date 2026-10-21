//! `artifact.read`: one artifact's version in view, picked within its path's group, with as much
//! of its payload as the request picks.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::artifacts::methods::ArtifactRead;

use crate::artifacts::payload_store::PayloadStore;
use crate::artifacts::read::read_artifact;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};

/// Registers `artifact.read`, read through `reads` from `payloads`. Fails the start when the
/// method is already registered.
pub(crate) fn register_artifact_read(
    registry: &mut MethodRegistryBuilder,
    reads: Arc<DatabaseReadPool>,
    payloads: Arc<PayloadStore>,
) -> Result<(), RegistrationError> {
    registry.register::<ArtifactRead, _>(move |request, _context: HandlerContext| {
        let reads = Arc::clone(&reads);
        let payloads = Arc::clone(&payloads);
        async move { Ok(read_artifact(&reads, &payloads, request).await?) }.boxed()
    })
}
