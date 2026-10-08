//! The index in one folder: Tantivy's writer with its indexing threads and one merge thread, its
//! reader, and the version every search opens on, published after each commit and merge.

use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock};

use serde::{Deserialize, Serialize};
use tantivy::index::SegmentId;
use tantivy::indexer::IndexWriterOptions;
use tantivy::merge_policy::{MergePolicy, NoMergePolicy};
use tantivy::store::Compressor;
use tantivy::{
    Index, IndexReader, IndexSettings, IndexWriter, ReloadPolicy, SegmentMeta, TantivyError,
};

use crate::directory::{FolderDirectory, ReadMode};
use crate::membership::GroupMembership;
use crate::merge_policy::{CappedMergePolicy, SEGMENT_ROW_CAP};
use crate::schema::{
    IndexFields, Owner, index_schema, key_term, owner_term, register_tokenizers, row_document,
};
use crate::version::IndexVersion;
use crate::{IndexBatch, IndexRowKind};

/// Why an index could not be opened.
#[derive(Debug)]
pub enum OpenFailure {
    /// The folder's files cannot be read as this index: the caller removes the folder and
    /// rebuilds it from the database.
    Unreadable(TantivyError),
    /// The folder or the writer could not be set up: a file system error, the writer's lock held
    /// elsewhere, or an arena size Tantivy refuses.
    Other(TantivyError),
}

/// What the newest commit records beside its rows.
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitPayload {
    last_applied_outbox_id: u64,
    /// For each key slot (a key modulo four), the highest key ever added: a row with a higher key
    /// cannot already be in the index, so adding it deletes nothing first.
    highest_row_keys: [u64; 4],
    /// The segments that held a purged session's or a deleted group's rows, still to be rewritten
    /// without them.
    segments_to_expunge: HashSet<SegmentId>,
}

struct Writing {
    writer: IndexWriter,
    highest_row_keys: [u64; 4],
    segments_to_expunge: HashSet<SegmentId>,
}

/// The index in one folder.
pub struct IndexEngine {
    index: Index,
    fields: IndexFields,
    reader: IndexReader,
    // Held through every commit, merge publish and member change, so versions publish in commit
    // order with the members of their own commit; `None` once closed.
    writing: Mutex<Option<Writing>>,
    version: RwLock<Arc<IndexVersion>>,
}

impl IndexEngine {
    /// Opens the index in `folder`, creating the folder and an empty index when there is none. The
    /// writer indexes on `indexing_threads` threads, each with an arena of `writer_memory_bytes`.
    pub fn open(
        folder: &Path,
        writer_memory_bytes: usize,
        indexing_threads: usize,
        read_mode: ReadMode,
    ) -> Result<IndexEngine, OpenFailure> {
        let other = |error: std::io::Error| OpenFailure::Other(TantivyError::from(error));
        fs::create_dir_all(folder).map_err(other)?;
        let directory = FolderDirectory::open(folder, read_mode).map_err(other)?;
        let (schema, fields) = index_schema();
        let exists = Index::exists(&directory)
            .map_err(|error| OpenFailure::Other(TantivyError::from(error)))?;
        let index = if exists {
            let index = Index::open(directory).map_err(OpenFailure::Unreadable)?;
            if index.schema() != schema {
                return Err(OpenFailure::Unreadable(TantivyError::SchemaError(
                    "the folder holds an index with other fields".to_string(),
                )));
            }
            index
        } else {
            let settings = IndexSettings {
                docstore_compression: Compressor::None,
                docstore_compress_dedicated_thread: false,
                ..IndexSettings::default()
            };
            Index::create(directory, schema, settings).map_err(OpenFailure::Other)?
        };
        register_tokenizers(&index);
        let payload = read_payload(&index).map_err(OpenFailure::Unreadable)?;
        let reader: IndexReader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .doc_store_cache_num_blocks(0)
            .try_into()
            .map_err(OpenFailure::Unreadable)?;
        let version = IndexVersion::build(
            reader.searcher(),
            fields,
            None,
            Arc::new(GroupMembership::default()),
            payload.last_applied_outbox_id,
        )
        .map_err(OpenFailure::Unreadable)?;
        let options = IndexWriterOptions::builder()
            .memory_budget_per_thread(writer_memory_bytes)
            .num_worker_threads(indexing_threads)
            .num_merge_threads(1)
            .build();
        let writer: IndexWriter = index
            .writer_with_options(options)
            .map_err(OpenFailure::Other)?;
        writer.set_merge_policy(Box::new(NoMergePolicy));
        Ok(IndexEngine {
            index,
            fields,
            reader,
            writing: Mutex::new(Some(Writing {
                writer,
                highest_row_keys: payload.highest_row_keys,
                segments_to_expunge: payload.segments_to_expunge,
            })),
            version: RwLock::new(Arc::new(version)),
        })
    }

    /// The version searches open on now.
    pub fn current_version(&self) -> Arc<IndexVersion> {
        self.version
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn publish(&self, version: IndexVersion) {
        *self.version.write().unwrap_or_else(PoisonError::into_inner) = Arc::new(version);
    }

    fn lock_writing(&self) -> tantivy::Result<MutexGuard<'_, Option<Writing>>> {
        self.writing.lock().map_err(|_| TantivyError::Poisoned)
    }

    /// Indexes `batch` and commits it durably with its outbox id, then publishes the commit with
    /// the batch's group members. A failed batch is rolled back whole, so replaying it is safe.
    pub fn apply(&self, batch: &IndexBatch) -> tantivy::Result<()> {
        let last_applied_outbox_id = non_negative(batch.last_outbox_id)?;
        let replacements = batch
            .group_members
            .iter()
            .map(|group| {
                Ok((
                    non_negative(group.group_key)?,
                    keys_of(&group.session_keys)?,
                ))
            })
            .collect::<tantivy::Result<Vec<_>>>()?;
        let mut guard = self.lock_writing()?;
        let writing = guard.as_mut().ok_or_else(closed)?;
        let mut committed = CommitPayload {
            last_applied_outbox_id,
            highest_row_keys: writing.highest_row_keys,
            segments_to_expunge: writing.segments_to_expunge.clone(),
        };
        let staged = self.stage(&mut writing.writer, batch, &mut committed);
        if let Err(error) = staged {
            writing.writer.rollback()?;
            return Err(error);
        }
        writing.highest_row_keys = committed.highest_row_keys;
        writing.segments_to_expunge = committed.segments_to_expunge;
        self.reader.reload()?;
        let current = self.current_version();
        let membership = if replacements.is_empty() {
            current.membership.clone()
        } else {
            Arc::new(current.membership.with_replacements(replacements))
        };
        let version = IndexVersion::build(
            self.reader.searcher(),
            self.fields,
            Some(&current),
            membership,
            last_applied_outbox_id,
        )?;
        self.publish(version);
        Ok(())
    }

    // Removals first, then rows: a row in the batch is as the database holds it now. A row whose
    // key is above its slot's highest was never added, so it is added without a delete; any other
    // row replaces whatever its key holds. The segments of a removed owner, a purged session or a
    // deleted group, are noted for rewriting, so its words leave the index's files however few its
    // rows.
    fn stage(
        &self,
        writer: &mut IndexWriter,
        batch: &IndexBatch,
        committed: &mut CommitPayload,
    ) -> tantivy::Result<()> {
        let searcher = self.reader.searcher();
        let highest_row_keys = &mut committed.highest_row_keys;
        for key in &batch.removed_keys {
            let key = non_negative(*key)?;
            if key <= highest_row_keys[(key % 4) as usize] {
                writer.delete_term(key_term(&self.fields, key));
            }
        }
        for removed in &batch.removed_owners {
            let key = non_negative(removed.owner_key)?;
            let owner = if removed.is_group {
                Owner::Group(key)
            } else {
                Owner::Session(key)
            };
            let term = owner_term(&self.fields, owner);
            for segment in searcher.segment_readers() {
                if segment.inverted_index(self.fields.owner)?.doc_freq(&term)? > 0 {
                    committed.segments_to_expunge.insert(segment.segment_id());
                }
            }
            writer.delete_term(term);
        }
        // A noted segment a merge has since rewritten is gone, and its deleted rows with it.
        committed.segments_to_expunge.retain(|noted| {
            searcher
                .segment_readers()
                .iter()
                .any(|segment| segment.segment_id() == *noted)
        });
        for row in &batch.rows {
            let key = non_negative(row.key)?;
            let owner_key = non_negative(row.owner_key)?;
            let owner = match row.kind {
                IndexRowKind::Group => Owner::Group(owner_key),
                IndexRowKind::Event | IndexRowKind::Title | IndexRowKind::Tag => {
                    Owner::Session(owner_key)
                }
            };
            let highest = &mut highest_row_keys[(key % 4) as usize];
            if key <= *highest {
                writer.delete_term(key_term(&self.fields, key));
            } else {
                *highest = key;
            }
            let tag = match &row.tag {
                Some(tag) => Some((
                    tag.fold.as_str(),
                    non_negative(tag.session_last_activity_ms)?,
                )),
                None => None,
            };
            let document = row_document(&self.fields, key, &row.kind, owner, &row.text, tag);
            writer.add_document(document)?;
        }
        let payload = serde_json::to_string(committed)
            .map_err(|error| TantivyError::InternalError(error.to_string()))?;
        let mut commit = writer.prepare_commit()?;
        commit.set_payload(&payload);
        commit.commit()?;
        Ok(())
    }

    /// Replaces every group's members, published with the current rows.
    pub fn set_group_members(&self, groups: Vec<(u64, Vec<u64>)>) -> tantivy::Result<()> {
        let guard = self.lock_writing()?;
        guard.as_ref().ok_or_else(closed)?;
        let version = self
            .current_version()
            .with_membership(Arc::new(GroupMembership::from_groups(groups)));
        self.publish(version);
        Ok(())
    }

    /// Runs one merge step, the smallest the capped merge policy proposes, off the writer's lock,
    /// then publishes the merged segments; returns whether more merging remains.
    pub fn merge_while_idle(&self) -> tantivy::Result<bool> {
        let (policy, merging) = {
            let mut guard = self.lock_writing()?;
            let writing = guard.as_mut().ok_or_else(closed)?;
            let policy =
                CappedMergePolicy::new(SEGMENT_ROW_CAP, writing.segments_to_expunge.clone());
            let Some(segment_ids) =
                smallest_candidate(&policy, &self.index.searchable_segment_metas()?)
            else {
                return Ok(false);
            };
            (policy, writing.writer.merge(&segment_ids))
        };
        merging.wait()?;
        {
            let guard = self.lock_writing()?;
            guard.as_ref().ok_or_else(closed)?;
            self.reader.reload()?;
            let current = self.current_version();
            let version = IndexVersion::build(
                self.reader.searcher(),
                self.fields,
                Some(&current),
                current.membership.clone(),
                current.last_applied_outbox_id,
            )?;
            self.publish(version);
        }
        let segments = self.index.searchable_segment_metas()?;
        Ok(!policy.compute_merge_candidates(&segments).is_empty())
    }

    /// Waits for the writes and the merge under way, then stops the writer's threads; later writes
    /// fail. Searches already open keep their files until released.
    pub fn close(&self) -> tantivy::Result<()> {
        let writing = self.lock_writing()?.take();
        if let Some(writing) = writing {
            writing.writer.wait_merging_threads()?;
        }
        Ok(())
    }
}

fn smallest_candidate(
    policy: &CappedMergePolicy,
    segments: &[SegmentMeta],
) -> Option<Vec<SegmentId>> {
    let rows_of = |id: &SegmentId| {
        segments
            .iter()
            .find(|segment| segment.id() == *id)
            .map_or(0, |segment| segment.max_doc())
    };
    policy
        .compute_merge_candidates(segments)
        .into_iter()
        .map(|candidate| candidate.0)
        .min_by_key(|ids| ids.iter().map(|id| u64::from(rows_of(id))).sum::<u64>())
}

fn read_payload(index: &Index) -> tantivy::Result<CommitPayload> {
    match index.load_metas()?.payload {
        None => Ok(CommitPayload::default()),
        Some(payload) => serde_json::from_str(&payload).map_err(|error| {
            TantivyError::SchemaError(format!("unreadable commit payload: {error}"))
        }),
    }
}

fn closed() -> TantivyError {
    TantivyError::SystemError("the search index is closed".to_string())
}

/// The largest key or outbox id: JavaScript numbers hold integers exactly up to it.
const MAX_KEY: u64 = (1 << 53) - 1;

/// `value` as a key or an outbox id, which are integers from 0 to 2^53 - 1.
pub fn non_negative(value: i64) -> tantivy::Result<u64> {
    u64::try_from(value)
        .ok()
        .filter(|key| *key <= MAX_KEY)
        .ok_or_else(|| {
            TantivyError::InvalidArgument(format!("{value} is not an integer from 0 to 2^53 - 1"))
        })
}

/// `values` as keys.
pub fn keys_of(values: &[i64]) -> tantivy::Result<Vec<u64>> {
    values.iter().map(|value| non_negative(*value)).collect()
}
