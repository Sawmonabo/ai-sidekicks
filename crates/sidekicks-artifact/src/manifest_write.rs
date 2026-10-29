//! Writes one published artifact's manifest and then its payload reference, in the write that
//! appends its `artifact.published`, behind checks that its session still exists and that its run,
//! when it names one, is one of the session's, so a purge cannot land between the checks and the
//! rows and an acknowledged artifact is never without its event. The manifest goes first because
//! the reference names it. Every producer of artifacts writes through here, and its write runs
//! inside the store's exclusion for the payload's key. The same checks run before a producer spools
//! anything, so a payload for a session or run that is not there is refused before it costs a
//! write.
//!
//! A chat's file or folder is one group of manifests per path, each write a new manifest whose
//! version number is the group's next, counted inside the write itself, so two writes of one path
//! never take one number; every other artifact is version 1 of its own.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, Row, named_params};
use serde_json::Value;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::artifacts::manifest::{ArtifactManifest, ArtifactType, Extensible};
use sidekicks_contracts::artifacts::operations::ArtifactPictureSize;
use sidekicks_contracts::artifacts::publication::ArtifactPublicationPayload;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::plan::PlanId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::id::{ClientUuid, UuidText};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::record::JsonRecord;
use sidekicks_contracts::wire::text::{ComposedText, NonEmptyText};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::session_not_found::session_not_found;
use sidekicks_platforms::WallClock;
use sidekicks_session::directory::lookups::{session_exists, session_exists_statement};
use sidekicks_session::run::ids::{RUN_IN_SESSION_SQL, run_in_session_statement};
use sidekicks_session::run::refusals::RunRefusal;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use sidekicks_store::database::stored_column::{
    closed_word, optional_text_column, safe_int_column, text_column,
};
use sidekicks_store::events::log_service::EventAppendError;
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};

use crate::payload_store::ContentHash;
use crate::refusals::ArtifactError;

// One row whatever the group holds: an aggregate with no GROUP BY yields one row, so a path's
// next version is counted on the writer's connection, and a manifest with no path is version 1.
const INSERT_MANIFEST_SQL: &str = "INSERT INTO artifact_manifests
  (id, session_id, run_id, created_by, client_idempotency_key, artifact_type, content_hash,
   size_bytes, metadata, workspace_path, version_number, plan_id, created_at)
  SELECT @id, @sessionId, @runId, @createdBy, @clientIdempotencyKey, @artifactType, @contentHash,
         @sizeBytes, @metadata, @workspacePath, COALESCE(MAX(version_number), 0) + 1, @planId,
         @createdAt
    FROM artifact_manifests
   WHERE session_id = @sessionId AND workspace_path = @workspacePath";

const INSERT_PAYLOAD_REF_SQL: &str = "INSERT INTO artifact_payload_refs
  (id, manifest_id, storage_path, media_type, size_bytes, pixel_width, pixel_height, created_at)
  VALUES (@id, @manifestId, @storagePath, @mediaType, @sizeBytes, @pixelWidth, @pixelHeight,
          @createdAt)";

/// The columns a manifest is read from, in the order [`read_manifest`] reads them, from the table
/// aliased `manifests`.
pub(crate) const MANIFEST_COLUMNS: &str = "manifests.id, manifests.run_id, manifests.created_by,
       manifests.artifact_type, manifests.content_hash, manifests.size_bytes, manifests.metadata,
       manifests.created_at";

/// How many columns [`MANIFEST_COLUMNS`] names, so a read's own columns follow at this index.
pub(crate) const MANIFEST_COLUMN_COUNT: usize = 8;

// The manifest a client's publish wrote under its key in its session.
static MANIFEST_BY_PUBLISH_KEY_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {MANIFEST_COLUMNS}
  FROM artifact_manifests AS manifests
  WHERE manifests.session_id = @sessionId
    AND manifests.client_idempotency_key = @clientIdempotencyKey"
    )
});

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
    /// A picture's size, read from its header; `None` for anything else.
    pub(crate) natural_size: Option<ArtifactPictureSize>,
    /// The manifest's freeform provenance; the media type is recorded in it beside the rest.
    pub(crate) metadata: JsonRecord,
    /// A chat's file or folder: its path in the chat's workspace, whose group this manifest is the
    /// next version of; `None` for every other artifact.
    pub(crate) workspace_path: Option<ComposedText>,
    /// The plan record whose text this is; `None` for every other artifact.
    pub(crate) plan_id: Option<PlanId>,
    /// When the manifest was written.
    pub(crate) created_at: WireInstant,
}

/// One published artifact's write: the checks and rows that go before its `artifact.published`,
/// the event itself, and the manifest as the wire carries it once the write lands.
pub(crate) struct PublishedManifestWrite {
    /// The session and run checks, then the manifest's row and its payload reference.
    pub(crate) statements: Vec<WriteStatement>,
    /// The `artifact.published` the rows are written with.
    pub(crate) event: SessionEventDraft,
    /// The manifest the write records.
    pub(crate) manifest: ArtifactManifest,
}

/// The failure an append carrying `manifest`'s write answers with: `session.notFound` once the
/// session is gone and `agent.run.notFound` for a run that is not the session's, as the write's
/// checks refused, and the append's own failure otherwise.
pub(crate) fn manifest_write_failure(
    manifest: &ArtifactManifest,
    failure: SessionEventAppendError,
) -> ArtifactError {
    match (failure.refused_statement_index(), manifest.run_id) {
        // The second statement is the run check, present when the manifest names a run.
        (Some(1), Some(run_id)) => DomainError::from(RunRefusal::NotFound { run_id }).into(),
        (Some(0), _) => session_not_found(&manifest.session_id).into(),
        _ => artifact_append_failure(failure),
    }
}

/// What an artifact's append failed with as an artifact call answers it: a session that takes no
/// writes refused by its code, any other failure a fault.
pub(crate) fn artifact_append_failure(failure: SessionEventAppendError) -> ArtifactError {
    match failure {
        SessionEventAppendError::Append(EventAppendError::SessionWriteRefused(refusal)) => {
            DomainError::from(refusal).into()
        }
        failure @ (SessionEventAppendError::Append(_) | SessionEventAppendError::OccurredAt(_)) => {
            failure.into()
        }
    }
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
    let session_text = session_id.text();
    let is_run_of_session = connection.prepare_cached(RUN_IN_SESSION_SQL)?.exists(
        named_params! { "@sessionId": session_text.as_str(), "@runId": run_id.text().as_str() },
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
        .prepare_cached(&MANIFEST_BY_PUBLISH_KEY_SQL)?
        .query_row(
            named_params! {
                "@sessionId": session_id.text().as_str(),
                "@clientIdempotencyKey": client_idempotency_key.as_str(),
            },
            |row| read_manifest(row, session_id),
        )
        .optional()
}

/// The manifest of `session_id` a row holds in its first [`MANIFEST_COLUMNS`]. Fails when a stored
/// column does not read as its type.
pub(crate) fn read_manifest(
    row: &Row<'_>,
    session_id: SessionId,
) -> rusqlite::Result<ArtifactManifest> {
    Ok(ArtifactManifest {
        id: text_column(row, 0, |text| ArtifactId::new(&text))?,
        session_id,
        run_id: optional_text_column(row, 1, |text| RunId::new(&text))?,
        created_by: optional_text_column(row, 2, |text| {
            DeviceId::new(text).ok_or(StoredManifestTextInvalidError("created_by"))
        })?,
        artifact_type: Extensible::Known(text_column(row, 3, closed_word)?),
        digest: text_column(row, 4, |text| {
            NonEmptyText::new(text).ok_or(StoredManifestTextInvalidError("content_hash"))
        })?,
        size: safe_int_column(row, 5)?,
        metadata: text_column(row, 6, |text| serde_json::from_str(&text))?,
        created_at: text_column(row, 7, WireInstant::try_from)?,
        rest: serde_json::Map::new(),
    })
}

/// The write of `manifest`'s row and its payload reference with its `artifact.published`, for a
/// producer that appends them in its own event's write.
pub(crate) fn published_manifest_write(manifest: PublishedManifest) -> PublishedManifestWrite {
    let mut metadata = manifest.metadata.into_map();
    metadata.insert(
        MEDIA_TYPE_MEMBER.to_owned(),
        AnyValue(Value::String(manifest.media_type.clone())),
    );
    let metadata = JsonRecord::new(metadata).expect("adding the media type adds no __proto__");
    let metadata_text = serde_json::to_string(&metadata).expect("a JSON record writes as JSON");
    let size_bytes = SqlValue::Integer(i64::from(manifest.size_bytes));
    let mut statements = vec![session_exists_statement(&manifest.session_id)];
    if let Some(run_id) = &manifest.run_id {
        statements.push(run_in_session_statement(&manifest.session_id, run_id));
    }
    let artifact_id_text = manifest.artifact_id.text();
    let run_id_text = manifest.run_id.map(|run_id| run_id.text());
    let plan_id_text = manifest.plan_id.map(|plan_id| plan_id.text());
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
            text_binding("@contentHash", manifest.content_hash.as_str()),
            (Cow::Borrowed("@sizeBytes"), size_bytes.clone()),
            text_binding("@metadata", &metadata_text),
            nullable_text_binding(
                "@workspacePath",
                manifest.workspace_path.as_ref().map(ComposedText::as_str),
            ),
            nullable_text_binding("@planId", plan_id_text.as_ref().map(UuidText::as_str)),
            text_binding("@createdAt", manifest.created_at.as_str()),
        ]),
        expected_row_count: Some(1),
    });
    let pixel = |side: fn(&ArtifactPictureSize) -> SafeInt<1>| {
        manifest
            .natural_size
            .as_ref()
            .map_or(SqlValue::Null, |size| {
                SqlValue::Integer(i64::from(side(size)))
            })
    };
    statements.push(WriteStatement {
        sql: Cow::Borrowed(INSERT_PAYLOAD_REF_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@id", &mint_uuid_v7().to_string()),
            text_binding("@manifestId", artifact_id_text.as_str()),
            text_binding("@storagePath", manifest.content_hash.as_str()),
            text_binding("@mediaType", &manifest.media_type),
            (Cow::Borrowed("@sizeBytes"), size_bytes),
            (Cow::Borrowed("@pixelWidth"), pixel(|size| size.width)),
            (Cow::Borrowed("@pixelHeight"), pixel(|size| size.height)),
            text_binding("@createdAt", manifest.created_at.as_str()),
        ]),
        expected_row_count: Some(1),
    });
    let event = SessionEventDraft::of_session(
        manifest.session_id,
        &SessionEvent::ArtifactPublished(ArtifactPublicationPayload {
            session_id: manifest.session_id,
            artifact_id: Some(manifest.artifact_id),
            run_id: manifest.run_id,
            diff_artifact_id: None,
            rest: serde_json::Map::new(),
        }),
    )
    .expect("an artifact.published payload names only checked ids");
    PublishedManifestWrite {
        statements,
        event,
        manifest: ArtifactManifest {
            id: manifest.artifact_id,
            session_id: manifest.session_id,
            run_id: manifest.run_id,
            created_by: manifest.created_by,
            artifact_type: Extensible::Known(manifest.artifact_type),
            digest: NonEmptyText::new(manifest.content_hash.to_string())
                .expect("a content hash is never empty"),
            size: manifest.size_bytes,
            metadata,
            created_at: manifest.created_at,
            rest: serde_json::Map::new(),
        },
    }
}

/// Writes `manifest`'s row and its payload reference with its `artifact.published` through
/// `appender`, and answers the manifest as the wire carries it. Fails as
/// [`manifest_write_failure`] says, writing nothing.
pub(crate) async fn write_published_manifest(
    appender: &SessionEventAppender,
    manifest: PublishedManifest,
) -> Result<ArtifactManifest, ArtifactError> {
    let PublishedManifestWrite {
        statements,
        event,
        manifest,
    } = published_manifest_write(manifest);
    let appended = appender
        .append(
            event,
            SessionEventLinkage {
                occurred_at: Some(manifest.created_at.clone()),
                transactional_prelude: statements,
                ..SessionEventLinkage::default()
            },
        )
        .await;
    match appended {
        Ok(_receipt) => Ok(manifest),
        Err(failure) => Err(manifest_write_failure(&manifest, failure)),
    }
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
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_contracts::wire::record::JsonRecord;
    use sidekicks_platforms::WallClockTimer;
    use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
    use sidekicks_store::database::writer::test_file::test_session_id;

    use super::{
        PublishedManifest, check_artifact_owner, manifest_created_at, write_published_manifest,
    };
    use crate::id::mint_artifact_id;
    use crate::payload_store::ContentHash;
    use crate::test_store::{ArtifactTestStore, refusal_code_of};

    /// A run of another session never owns an artifact here, so no client writes into another
    /// session's run; the session's own run does. Both the check before spooling and the write's
    /// own check hold it, and a refused write keeps no row and appends no `artifact.published`.
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
            &store.appender,
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
                natural_size: None,
                metadata: JsonRecord::new(BTreeMap::new()).expect("an empty record"),
                workspace_path: None,
                plan_id: None,
                created_at: manifest_created_at(&clock),
            },
        )
        .await;

        assert_eq!(checked.err().as_ref().and_then(refusal_code_of), expected);
        assert_eq!(written.err().as_ref().and_then(refusal_code_of), expected);
        let rows = i64::from(expected.is_none());
        assert_eq!(store.count_rows("artifact_manifests"), rows);
        assert_eq!(store.count_rows("artifact_payload_refs"), rows);
        assert_eq!(store.count_events("artifact.published"), rows);
    }
}
