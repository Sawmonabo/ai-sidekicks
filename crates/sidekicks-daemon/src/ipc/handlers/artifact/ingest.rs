//! The three calls that stream a caller's file into a session's artifacts: `artifact.ingest.start`
//! opens a stream, `artifact.ingest.write` appends one numbered chunk, and
//! `artifact.ingest.complete` checks the spooled bytes and writes the file's manifest, attributed
//! to the calling device.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_artifact::ingest::service::ArtifactIngestService;
use sidekicks_contracts::artifacts::methods::{
    ArtifactIngestComplete, ArtifactIngestStart, ArtifactIngestWrite,
};
use sidekicks_contracts::method::Method as _;
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};

/// Registers the three ingest calls, answered by `ingest`. A completion on a connection that
/// carries no device is a fault in the daemon, answered as an internal error, since every artifact
/// a request makes names its device. Fails the start when a method is already registered.
pub(crate) fn register_artifact_ingest(
    registry: &mut MethodRegistryBuilder,
    ingest: Arc<ArtifactIngestService>,
) -> Result<(), RegistrationError> {
    let starting = Arc::clone(&ingest);
    registry.register::<ArtifactIngestStart, _>(move |request, _context: HandlerContext| {
        let ingest = Arc::clone(&starting);
        async move { Ok(ingest.start(request).await?) }.boxed()
    })?;
    let writing = Arc::clone(&ingest);
    registry.register::<ArtifactIngestWrite, _>(move |request, _context: HandlerContext| {
        let ingest = Arc::clone(&writing);
        async move { Ok(ingest.write(request).await?) }.boxed()
    })?;
    let completing = ingest;
    registry.register::<ArtifactIngestComplete, _>(move |request, context: HandlerContext| {
        let ingest = Arc::clone(&completing);
        async move {
            let created_by = context.calling_device(ArtifactIngestComplete::DESCRIPTOR.method)?;
            Ok(ingest.complete(request, created_by).await?)
        }
        .boxed()
    })
}
