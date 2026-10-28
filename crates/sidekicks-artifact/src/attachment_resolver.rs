//! Binds each attachment a message carries to the stored copy its manifest names, in the order the
//! sender staged them. An attachment that can no longer be bound keeps its place as an unresolved
//! marker naming why, so the list never shortens and the recipient reads which file is missing.

use std::error::Error;
use std::sync::Arc;

use futures::FutureExt;
use futures::future::BoxFuture;
use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::driver::attachments::{
    AttachmentResolver, ProviderAttachment, ResolvedAttachment, UnresolvedAttachmentCause,
    UnresolvedAttachmentMarker,
};
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::stored_column::text_column;

use crate::payload_store::{ContentHash, PayloadStore};
use crate::refusals::ArtifactError;
use crate::validation::FILE_NAME_MEMBER;

// The manifest's newest payload reference within the message's session; a manifest whose payload
// was reclaimed has none.
const SELECT_PAYLOAD_SQL: &str = "SELECT refs.storage_path, refs.media_type,
       json_extract(manifests.metadata, @fileNamePath)
  FROM artifact_manifests AS manifests
  JOIN artifact_payload_refs AS refs ON refs.manifest_id = manifests.id
  WHERE manifests.id = @artifactId AND manifests.session_id = @sessionId
  ORDER BY refs.created_at DESC, refs.id DESC
  LIMIT 1";

/// One attachment's stored payload as its row names it.
struct StoredPayload {
    content_hash: ContentHash,
    media_type: String,
    file_name: Option<String>,
}

/// Resolves a message's attachments against the session's manifests and the payload store.
pub struct ArtifactAttachmentResolver {
    reads: Arc<DatabaseReadPool>,
    payloads: Arc<PayloadStore>,
}

impl ArtifactAttachmentResolver {
    /// A resolver reading through the daemon's read pool and naming paths in `payloads`.
    pub fn new(reads: Arc<DatabaseReadPool>, payloads: Arc<PayloadStore>) -> Self {
        Self { reads, payloads }
    }

    // Each id bound to its stored copy, named as it was sent or by its id where its manifest
    // records no name, or the `deleted` marker where the session holds no payload for it.
    async fn resolve(
        &self,
        session_id: SessionId,
        artifact_ids: Vec<ArtifactId>,
    ) -> Result<Vec<ProviderAttachment>, ArtifactError> {
        let payloads = Arc::clone(&self.payloads);
        self.reads
            .read(ReadLength::Short, move |connection| {
                artifact_ids
                    .into_iter()
                    .map(|artifact_id| {
                        let attachment =
                            match read_stored_payload(connection, &session_id, &artifact_id)? {
                                Some(stored) => ProviderAttachment::Resolved(ResolvedAttachment {
                                    artifact_id,
                                    path: payloads.object_path_of(&stored.content_hash),
                                    file_name: stored
                                        .file_name
                                        .unwrap_or_else(|| artifact_id.text().as_str().to_owned()),
                                    media_type: stored.media_type,
                                }),
                                None => {
                                    ProviderAttachment::Unresolved(UnresolvedAttachmentMarker {
                                        artifact_id,
                                        cause: UnresolvedAttachmentCause::Deleted,
                                    })
                                }
                            };
                        Ok(attachment)
                    })
                    .collect()
            })
            .await
    }
}

impl AttachmentResolver for ArtifactAttachmentResolver {
    fn resolve_attachments(
        &self,
        session_id: SessionId,
        artifact_ids: Vec<ArtifactId>,
    ) -> BoxFuture<'_, Result<Vec<ProviderAttachment>, Box<dyn Error + Send + Sync>>> {
        async move {
            self.resolve(session_id, artifact_ids)
                .await
                .map_err(|error| Box::new(error) as Box<dyn Error + Send + Sync>)
        }
        .boxed()
    }
}

// The newest payload of `artifact_id` within `session_id`; a file name that is not text reads as
// none. Fails as SQLite does, or when a stored key is no content hash.
fn read_stored_payload(
    connection: &Connection,
    session_id: &SessionId,
    artifact_id: &ArtifactId,
) -> Result<Option<StoredPayload>, ArtifactError> {
    let stored = connection
        .prepare_cached(SELECT_PAYLOAD_SQL)?
        .query_row(
            named_params! {
                "@artifactId": artifact_id.text().as_str(),
                "@sessionId": session_id.text().as_str(),
                "@fileNamePath": format!("$.{FILE_NAME_MEMBER}"),
            },
            |row| {
                Ok(StoredPayload {
                    content_hash: text_column(row, 0, ContentHash::from_stored)?,
                    media_type: row.get(1)?,
                    file_name: match row.get_ref(2)? {
                        rusqlite::types::ValueRef::Text(text) => {
                            Some(String::from_utf8_lossy(text).into_owned())
                        }
                        rusqlite::types::ValueRef::Null
                        | rusqlite::types::ValueRef::Integer(_)
                        | rusqlite::types::ValueRef::Real(_)
                        | rusqlite::types::ValueRef::Blob(_) => None,
                    },
                })
            },
        )
        .optional()?;
    Ok(stored)
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;

    use sidekicks_contracts::artifacts::id::ArtifactId;
    use sidekicks_provider::driver::attachments::{
        AttachmentResolver, ProviderAttachment, ResolvedAttachment, UnresolvedAttachmentCause,
        UnresolvedAttachmentMarker,
    };
    use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
    use sidekicks_store::database::writer::test_file::test_session_id;

    use super::ArtifactAttachmentResolver;
    use crate::id::mint_artifact_id;
    use crate::test_store::ArtifactTestStore;

    const CONTENT_HASH: &str =
        "sha256:0000000000000000000000000000000000000000000000000000000000000000";

    // A manifest of `session_id` with one payload reference, named `notes.txt`.
    fn manifest_rows(artifact_id: &ArtifactId, session_id: &str) -> Vec<WriteStatement> {
        let artifact_text = artifact_id.text();
        vec![
            WriteStatement {
                sql: Cow::Borrowed(
                    "INSERT INTO artifact_manifests (id, session_id, artifact_type,
                       content_hash, size_bytes, metadata, created_at)
                     VALUES (@id, @sessionId, 'file', @hash, 5,
                       '{\"fileName\":\"notes.txt\"}', '2026-10-18T09:00:00.000Z')",
                ),
                bindings: StatementBindings::Named(vec![
                    text_binding("@id", artifact_text.as_str()),
                    text_binding("@sessionId", session_id),
                    text_binding("@hash", CONTENT_HASH),
                ]),
                expected_row_count: Some(1),
            },
            WriteStatement {
                sql: Cow::Borrowed(
                    "INSERT INTO artifact_payload_refs (id, manifest_id, storage_path, media_type,
                       size_bytes, created_at)
                     VALUES (@id, @id, @hash, 'text/plain', 5, '2026-10-18T09:00:00.000Z')",
                ),
                bindings: StatementBindings::Named(vec![
                    text_binding("@id", artifact_text.as_str()),
                    text_binding("@hash", CONTENT_HASH),
                ]),
                expected_row_count: Some(1),
            },
        ]
    }

    /// A manifest of another session never binds, so one session cannot read another's file; the
    /// session's own binds in its place, and a missing one keeps its place as a marker.
    #[tokio::test]
    async fn binds_only_the_sessions_own_manifests_in_staging_order() {
        let store = ArtifactTestStore::open().await;
        let own = mint_artifact_id();
        let others = mint_artifact_id();
        let missing = mint_artifact_id();
        let other_session = test_session_id();
        let mut statements = manifest_rows(&own, store.session_id.text().as_str());
        statements.extend(manifest_rows(&others, other_session.text().as_str()));
        store
            .writer
            .write(statements)
            .await
            .expect("the test writes two manifests");
        let resolver = ArtifactAttachmentResolver::new(store.reads.clone(), store.payloads.clone());

        let attachments = resolver
            .resolve_attachments(store.session_id, vec![others, own, missing])
            .await
            .expect("the resolver reads the store");

        let content_hash = crate::payload_store::ContentHash::from_stored(CONTENT_HASH.to_owned())
            .expect("the test's hash is one");
        assert_eq!(
            attachments,
            vec![
                ProviderAttachment::Unresolved(UnresolvedAttachmentMarker {
                    artifact_id: others,
                    cause: UnresolvedAttachmentCause::Deleted,
                }),
                ProviderAttachment::Resolved(ResolvedAttachment {
                    artifact_id: own,
                    path: store.payloads.object_path_of(&content_hash),
                    file_name: "notes.txt".to_owned(),
                    media_type: "text/plain".to_owned(),
                }),
                ProviderAttachment::Unresolved(UnresolvedAttachmentMarker {
                    artifact_id: missing,
                    cause: UnresolvedAttachmentCause::Deleted,
                }),
            ]
        );
    }
}
