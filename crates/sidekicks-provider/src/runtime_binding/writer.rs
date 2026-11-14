//! The binding writes a driver makes itself, served by the binding store: pointing a session's
//! binding at the conversation it moved onto, keeping the provider's recovery data on it, moving
//! it onto another account, and replacing the tool servers a relaunch starts with.

use std::error::Error;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::{Map, Value};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;

use crate::driver::session_control::SessionToolServer;
use crate::runtime_binding::store::{
    RuntimeBindingPatch, RuntimeBindingRebind, RuntimeBindingStore, RuntimeBindingStoreError,
};

/// Writes a session's binding: the conversation it moved onto, the provider's recovery data, the
/// account it runs on and the tool servers it relaunches with.
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

    /// Moves binding `binding_id` onto `provider_account_id`'s account, so every usage recorded
    /// on it after the move and a resume of it are that account's; the daemon's writer moves, in
    /// the same write, each binding on the account the moved one leaves that a live or interrupted
    /// helper, a bridged run or a copy in flight of its session rides, leaving a run whose account
    /// was chosen for it where it is. Fails when nothing was recorded.
    fn move_account(
        &self,
        binding_id: RuntimeBindingId,
        provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;

    /// Replaces the tool servers stored on run `run_id`'s newest resumable binding with
    /// `tool_servers`, each with the person's switch, so a relaunch of the session starts with the
    /// set it last had. Fails when nothing was recorded.
    fn replace_tool_servers(
        &self,
        run_id: RunId,
        tool_servers: Vec<SessionToolServer>,
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

    /// Fails with [`RuntimeBindingStoreError::NoRowToWrite`] when the binding has no row, and as
    /// [`RuntimeBindingStore::move_account`] does.
    fn move_account(
        &self,
        binding_id: RuntimeBindingId,
        provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            if RuntimeBindingStore::move_account(self, &binding_id, &[], &provider_account_id)
                .await?
            {
                Ok(())
            } else {
                Err(RuntimeBindingStoreError::NoRowToWrite { binding_id }.into())
            }
        }
        .boxed()
    }

    /// Fails with [`RuntimeBindingStoreError::NoResumableRow`] when the run has no binding with a
    /// resume handle, and as [`RuntimeBindingStore::replace_tool_servers`] does.
    fn replace_tool_servers(
        &self,
        run_id: RunId,
        tool_servers: Vec<SessionToolServer>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            if RuntimeBindingStore::replace_tool_servers(self, &run_id, &tool_servers).await? {
                Ok(())
            } else {
                Err(RuntimeBindingStoreError::NoResumableRow { run_id }.into())
            }
        }
        .boxed()
    }
}
