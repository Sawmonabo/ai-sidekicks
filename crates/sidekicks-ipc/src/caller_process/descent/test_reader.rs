//! A caller process reader a test scripts: one responsible process and one signature verdict for
//! every process, each process's parent and program, and one parent for every process it names
//! none for.

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use interprocess::local_socket::tokio::Stream;
use sidekicks_platforms::{ParentProcess, PinnedProcess, ResponsibleProcess, SignatureCheck};

use crate::caller_process::contract::{CallerProcessReader, PeerRead};

/// A reader answering one responsible process and one signature verdict for every process, each
/// process's parent and program by its id, and recording whether a signature was read.
pub struct ScriptedReader {
    /// The responsible process every read answers.
    pub responsible: ResponsibleProcess,
    /// The parent every read of a process `parents` does not name answers.
    pub parent: ParentProcess,
    /// Each process's parent, by its id.
    pub parents: HashMap<u32, ParentProcess>,
    /// Each process's program, by its id; a process it does not name reads as ended.
    pub programs: HashMap<u32, PathBuf>,
    /// Whether every signature check answers as the desktop client's.
    pub is_desktop_client: bool,
    /// Set once a signature was read.
    pub was_signature_read: AtomicBool,
}

impl CallerProcessReader for ScriptedReader {
    fn read_peer_process(&self, _stream: Stream) -> BoxFuture<'_, PeerRead> {
        futures::future::ready(Err(io::Error::other("no peer is read here"))).boxed()
    }

    fn read_parent_process(
        &self,
        process: PinnedProcess,
    ) -> BoxFuture<'_, io::Result<ParentProcess>> {
        let parent = self.parents.get(&process.id()).unwrap_or(&self.parent);
        futures::future::ready(Ok(parent.clone())).boxed()
    }

    fn read_responsible_process(
        &self,
        _process: PinnedProcess,
    ) -> BoxFuture<'_, io::Result<ResponsibleProcess>> {
        futures::future::ready(Ok(self.responsible.clone())).boxed()
    }

    fn read_program_path(
        &self,
        process: PinnedProcess,
    ) -> BoxFuture<'_, io::Result<Option<PathBuf>>> {
        futures::future::ready(Ok(self.programs.get(&process.id()).cloned())).boxed()
    }

    fn check_desktop_client(
        &self,
        _caller: PinnedProcess,
        _responsible: PinnedProcess,
    ) -> BoxFuture<'_, io::Result<Option<SignatureCheck>>> {
        self.was_signature_read.store(true, Ordering::SeqCst);
        let check = if self.is_desktop_client {
            SignatureCheck::Met
        } else {
            SignatureCheck::NotMet { status: -67050 }
        };
        futures::future::ready(Ok(Some(check))).boxed()
    }
}
