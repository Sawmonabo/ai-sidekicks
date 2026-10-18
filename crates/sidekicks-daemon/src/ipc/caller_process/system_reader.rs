//! The caller-process reader over the running system's process table, through the platforms
//! crate's pinned reads.

use std::io;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use interprocess::local_socket::tokio::Stream;
use sidekicks_platforms::{ParentProcess, PinnedProcess, read_parent_process, read_peer_process};

use crate::ipc::caller_process::contract::CallerProcessReader;

/// Reads callers and their parents from the system's process table. Both reads can touch the
/// process table's files, so both run on the blocking pool.
pub(crate) struct ProcessTableReader;

impl CallerProcessReader for ProcessTableReader {
    fn read_peer_process(
        &self,
        stream: Arc<Stream>,
    ) -> BoxFuture<'_, io::Result<Option<PinnedProcess>>> {
        async move {
            tokio::task::spawn_blocking(move || read_peer_process(&stream))
                .await
                .map_err(io::Error::other)?
        }
        .boxed()
    }

    fn read_parent_process(
        &self,
        process: PinnedProcess,
    ) -> BoxFuture<'_, io::Result<ParentProcess>> {
        async move {
            tokio::task::spawn_blocking(move || read_parent_process(&process))
                .await
                .map_err(io::Error::other)?
        }
        .boxed()
    }
}
