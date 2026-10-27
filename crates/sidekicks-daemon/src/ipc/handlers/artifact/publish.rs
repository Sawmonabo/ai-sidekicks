//! `artifact.publish`: publishes an artifact from a payload a client sends whole, attributed to the
//! calling device. The payload crossed into the daemon, so it runs the ingest pipeline, and a file
//! is refused in favor of the ingest calls.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::artifacts::methods::ArtifactPublish;
use sidekicks_contracts::method::Method as _;

use sidekicks_artifact::publish::{ArtifactPublishService, PublishOrigin};
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};

/// Registers `artifact.publish`, answered by `publisher`. A call on a connection that carries no
/// device is a fault in the daemon, answered as an internal error. Fails the start when the method
/// is already registered.
pub(crate) fn register_artifact_publish(
    registry: &mut MethodRegistryBuilder,
    publisher: Arc<ArtifactPublishService>,
) -> Result<(), RegistrationError> {
    registry.register::<ArtifactPublish, _>(move |request, context: HandlerContext| {
        let publisher = Arc::clone(&publisher);
        async move {
            let device_id = context.calling_device(ArtifactPublish::DESCRIPTOR.method)?;
            Ok(publisher
                .publish(request, PublishOrigin::Request { device_id })
                .await?)
        }
        .boxed()
    })
}
