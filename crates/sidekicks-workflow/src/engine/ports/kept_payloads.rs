//! The payload store the tests write through: it keeps each write and answers its bytes back.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::future::BoxFuture;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;

use crate::engine::ports::{PortError, REFUSED_PORT_CALL, StepPayloadArtifacts};

/// A payload the test's store kept, with the artifact it answered.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct KeptPayload {
    /// The session the payload was written in.
    pub(crate) session_id: SessionId,
    /// The step that wrote it.
    pub(crate) step: WorkflowStepKey,
    /// The bytes written.
    pub(crate) bytes: Vec<u8>,
    /// How many items they hold.
    pub(crate) item_count: u64,
    /// The artifact answered.
    pub(crate) artifact_id: ArtifactId,
}

/// A payload store that keeps what each write was given and answers a fresh artifact, or refuses
/// every write past a count once told to, reads each kept artifact's bytes back, and keeps each
/// artifact deleted, or refuses every delete once told to.
#[derive(Default)]
pub(crate) struct KeptPayloads {
    writes: Mutex<Vec<KeptPayload>>,
    deletes: Mutex<Vec<ArtifactId>>,
    is_refusing_deletes: AtomicBool,
    /// How many writes it keeps in all before refusing the rest; `None` keeps every one.
    write_limit: Mutex<Option<usize>>,
}

impl KeptPayloads {
    /// Every write, in order.
    pub(crate) fn writes(&self) -> Vec<KeptPayload> {
        self.writes
            .lock()
            .expect("the test's payloads lock")
            .clone()
    }

    /// Every artifact deleted, in order.
    pub(crate) fn deletes(&self) -> Vec<ArtifactId> {
        self.deletes
            .lock()
            .expect("the test's payloads lock")
            .clone()
    }

    /// Refuses every later delete.
    pub(crate) fn refuse_deletes(&self) {
        self.is_refusing_deletes.store(true, Ordering::SeqCst);
    }

    /// Keeps `count` writes in all, those already kept among them, and refuses every one past them.
    pub(crate) fn refuse_writes_past(&self, count: usize) {
        *self.write_limit.lock().expect("the test's payloads lock") = Some(count);
    }
}

impl StepPayloadArtifacts for KeptPayloads {
    fn write<'call>(
        &'call self,
        session_id: SessionId,
        step: &'call WorkflowStepKey,
        bytes: Vec<u8>,
        item_count: u64,
    ) -> BoxFuture<'call, Result<ArtifactId, PortError>> {
        let artifact_id =
            ArtifactId::try_from(mint_uuid_v7()).expect("a minted UUID is an artifact id");
        let limit = *self.write_limit.lock().expect("the test's payloads lock");
        let mut writes = self.writes.lock().expect("the test's payloads lock");
        if limit.is_some_and(|limit| writes.len() >= limit) {
            return Box::pin(async { Err(REFUSED_PORT_CALL.into()) });
        }
        writes.push(KeptPayload {
            session_id,
            step: step.clone(),
            bytes,
            item_count,
            artifact_id,
        });
        Box::pin(async move { Ok(artifact_id) })
    }

    fn read<'call>(
        &'call self,
        artifact_id: &'call ArtifactId,
    ) -> BoxFuture<'call, Result<Vec<u8>, PortError>> {
        let bytes = self
            .writes
            .lock()
            .expect("the test's payloads lock")
            .iter()
            .find(|kept| kept.artifact_id == *artifact_id)
            .map(|kept| kept.bytes.clone());
        Box::pin(async move { bytes.ok_or_else(|| REFUSED_PORT_CALL.into()) })
    }

    fn delete<'call>(
        &'call self,
        artifact_id: &'call ArtifactId,
    ) -> BoxFuture<'call, Result<(), PortError>> {
        if self.is_refusing_deletes.load(Ordering::SeqCst) {
            return Box::pin(async { Err(REFUSED_PORT_CALL.into()) });
        }
        self.deletes
            .lock()
            .expect("the test's payloads lock")
            .push(*artifact_id);
        Box::pin(async { Ok(()) })
    }
}
