//! The caller-process reader over the running system's process table and code signatures, through
//! the platforms crate's pinned reads.

use std::io;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use interprocess::local_socket::tokio::Stream;
use sidekicks_contracts::app_identity::APP_BUNDLE_IDENTIFIER;
use sidekicks_platforms::{
    CodeSignatureError, DesktopClientRequirement, ParentProcess, PinnedProcess, ResponsibleProcess,
    SignatureCheck, read_parent_process, read_peer_process, read_responsible_process,
};

use crate::caller_process::contract::{CallerProcessReader, PeerRead};

/// Reads callers, their parents and responsible processes from the system's process table, and
/// their signatures against the desktop client's requirement. Every read can touch the process
/// table's files or the code on disk, so each runs on the blocking pool.
pub(crate) struct ProcessTableReader {
    /// The signatures the desktop's client meets; `None` when this build admits no client by its
    /// signature.
    desktop_client: Option<Arc<DesktopClientRequirement>>,
}

impl ProcessTableReader {
    /// A reader admitting the desktop's client by the requirement built from this program's own
    /// signature and the app's bundle identifier; one that admits no client by its signature when
    /// this program's signature names no team. Fails when that requirement cannot be built, so the
    /// daemon does not start.
    pub(crate) fn for_this_program() -> Result<Self, CodeSignatureError> {
        Ok(Self {
            desktop_client: DesktopClientRequirement::for_this_program(APP_BUNDLE_IDENTIFIER)?
                .map(Arc::new),
        })
    }
}

impl CallerProcessReader for ProcessTableReader {
    fn read_peer_process(&self, stream: Stream) -> BoxFuture<'_, PeerRead> {
        async move {
            tokio::task::spawn_blocking(move || {
                let read = read_peer_process(&stream);
                (stream, read)
            })
            .await
            .map_err(io::Error::other)
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

    fn read_responsible_process(
        &self,
        process: PinnedProcess,
    ) -> BoxFuture<'_, io::Result<ResponsibleProcess>> {
        async move {
            tokio::task::spawn_blocking(move || read_responsible_process(&process))
                .await
                .map_err(io::Error::other)?
        }
        .boxed()
    }

    fn check_desktop_client(
        &self,
        caller: PinnedProcess,
        responsible: PinnedProcess,
    ) -> BoxFuture<'_, io::Result<Option<SignatureCheck>>> {
        let desktop_client = self.desktop_client.clone();
        async move {
            let Some(desktop_client) = desktop_client else {
                return Ok(None);
            };
            tokio::task::spawn_blocking(move || desktop_client.check(&caller, &responsible))
                .await
                .map_err(io::Error::other)?
                .map(Some)
        }
        .boxed()
    }
}
