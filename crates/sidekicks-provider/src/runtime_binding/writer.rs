//! The binding writes a driver makes itself, served by the binding store: pointing a session's
//! binding at the conversation it moved onto, and keeping the provider's recovery data on it.

use std::error::Error;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::{Map, Value};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;

use crate::runtime_binding::store::{
    RuntimeBindingPatch, RuntimeBindingRebind, RuntimeBindingStore, RuntimeBindingStoreError,
};

/// Writes a session's binding: the conversation it moved onto and the provider's recovery data.
pub trait RuntimeBindingWriter: Send + Sync {
    /// Points binding `rebind.binding_id` at the conversation its session moved onto, recording
    /// each conversation the session left in the same write. Fails when nothing was recorded.
    fn rebind(
        &self,
        rebind: RuntimeBindingRebind,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;

    /// Replaces binding `binding_id`'s recovery data with `runtime_metadata`, which a resume of
    /// its conversation hands back. Fails when nothing was recorded.
    fn keep_recovery_data(
        &self,
        binding_id: RuntimeBindingId,
        runtime_metadata: Map<String, Value>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;
}

impl RuntimeBindingWriter for RuntimeBindingStore {
    /// Fails with [`RuntimeBindingStoreError::NoRowToWrite`] when the binding has no row, and as
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
                None => Err(RuntimeBindingStoreError::NoRowToWrite {
                    binding_id: rebind.binding_id,
                }
                .into()),
            }
        }
        .boxed()
    }

    /// Fails with [`RuntimeBindingStoreError::NoRowToWrite`] when the binding has no row, and as
    /// [`RuntimeBindingStore::update`] does.
    fn keep_recovery_data(
        &self,
        binding_id: RuntimeBindingId,
        runtime_metadata: Map<String, Value>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            let patch = RuntimeBindingPatch {
                runtime_metadata: Some(runtime_metadata),
                ..RuntimeBindingPatch::default()
            };
            match self.update(&binding_id, patch, Vec::new()).await? {
                Some(_) => Ok(()),
                None => Err(RuntimeBindingStoreError::NoRowToWrite { binding_id }.into()),
            }
        }
        .boxed()
    }
}
