//! The ingest streams' tests: how a stream ends, a resend on each call, and the reaper.

use std::sync::Arc;
use std::time::{Duration, SystemTime};

use bytes::Bytes as ByteBuffer;
use rstest::rstest;
use serde_json::Value;
use sidekicks_contracts::artifacts::ingest::{
    ArtifactIngestCompleteRequest, ArtifactIngestCompleteResponse, ArtifactIngestStartRequest,
    ArtifactIngestWriteRequest, ArtifactIngestWriteResponse,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::attachment::Bytes;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{BoundedText, NonEmptyText};
use sidekicks_platforms::WallClockTimer;

use super::{ArtifactIngestService, IngestStream};
use crate::artifacts::ingest::limits::{
    ABANDONED_SPOOL_TTL, MAX_ACTIVE_INGEST_STREAMS, MAX_HELD_COMPLETIONS,
    MAX_INGEST_STREAM_LIFETIME,
};
use crate::artifacts::refusals::ArtifactError;
use crate::artifacts::test_store::{ArtifactTestStore, refusal_code_of};
use crate::uuid_v7::mint_uuid_v7;

fn service(store: &ArtifactTestStore) -> Arc<ArtifactIngestService> {
    Arc::new(ArtifactIngestService::new(
        Arc::clone(&store.appender),
        Arc::clone(&store.reads),
        Arc::clone(&store.payloads),
        Arc::clone(&store.admission),
        Arc::new(WallClockTimer::new().expect("the test arms a wall clock")),
    ))
}

fn start_request(
    store: &ArtifactTestStore,
    key: &ClientUuid,
    declared_size_bytes: u64,
) -> ArtifactIngestStartRequest {
    ArtifactIngestStartRequest {
        session_id: store.session_id,
        run_id: Some(store.run_id),
        file_name: BoundedText::new("notes.txt".to_owned()).expect("the name is in bounds"),
        media_type: None,
        declared_size_bytes: SafeInt::new(declared_size_bytes).expect("the size is safe"),
        client_idempotency_key: key.clone(),
    }
}

fn fresh_key() -> ClientUuid {
    ClientUuid::new(mint_uuid_v7().to_string()).expect("a minted UUID is a client UUID")
}

/// Starts a stream for a file of `declared_size_bytes` under a fresh key and answers its id.
async fn start(
    service: &ArtifactIngestService,
    store: &ArtifactTestStore,
    declared_size_bytes: u64,
) -> NonEmptyText {
    service
        .start(start_request(store, &fresh_key(), declared_size_bytes))
        .await
        .expect("the stream starts")
        .ingest_id
}

async fn write(
    service: &ArtifactIngestService,
    ingest_id: &NonEmptyText,
    sequence_number: u64,
    chunk: &[u8],
) -> Result<ArtifactIngestWriteResponse, ArtifactError> {
    service
        .write(ArtifactIngestWriteRequest {
            ingest_id: ingest_id.clone(),
            sequence_number: SafeInt::new(sequence_number).expect("the number is safe"),
            chunk: Bytes::new(ByteBuffer::copy_from_slice(chunk)).expect("the chunk is in bounds"),
        })
        .await
}

async fn complete(
    service: &ArtifactIngestService,
    ingest_id: &NonEmptyText,
) -> Result<ArtifactIngestCompleteResponse, ArtifactError> {
    service
        .complete(
            ArtifactIngestCompleteRequest {
                ingest_id: ingest_id.clone(),
            },
            DeviceId::new("device".to_owned()).expect("the id is well formed"),
        )
        .await
}

/// The refusal's code and the `reason` its detail names.
fn refusal_of(failure: &ArtifactError) -> (Option<RefusalCode>, Option<String>) {
    let reason = failure
        .refusal()
        .and_then(|refusal| refusal.detail.as_ref())
        .and_then(|detail| detail.get("reason"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    (refusal_code_of(failure), reason)
}

fn invalid(reason: &str) -> (Option<RefusalCode>, Option<String>) {
    (
        Some(RefusalCode::ArtifactIngestStreamInvalid),
        Some(reason.to_owned()),
    )
}

/// A chunk that breaks the sequence, or runs past the declared size, ends the stream: its spool
/// goes and the next call finds no stream.
#[rstest]
#[case::gap(&[(0, b"abc".as_slice())], (2, b"def".as_slice()), invalid("sequenceBroken"))]
#[case::regression(
    &[(0, b"abc".as_slice()), (1, b"def".as_slice())],
    (0, b"abc".as_slice()),
    invalid("sequenceBroken")
)]
#[case::same_sequence_other_bytes(
    &[(0, b"abc".as_slice())],
    (0, b"xyz".as_slice()),
    invalid("sequenceBroken")
)]
#[case::past_the_declared_size(
    &[(0, b"abcdef".as_slice())],
    (1, b"ghijk".as_slice()),
    (Some(RefusalCode::ArtifactTooLarge), Some("declaredSizeExceeded".to_owned()))
)]
#[tokio::test]
async fn a_chunk_that_breaks_the_stream_ends_it(
    #[case] accepted: &[(u64, &[u8])],
    #[case] breaking: (u64, &[u8]),
    #[case] expected: (Option<RefusalCode>, Option<String>),
) {
    let store = ArtifactTestStore::open().await;
    let service = service(&store);
    let ingest_id = start(&service, &store, 10).await;
    for (sequence_number, chunk) in accepted {
        write(&service, &ingest_id, *sequence_number, chunk)
            .await
            .expect("an in-sequence chunk is written");
    }

    let refused = write(&service, &ingest_id, breaking.0, breaking.1)
        .await
        .expect_err("the breaking chunk is refused");

    assert_eq!(refusal_of(&refused), expected);
    assert_eq!(store.spooled_file_count(), 0);
    let after = write(&service, &ingest_id, 0, b"abc")
        .await
        .expect_err("the ended stream is gone");
    assert_eq!(refusal_of(&after), invalid("unknownStream"));
}

/// An original chunk and its resend sent together are written once: the resend waits for the
/// original inside its stream's exclusion, then is answered without appending again.
#[tokio::test(start_paused = true)]
async fn a_resent_chunk_racing_its_original_is_written_once() {
    let store = ArtifactTestStore::open().await;
    let service = service(&store);
    let ingest_id = start(&service, &store, 10).await;
    let paused = service.pause.arm();
    let original = tokio::spawn({
        let service = Arc::clone(&service);
        let ingest_id = ingest_id.clone();
        async move { write(&service, &ingest_id, 0, b"abc").await }
    });
    paused
        .reached
        .await
        .expect("the original reaches the pause");
    let mut resend = tokio::spawn({
        let service = Arc::clone(&service);
        let ingest_id = ingest_id.clone();
        async move { write(&service, &ingest_id, 0, b"abc").await }
    });
    // The paused clock moves only once no task can go on, so the wait ends with the resend as far
    // as it can get.
    let resend_while_held = tokio::time::timeout(Duration::from_secs(1), &mut resend).await;
    assert!(
        resend_while_held.is_err(),
        "the resend waits for the original"
    );
    paused.release.send(()).expect("the original waits");

    for answered in [original.await, resend.await] {
        let response = answered
            .expect("the write ends")
            .expect("the chunk is acknowledged");
        assert_eq!(response.received_bytes.get(), 3);
    }
    let spool = store.spool_folder().join(ingest_id.as_str());
    assert_eq!(
        std::fs::read(spool).expect("the test reads the spool"),
        b"abc"
    );
}

/// A completion below its declaration records what was sent with one `artifact.published`, and a
/// resent completion answers the saved result without writing again; a saved result that no longer names its digest ends the
/// stream, and past the count held the oldest completion is let go.
#[tokio::test]
async fn a_resent_completion_answers_the_saved_result_while_held() {
    let store = ArtifactTestStore::open().await;
    let service = service(&store);
    let ingest_id = start(&service, &store, 10).await;
    write(&service, &ingest_id, 0, b"hello")
        .await
        .expect("the chunk is written");

    let completed = complete(&service, &ingest_id)
        .await
        .expect("the stream completes");
    let resent = complete(&service, &ingest_id)
        .await
        .expect("the resend answers");

    assert_eq!(completed.derived_size_bytes.get(), 5);
    assert_eq!(completed.derived_media_type.as_str(), "text/plain");
    assert_eq!(resent, completed);
    assert_eq!(store.count_rows("artifact_manifests"), 1);
    assert_eq!(store.count_events("artifact.published"), 1);
    assert_eq!(store.spooled_file_count(), 0);

    if let Some(IngestStream::Completed(stream)) =
        service.lock_registry().streams.get_mut(ingest_id.as_str())
    {
        stream.response.content_hash =
            NonEmptyText::new("sha256:changed".to_owned()).expect("the text is not empty");
    }
    let mismatch = complete(&service, &ingest_id)
        .await
        .expect_err("a saved result naming another digest is refused");
    assert_eq!(refusal_of(&mismatch), invalid("completionRecordMismatch"));
    let after = complete(&service, &ingest_id)
        .await
        .expect_err("the ended stream is gone");
    assert_eq!(refusal_of(&after), invalid("unknownStream"));

    let oldest = start(&service, &store, 1).await;
    complete(&service, &oldest)
        .await
        .expect("the oldest completes");
    for _ in 0..MAX_HELD_COMPLETIONS {
        let ingest_id = start(&service, &store, 1).await;
        complete(&service, &ingest_id)
            .await
            .expect("a stream completes");
    }
    let let_go = complete(&service, &oldest)
        .await
        .expect_err("the oldest completion was let go");
    assert_eq!(refusal_of(&let_go), invalid("unknownStream"));
}

/// A start resent under its key answers the first stream and holds one reservation; the key with
/// another declared size is refused.
#[tokio::test]
async fn a_resent_start_answers_the_first_stream_and_a_changed_one_is_refused() {
    let store = ArtifactTestStore::open().await;
    let service = service(&store);
    let key = fresh_key();

    let first = service
        .start(start_request(&store, &key, 10))
        .await
        .expect("the first start opens a stream");
    let resent = service
        .start(start_request(&store, &key, 10))
        .await
        .expect("the resend answers");
    let changed = service
        .start(start_request(&store, &key, 11))
        .await
        .expect_err("the key with another size is refused");

    assert_eq!(resent, first);
    assert_eq!(
        refusal_code_of(&changed),
        Some(RefusalCode::ArtifactIdempotencyConflict)
    );
    let mut open = Vec::new();
    for _ in 1..MAX_ACTIVE_INGEST_STREAMS {
        open.push(
            store
                .admission
                .admit(1, None)
                .await
                .expect("each place but the stream's is free"),
        );
    }
    assert!(store.admission.admit(1, None).await.is_err());
}

/// Two starts sent together under one key open one stream: the second waits for the first, held
/// inside its admission, then answers the first's stream.
#[tokio::test(start_paused = true)]
async fn concurrent_starts_under_one_key_open_one_stream() {
    let store = ArtifactTestStore::open().await;
    let service = service(&store);
    let key = fresh_key();
    let paused = store.admission.pause.arm();
    let first = tokio::spawn({
        let service = Arc::clone(&service);
        let request = start_request(&store, &key, 10);
        async move { service.start(request).await }
    });
    paused
        .reached
        .await
        .expect("the first start reaches the pause");
    let mut second = tokio::spawn({
        let service = Arc::clone(&service);
        let request = start_request(&store, &key, 10);
        async move { service.start(request).await }
    });
    // The paused clock moves only once no task can go on, the second start's reads included, so
    // the wait ends with the second start as far as it can get.
    let second_while_held = tokio::time::timeout(Duration::from_secs(1), &mut second).await;
    assert!(
        second_while_held.is_err(),
        "the second start waits for the first"
    );
    paused.release.send(()).expect("the first start waits");

    let first = first
        .await
        .expect("the first start ends")
        .expect("the first start opens a stream");
    let second = second
        .await
        .expect("the second start ends")
        .expect("the second start answers");
    assert_eq!(second, first);
    assert_eq!(service.lock_registry().streams.len(), 1);
}

/// A write dropped mid-chunk leaves the stream's state unknown, so the next call on it fails and
/// ends it, its spool with it.
#[tokio::test]
async fn a_write_dropped_mid_chunk_ends_its_stream_at_the_next_call() {
    let store = ArtifactTestStore::open().await;
    let service = service(&store);
    let ingest_id = start(&service, &store, 10).await;
    let paused = service.pause.arm();
    let dropped = tokio::spawn({
        let service = Arc::clone(&service);
        let ingest_id = ingest_id.clone();
        async move { write(&service, &ingest_id, 0, b"abc").await }
    });
    paused.reached.await.expect("the write reaches the pause");
    dropped.abort();
    assert!(
        dropped.await.is_err_and(|ended| ended.is_cancelled()),
        "the write is dropped"
    );

    let next = write(&service, &ingest_id, 0, b"abc")
        .await
        .expect_err("the next call fails");

    assert!(matches!(next, ArtifactError::StreamWriteDropped));
    assert_eq!(store.spooled_file_count(), 0);
    let after = complete(&service, &ingest_id)
        .await
        .expect_err("the ended stream is gone");
    assert_eq!(refusal_of(&after), invalid("unknownStream"));
}

// Sets the stream's opening back by `age`.
fn age_stream(service: &ArtifactIngestService, ingest_id: &NonEmptyText, age: Duration) {
    let mut registry = service.lock_registry();
    match registry.streams.get_mut(ingest_id.as_str()) {
        Some(IngestStream::Open(stream)) => stream.opened_at -= age,
        Some(IngestStream::Completed(stream)) => stream.opened_at -= age,
        None => panic!("the test ages a stream it started"),
    }
}

// Writes a spool no stream holds, last written `age` ago, and answers its path.
fn stray_spool(store: &ArtifactTestStore, age: Duration) -> std::path::PathBuf {
    let path = store.spool_folder().join(mint_uuid_v7().to_string());
    let file = std::fs::File::create(&path).expect("the test writes a stray spool");
    file.set_modified(SystemTime::now() - age)
        .expect("the test dates the stray spool");
    path
}

/// A stream past its lifetime is ended by the next call on it or by the reaper, its spool with
/// it; the reaper deletes a stray spool only once it has gone unwritten past its time to live.
#[tokio::test]
async fn streams_and_spools_past_their_time_are_reaped() {
    let store = ArtifactTestStore::open().await;
    let service = service(&store);
    let past_lifetime = MAX_INGEST_STREAM_LIFETIME + Duration::from_secs(1);
    let called = start(&service, &store, 10).await;
    let reaped = start(&service, &store, 10).await;
    age_stream(&service, &called, past_lifetime);
    age_stream(&service, &reaped, past_lifetime);
    let stale = stray_spool(&store, ABANDONED_SPOOL_TTL + Duration::from_secs(60));
    let fresh = stray_spool(
        &store,
        ABANDONED_SPOOL_TTL
            .checked_sub(Duration::from_secs(60))
            .expect("the time to live is longer than a minute"),
    );

    let expired = write(&service, &called, 0, b"abc")
        .await
        .expect_err("a stream past its lifetime is refused");
    service
        .reap()
        .await
        .expect("the reaper's pass ends cleanly");

    assert_eq!(refusal_of(&expired), invalid("lifetimeExpired"));
    assert!(!store.spool_folder().join(called.as_str()).exists());
    assert!(!store.spool_folder().join(reaped.as_str()).exists());
    assert!(service.lock_registry().streams.is_empty());
    assert!(!stale.exists());
    assert!(fresh.exists());
}
