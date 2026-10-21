//! One artifact's read: the version in view, picked within its path's group when a chat wrote it,
//! with how many versions the group has, a picture's size, and as much of its payload as the
//! request picks. The id of any version names the group; a read with no version answers the
//! newest. A plan or any artifact no chat wrote is version 1 of 1.

use std::fs::File;
use std::io::{self, Read as _, Seek as _, SeekFrom};
use std::path::Path;
use std::sync::LazyLock;

use bytes::Bytes as ByteBuffer;
use rusqlite::{Connection, OptionalExtension as _, named_params};
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::artifacts::manifest::ArtifactManifest;
use sidekicks_contracts::artifacts::operations::{
    ArtifactPayloadSelection, ArtifactPictureSize, ArtifactReadDeferred, ArtifactReadInline,
    ArtifactReadRequest, ArtifactReadResponse,
};
use sidekicks_contracts::jsonrpc::framing::MAX_ONE_ATTACHMENT_BYTES;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::attachment::Bytes;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;

use crate::artifacts::manifest_write::{MANIFEST_COLUMN_COUNT, MANIFEST_COLUMNS, read_manifest};
use crate::artifacts::payload_store::{ContentHash, PayloadStore};
use crate::artifacts::refusals::{ArtifactError, artifact_not_found};
use crate::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use crate::database::stored_column::{safe_int_column, text_column};

// The one version of an artifact no chat wrote.
const ONLY_VERSION: SafeInt<1> = SafeInt::new(1).expect("1 is a safe integer from 1");

// The named manifest's session and path.
const GROUP_OF_SQL: &str = "SELECT session_id, workspace_path
  FROM artifact_manifests WHERE id = @artifactId";

// How many versions a path's group holds.
const VERSION_COUNT_SQL: &str = "SELECT MAX(version_number)
  FROM artifact_manifests WHERE session_id = @sessionId AND workspace_path = @workspacePath";

// One version of a path's group, with its payload reference.
static VERSION_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {MANIFEST_COLUMNS}, refs.storage_path, refs.pixel_width, refs.pixel_height
  FROM artifact_manifests AS manifests
  JOIN artifact_payload_refs AS refs ON refs.manifest_id = manifests.id
  WHERE manifests.session_id = @sessionId AND manifests.workspace_path = @workspacePath
    AND manifests.version_number = @versionNumber"
    )
});

// One artifact no chat wrote, with its payload reference.
static ARTIFACT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {MANIFEST_COLUMNS}, refs.storage_path, refs.pixel_width, refs.pixel_height
  FROM artifact_manifests AS manifests
  JOIN artifact_payload_refs AS refs ON refs.manifest_id = manifests.id
  WHERE manifests.id = @artifactId"
    )
});

/// The version a read lands on, as its rows hold it.
struct StoredVersion {
    manifest: ArtifactManifest,
    content_hash: ContentHash,
    natural_size: Option<ArtifactPictureSize>,
    version_number: SafeInt<1>,
    version_count: SafeInt<1>,
}

/// Reads `request`'s artifact and as much of its payload as it picks. Fails with
/// `artifact.notFound` for an id the daemon does not hold or a version past the group's count, as
/// the read fails, and as the payload's file read fails.
pub(crate) async fn read_artifact(
    reads: &DatabaseReadPool,
    payloads: &PayloadStore,
    request: ArtifactReadRequest,
) -> Result<ArtifactReadResponse, ArtifactError> {
    let artifact_id = request.artifact_id;
    let version = request.version;
    let stored = reads
        .read(ReadLength::Short, move |connection| {
            read_version(connection, artifact_id, version)?
                .ok_or_else(|| ArtifactError::from(artifact_not_found(artifact_id, version)))
        })
        .await?;
    let payload_path = payloads.object_path_of(&stored.content_hash);
    let size = stored.manifest.size.get();
    let window = match request.payload_selection {
        ArtifactPayloadSelection::None {} => None,
        ArtifactPayloadSelection::Whole {} => usize::try_from(size)
            .ok()
            .filter(|length| *length <= MAX_ONE_ATTACHMENT_BYTES)
            .map(|length| (0, length)),
        ArtifactPayloadSelection::Range { offset, length } => {
            let start = offset.get().min(size);
            let length = u64::try_from(length.get())
                .expect("a window's length is at least 1")
                .min(size - start);
            Some((
                start,
                usize::try_from(length).expect("a window is at most one chunk"),
            ))
        }
    };
    let payload_handle =
        NonEmptyText::new(stored.content_hash.to_string()).expect("a content hash is never empty");
    let response = match window {
        None => ArtifactReadResponse::Deferred(ArtifactReadDeferred {
            manifest: stored.manifest,
            version_number: stored.version_number,
            version_count: stored.version_count,
            natural_size: stored.natural_size,
            pdf_preview: None,
            payload_handle,
            payload: None,
        }),
        Some((start, length)) => {
            let bytes =
                tokio::task::spawn_blocking(move || read_window(&payload_path, start, length))
                    .await??;
            ArtifactReadResponse::Inline(ArtifactReadInline {
                manifest: stored.manifest,
                version_number: stored.version_number,
                version_count: stored.version_count,
                natural_size: stored.natural_size,
                pdf_preview: None,
                payload_handle: Some(payload_handle),
                payload: Bytes::new(ByteBuffer::from(bytes))
                    .expect("a window is at most one message's attachment"),
            })
        }
    };
    Ok(response)
}

// The version `version` of `artifact_id`'s group, the newest when `None`; `None` for an id no
// manifest holds or a version past the count.
fn read_version(
    connection: &Connection,
    artifact_id: ArtifactId,
    version: Option<SafeInt<1>>,
) -> Result<Option<StoredVersion>, ArtifactError> {
    let Some((session_id, workspace_path)) = connection
        .prepare_cached(GROUP_OF_SQL)?
        .query_row(
            named_params! { "@artifactId": artifact_id.text().as_str() },
            |row| {
                Ok((
                    text_column(row, 0, |text| SessionId::new(&text))?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()?
    else {
        return Ok(None);
    };
    let Some(workspace_path) = workspace_path else {
        if version.is_some_and(|version| version.get() != 1) {
            return Ok(None);
        }
        return Ok(connection
            .prepare_cached(&ARTIFACT_SQL)?
            .query_row(
                named_params! { "@artifactId": artifact_id.text().as_str() },
                |row| read_stored_version(row, session_id, ONLY_VERSION, ONLY_VERSION),
            )
            .optional()?);
    };
    let version_count: SafeInt<1> = connection.prepare_cached(VERSION_COUNT_SQL)?.query_row(
        named_params! {
            "@sessionId": session_id.text().as_str(),
            "@workspacePath": workspace_path,
        },
        |row| safe_int_column(row, 0),
    )?;
    let version_number = version.unwrap_or(version_count);
    if version_number.get() > version_count.get() {
        return Ok(None);
    }
    Ok(connection
        .prepare_cached(&VERSION_SQL)?
        .query_row(
            named_params! {
                "@sessionId": session_id.text().as_str(),
                "@workspacePath": workspace_path,
                "@versionNumber": i64::from(version_number),
            },
            |row| read_stored_version(row, session_id, version_number, version_count),
        )
        .optional()?)
}

// A version's manifest and payload reference, read from a row of one of the version reads.
fn read_stored_version(
    row: &rusqlite::Row<'_>,
    session_id: SessionId,
    version_number: SafeInt<1>,
    version_count: SafeInt<1>,
) -> rusqlite::Result<StoredVersion> {
    let width = optional_safe_int(row, MANIFEST_COLUMN_COUNT + 1)?;
    let height = optional_safe_int(row, MANIFEST_COLUMN_COUNT + 2)?;
    Ok(StoredVersion {
        manifest: read_manifest(row, session_id)?,
        content_hash: text_column(row, MANIFEST_COLUMN_COUNT, ContentHash::from_stored)?,
        natural_size: width
            .zip(height)
            .map(|(width, height)| ArtifactPictureSize { width, height }),
        version_number,
        version_count,
    })
}

// A pixel count a payload reference holds, or `None` for a payload that is no picture.
fn optional_safe_int(
    row: &rusqlite::Row<'_>,
    index: usize,
) -> rusqlite::Result<Option<SafeInt<1>>> {
    match row.get::<_, Option<i64>>(index)? {
        None => Ok(None),
        Some(_) => safe_int_column(row, index).map(Some),
    }
}

// `length` bytes of the payload at `path` from `start`, or up to its end.
fn read_window(path: &Path, start: u64, length: usize) -> io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::with_capacity(length);
    file.take(u64::try_from(length).expect("a window fits a u64"))
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}
