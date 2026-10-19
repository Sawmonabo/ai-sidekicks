//! Writes one published artifact's manifest and then its payload reference, in one transaction
//! behind checks that its session still exists and that its run, when it names one, is one of the
//! session's, so a purge cannot land between the checks and the rows. The manifest goes first
//! because the reference names it. Every producer of artifacts writes through here, and its write
//! runs inside the store's exclusion for the payload's key. The same checks run before a producer
//! spools anything, so a payload for a session or run that is not there is refused before it costs
//! a write.

use std::borrow::Cow;

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, named_params};
use serde_json::Value;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::artifacts::manifest::{
    ArtifactManifest, ArtifactState, ArtifactType, Extensible,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::id::{ClientUuid, UuidText};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::record::JsonRecord;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_platforms::WallClock;

use crate::artifacts::payload_store::ContentHash;
use crate::artifacts::refusals::ArtifactError;
use crate::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use crate::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use crate::database::stored_column::{
    closed_word, optional_text_column, safe_int_column, text_column,
};
use crate::database::writer::{DatabaseWriter, WriteError};
use crate::ipc::domain_error::DomainError;
use crate::session::directory::lookups::{session_exists, session_exists_statement};
use crate::session::not_found::session_not_found;
use crate::session::run::ids::{RUN_IN_SESSION_SQL, run_in_session_statement};
use crate::session::run::refusals::RunRefusal;
use crate::uuid_v7::mint_uuid_v7;

const INSERT_MANIFEST_SQL: &str = "INSERT INTO artifact_manifests
  (id, session_id, run_id, created_by, client_idempotency_key, artifact_type, state, content_hash,
   size_bytes, metadata, created_at)
  VALUES (@id, @sessionId, @runId, @createdBy, @clientIdempotencyKey, @artifactType, @state,
          @contentHash, @sizeBytes, @metadata, @createdAt)";

const INSERT_PAYLOAD_REF_SQL: &str = "INSERT INTO artifact_payload_refs
  (id, manifest_id, storage_path, media_type, size_bytes, created_at)
  VALUES (@id, @manifestId, @storagePath, @mediaType, @sizeBytes, @createdAt)";

// The manifest a client's publish wrote under its key in its session.
const MANIFEST_BY_PUBLISH_KEY_SQL: &str = "SELECT id, run_id, created_by, artifact_type, state,
       content_hash, size_bytes, metadata, created_at
  FROM artifact_manifests
  WHERE session_id = @sessionId AND client_idempotency_key = @clientIdempotencyKey";

// The metadata member that records the media type beside the producer's own.
const MEDIA_TYPE_MEMBER: &str = "mediaType";

/// A stored manifest column whose text is not a value of its type; names the column.
#[derive(Debug, thiserror::Error)]
#[error("the stored manifest's {0} is not a valid value")]
struct StoredManifestTextInvalidError(&'static str);

/// One published artifact as its producer records it, over a payload already in the store.
pub(crate) struct PublishedManifest {
    /// The manifest's id.
    pub(crate) artifact_id: ArtifactId,
    /// The session it belongs to.
    pub(crate) session_id: SessionId,
    /// The run that produced it, when one did.
    pub(crate) run_id: Option<RunId>,
    /// The device the request that made it came from; `None` for one the daemon produced.
    pub(crate) created_by: Option<DeviceId>,
    /// A client's publish's key, so a resend answers this manifest; `None` for the daemon's own and
    /// for an ingested file.
    pub(crate) client_idempotency_key: Option<ClientUuid>,
    /// The artifact's kind.
    pub(crate) artifact_type: ArtifactType,
    /// The manifest's digest and the payload's key in the store.
    pub(crate) content_hash: ContentHash,
    /// The payload's length, measured by the daemon.
    pub(crate) size_bytes: SafeInt<0>,
    /// The type read from the payload's bytes, or the producing code's for the daemon's own.
    pub(crate) media_type: String,
    /// The manifest's freeform provenance; the media type is recorded in it beside the rest.
    pub(crate) metadata: JsonRecord,
    /// When the manifest was written.
    pub(crate) created_at: WireInstant,
}

/// Checks an artifact's session and run before anything of it is spooled. Fails with
/// `session.notFound` for a session with no row and `agent.run.notFound` for a run that is not one
/// of the session's.
pub(crate) async fn check_artifact_owner(
    reads: &DatabaseReadPool,
    session_id: SessionId,
    run_id: Option<RunId>,
) -> Result<(), ArtifactError> {
    reads
        .read(ReadLength::Short, move |connection| {
            read_artifact_owner(connection, &session_id, run_id.as_ref())
        })
        .await
}

// The owner check's two reads on one connection.
fn read_artifact_owner(
    connection: &Connection,
    session_id: &SessionId,
    run_id: Option<&RunId>,
) -> Result<(), ArtifactError> {
    if !session_exists(connection, session_id)? {
        return Err(session_not_found(session_id).into());
    }
    let Some(run_id) = run_id else {
        return Ok(());
    };
    let is_run_of_session = connection.prepare_cached(RUN_IN_SESSION_SQL)?.exists(
        named_params! { "@sessionId": session_id.text().as_str(), "@runId": run_id.text().as_str() },
    )?;
    if is_run_of_session {
        Ok(())
    } else {
        Err(DomainError::from(RunRefusal::NotFound { run_id: *run_id }).into())
    }
}

/// The instant a manifest is written at, read from `clock` to the millisecond.
pub(crate) fn manifest_created_at(clock: &dyn WallClock) -> WireInstant {
    let now =
        jiff::Timestamp::try_from(clock.now()).expect("the wall clock reads within 9999 years");
    WireInstant::from_timestamp(now).expect("the wall clock reads after year 0000")
}

/// The manifest a client's publish wrote under `client_idempotency_key` in `session_id`, or `None`
/// when none did. Fails as SQLite does, or when a stored column does not read as its type.
pub(crate) fn read_manifest_by_publish_key(
    connection: &Connection,
    session_id: SessionId,
    client_idempotency_key: &ClientUuid,
) -> rusqlite::Result<Option<ArtifactManifest>> {
    connection
        .prepare_cached(MANIFEST_BY_PUBLISH_KEY_SQL)?
        .query_row(
            named_params! {
                "@sessionId": session_id.text().as_str(),
                "@clientIdempotencyKey": client_idempotency_key.as_str(),
            },
            |row| {
                Ok(ArtifactManifest {
                    id: text_column(row, 0, |text| ArtifactId::new(&text))?,
                    session_id,
                    run_id: optional_text_column(row, 1, |text| RunId::new(&text))?,
                    created_by: optional_text_column(row, 2, |text| {
                        DeviceId::new(text).ok_or(StoredManifestTextInvalidError("created_by"))
                    })?,
                    artifact_type: Extensible::Known(text_column(row, 3, closed_word)?),
                    state: Extensible::Known(text_column(row, 4, closed_word)?),
                    digest: text_column(row, 5, |text| {
                        NonEmptyText::new(text)
                            .ok_or(StoredManifestTextInvalidError("content_hash"))
                    })?,
                    size: safe_int_column(row, 6)?,
                    metadata: text_column(row, 7, |text| serde_json::from_str(&text))?,
                    created_at: text_column(row, 8, WireInstant::try_from)?,
                    rest: serde_json::Map::new(),
                })
            },
        )
        .optional()
}

/// Writes `manifest`'s row and its payload reference, and answers the manifest as the wire carries
/// it. Fails with `session.notFound` once the session is gone and `agent.run.notFound` for a run
/// that is not the session's, writing neither row, and as the writer does.
pub(crate) async fn write_published_manifest(
    writer: &DatabaseWriter,
    manifest: PublishedManifest,
) -> Result<ArtifactManifest, ArtifactError> {
    let mut metadata = manifest.metadata.into_map();
    metadata.insert(
        MEDIA_TYPE_MEMBER.to_owned(),
        AnyValue(Value::String(manifest.media_type.clone())),
    );
    let metadata = JsonRecord::new(metadata).expect("adding the media type adds no __proto__");
    let metadata_text = serde_json::to_string(&metadata).expect("a JSON record writes as JSON");
    let size_bytes = SqlValue::Integer(i64::from(manifest.size_bytes));
    let state = ArtifactState::Published;
    let mut statements = vec![session_exists_statement(&manifest.session_id)];
    if let Some(run_id) = &manifest.run_id {
        statements.push(run_in_session_statement(&manifest.session_id, run_id));
    }
    let artifact_id_text = manifest.artifact_id.text();
    let run_id_text = manifest.run_id.map(|run_id| run_id.text());
    statements.push(WriteStatement {
        sql: Cow::Borrowed(INSERT_MANIFEST_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@id", artifact_id_text.as_str()),
            text_binding("@sessionId", manifest.session_id.text().as_str()),
            nullable_text_binding("@runId", run_id_text.as_ref().map(UuidText::as_str)),
            nullable_text_binding(
                "@createdBy",
                manifest.created_by.as_ref().map(DeviceId::as_str),
            ),
            nullable_text_binding(
                "@clientIdempotencyKey",
                manifest
                    .client_idempotency_key
                    .as_ref()
                    .map(ClientUuid::as_str),
            ),
            text_binding(
                "@artifactType",
                <&'static str>::from(manifest.artifact_type),
            ),
            text_binding("@state", <&'static str>::from(state)),
            text_binding("@contentHash", manifest.content_hash.as_str()),
            (Cow::Borrowed("@sizeBytes"), size_bytes.clone()),
            text_binding("@metadata", &metadata_text),
            text_binding("@createdAt", manifest.created_at.as_str()),
        ]),
        expected_row_count: Some(1),
    });
    statements.push(WriteStatement {
        sql: Cow::Borrowed(INSERT_PAYLOAD_REF_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@id", &mint_uuid_v7().to_string()),
            text_binding("@manifestId", artifact_id_text.as_str()),
            text_binding("@storagePath", manifest.content_hash.as_str()),
            text_binding("@mediaType", &manifest.media_type),
            (Cow::Borrowed("@sizeBytes"), size_bytes),
            text_binding("@createdAt", manifest.created_at.as_str()),
        ]),
        expected_row_count: Some(1),
    });
    match writer.write(statements).await {
        Ok(_results) => {}
        // The second statement is the run check, present when the manifest names a run.
        Err(WriteError::Refused {
            statement_index, ..
        }) => {
            return Err(match manifest.run_id {
                Some(run_id) if statement_index == 1 => {
                    DomainError::from(RunRefusal::NotFound { run_id })
                }
                Some(_) | None => session_not_found(&manifest.session_id),
            }
            .into());
        }
        Err(failure) => return Err(failure.into()),
    }
    Ok(ArtifactManifest {
        id: manifest.artifact_id,
        session_id: manifest.session_id,
        run_id: manifest.run_id,
        created_by: manifest.created_by,
        artifact_type: Extensible::Known(manifest.artifact_type),
        digest: NonEmptyText::new(manifest.content_hash.to_string())
            .expect("a content hash is never empty"),
        size: manifest.size_bytes,
        state: Extensible::Known(state),
        metadata,
        created_at: manifest.created_at,
        rest: serde_json::Map::new(),
    })
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;
    use std::collections::BTreeMap;

    use rstest::rstest;
    use sidekicks_contracts::artifacts::manifest::ArtifactType;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::run::state::RunState;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_contracts::wire::record::JsonRecord;
    use sidekicks_platforms::WallClockTimer;

    use super::{
        PublishedManifest, check_artifact_owner, manifest_created_at, write_published_manifest,
    };
    use crate::artifacts::id::mint_artifact_id;
    use crate::artifacts::payload_store::ContentHash;
    use crate::artifacts::test_store::{ArtifactTestStore, refusal_code_of};
    use crate::database::statement::{StatementBindings, WriteStatement, text_binding};
    use crate::database::writer::test_file::test_session_id;
    use crate::uuid_v7::mint_uuid_v7;

    /// A run of another session never owns an artifact here, so no client writes into another
    /// session's run; the session's own run does. Both the check before spooling and the write's
    /// own check hold it, and a refused write keeps no row.
    #[rstest]
    #[case::the_sessions_own_run(false, None)]
    #[case::another_sessions_run(true, Some(RefusalCode::AgentRunNotFound))]
    #[tokio::test]
    async fn only_a_run_of_the_artifacts_session_owns_it(
        #[case] is_other_sessions_run: bool,
        #[case] expected: Option<RefusalCode>,
    ) {
        let store = ArtifactTestStore::open().await;
        let run_id = if is_other_sessions_run {
            let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
            store
                .writer
                .write(vec![WriteStatement {
                    sql: Cow::Borrowed(
                        "INSERT INTO runs (run_id, session_id, state, run_version) \
                         VALUES (@runId, @sessionId, @state, 0)",
                    ),
                    bindings: StatementBindings::Named(vec![
                        text_binding("@runId", run_id.text().as_str()),
                        text_binding("@sessionId", test_session_id().text().as_str()),
                        text_binding("@state", RunState::Running.into()),
                    ]),
                    expected_row_count: Some(1),
                }])
                .await
                .expect("the test writes another session's run");
            run_id
        } else {
            store.run_id
        };
        let clock = WallClockTimer::new().expect("the test arms a wall clock");

        let checked = check_artifact_owner(&store.reads, store.session_id, Some(run_id)).await;
        let written = write_published_manifest(
            &store.writer,
            PublishedManifest {
                artifact_id: mint_artifact_id(),
                session_id: store.session_id,
                run_id: Some(run_id),
                created_by: None,
                client_idempotency_key: None,
                artifact_type: ArtifactType::WorkflowOutput,
                content_hash: ContentHash::of_sha256(&[0; 32]),
                size_bytes: SafeInt::ZERO,
                media_type: "text/plain".to_owned(),
                metadata: JsonRecord::new(BTreeMap::new()).expect("an empty record"),
                created_at: manifest_created_at(&clock),
            },
        )
        .await;

        assert_eq!(checked.err().as_ref().and_then(refusal_code_of), expected);
        assert_eq!(written.err().as_ref().and_then(refusal_code_of), expected);
        let rows = i64::from(expected.is_none());
        assert_eq!(store.count_rows("artifact_manifests"), rows);
        assert_eq!(store.count_rows("artifact_payload_refs"), rows);
    }
}
