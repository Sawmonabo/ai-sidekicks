//! The one binding write a driver makes itself: pointing a session's binding at the conversation
//! it moved onto, served by the binding store.

use std::error::Error;

use futures::FutureExt as _;
use futures::future::BoxFuture;

use crate::runtime_binding::store::{
    RuntimeBindingPatch, RuntimeBindingRebind, RuntimeBindingStore, RuntimeBindingStoreError,
};

/// Points a session's binding at the conversation it moved onto.
pub(crate) trait RuntimeBindingRebinder: Send + Sync {
    /// Points binding `rebind.binding_id` at the conversation its session moved onto, recording
    /// each conversation the session left in the same write. Fails when nothing was recorded.
    fn rebind(
        &self,
        rebind: RuntimeBindingRebind,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;
}

impl RuntimeBindingRebinder for RuntimeBindingStore {
    /// Fails with [`RuntimeBindingStoreError::NoRowToRebind`] when the binding has no row, and as
    /// [`RuntimeBindingStore::update`] does.
    fn rebind(
        &self,
        rebind: RuntimeBindingRebind,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            let patch = RuntimeBindingPatch {
                resume_handle: Some(rebind.resume_handle),
                ..RuntimeBindingPatch::default()
            };
            match self
                .update(&rebind.binding_id, patch, rebind.left_conversations)
                .await?
            {
                Some(_) => Ok(()),
                None => Err(RuntimeBindingStoreError::NoRowToRebind {
                    binding_id: rebind.binding_id,
                }
                .into()),
            }
        }
        .boxed()
    }
}
