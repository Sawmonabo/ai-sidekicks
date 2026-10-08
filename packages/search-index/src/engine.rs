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
    FutureResult, Index, IndexReader, IndexSettings, IndexWriter, ReloadPolicy, Searcher,
    SegmentMeta, TantivyError,
};

use crate::directory::{FolderDirectory, ReadMode};
use crate::membership::GroupMembership;
use crate::merge_policy::{CappedMergePolicy, SEGMENT_ROW_CAP};
use crate::schema::{
    IndexFields, Owner, index_schema, key_term, owner_of, owner_term, owner_value,
    register_tokenizers, row_document,
};
use crate::version::IndexVersion;
use crate::{GroupMembers, IndexBatch, IndexRowKind};

/// What every call on a closed index fails with.
pub const CLOSED_MESSAGE: &str = "the search index is closed";

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
    /// The owner field values of the owners removed while a merge ran. The segment that merge
    /// writes holds their rows deleted, not expunged, so it is noted by them once the merge ends,
    /// or at the next open when the daemon stopped first.
    owners_removed_while_merging: Vec<u64>,
}

struct Writing {
    writer: IndexWriter,
    last_applied_outbox_id: u64,
    highest_row_keys: [u64; 4],
    segments_to_expunge: HashSet<SegmentId>,
    owners_removed_while_merging: Vec<u64>,
    running_merges: usize,
}

impl Writing {
    fn payload(&self) -> CommitPayload {
        CommitPayload {
            last_applied_outbox_id: self.last_applied_outbox_id,
            highest_row_keys: self.highest_row_keys,
            segments_to_expunge: self.segments_to_expunge.clone(),
            owners_removed_while_merging: self.owners_removed_while_merging.clone(),
        }
    }
}

/// A merge under way, resolving to the segment it writes, none when every row it took was deleted.
pub(crate) type RunningMerge = FutureResult<Option<SegmentMeta>>;

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
        let mut payload = read_payload(&index).map_err(OpenFailure::Unreadable)?;
        let reader: IndexReader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .doc_store_cache_num_blocks(0)
            .try_into()
            .map_err(OpenFailure::Unreadable)?;
        // Owners removed while a merge ran whose segments the daemon stopped before noting: noted
        // now. The next commit records the notes; until then the payload still holds the owners.
        note_segments_holding(
            &reader.searcher(),
            &fields,
            &payload.owners_removed_while_merging,
            &mut payload.segments_to_expunge,
        )
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
                last_applied_outbox_id: payload.last_applied_outbox_id,
                highest_row_keys: payload.highest_row_keys,
                segments_to_expunge: payload.segments_to_expunge,
                owners_removed_while_merging: Vec::new(),
                running_merges: 0,
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
    /// the batch's group members. A key out of range fails the batch before anything is staged,
    /// and a batch whose commit fails is rolled back whole, so replaying it is safe. A failure
    /// after the commit, while publishing it, leaves the commit durable.
    pub fn apply(&self, batch: &IndexBatch) -> tantivy::Result<()> {
        let batch = CheckedBatch::check(batch)?;
        let mut guard = self.lock_writing()?;
        let writing = guard.as_mut().ok_or_else(closed)?;
        let mut committed = CommitPayload {
            last_applied_outbox_id: batch.last_applied_outbox_id,
            ..writing.payload()
        };
        if writing.running_merges > 0 {
            committed
                .owners_removed_while_merging
                .extend(&batch.removed_owners);
        }
        if let Err(error) = self.stage(&mut writing.writer, &batch, &mut committed) {
            return Err(roll_back(&mut writing.writer, error));
        }
        writing.last_applied_outbox_id = committed.last_applied_outbox_id;
        writing.highest_row_keys = committed.highest_row_keys;
        writing.segments_to_expunge = committed.segments_to_expunge;
        writing.owners_removed_while_merging = committed.owners_removed_while_merging;
        self.reader.reload()?;
        let current = self.current_version();
        let membership = if batch.group_members.is_empty() {
            current.membership.clone()
        } else {
            Arc::new(current.membership.with_replacements(batch.group_members))
        };
        let version = IndexVersion::build(
            self.reader.searcher(),
            self.fields,
            Some(&current),
            membership,
            batch.last_applied_outbox_id,
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
        batch: &CheckedBatch<'_>,
        committed: &mut CommitPayload,
    ) -> tantivy::Result<()> {
        let searcher = self.reader.searcher();
        let highest_row_keys = &mut committed.highest_row_keys;
        for key in &batch.removed_keys {
            if *key <= highest_row_keys[(key % 4) as usize] {
                writer.delete_term(key_term(&self.fields, *key));
            }
        }
        note_segments_holding(
            &searcher,
            &self.fields,
            &batch.removed_owners,
            &mut committed.segments_to_expunge,
        )?;
        for owner in &batch.removed_owners {
            writer.delete_term(owner_term(&self.fields, owner_of(*owner)));
        }
        // A noted segment no longer searched is gone, merged away or emptied, and its deleted rows
        // with it.
        committed.segments_to_expunge.retain(|noted| {
            searcher
                .segment_readers()
                .iter()
                .any(|segment| segment.segment_id() == *noted)
        });
        for row in &batch.rows {
            let highest = &mut highest_row_keys[(row.key % 4) as usize];
            if row.key <= *highest {
                writer.delete_term(key_term(&self.fields, row.key));
            } else {
                *highest = row.key;
            }
            let document = row_document(
                &self.fields,
                row.key,
                row.kind,
                row.owner,
                row.text,
                row.tag,
            );
            writer.add_document(document)?;
        }
        commit_with_payload(writer, committed)
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
    pub fn merge_segments(&self) -> tantivy::Result<bool> {
        match self.start_merge()? {
            Some(merge) => self.finish_merge(merge),
            None => Ok(false),
        }
    }

    /// Starts the smallest merge the policy proposes, when it proposes one.
    pub(crate) fn start_merge(&self) -> tantivy::Result<Option<RunningMerge>> {
        let mut guard = self.lock_writing()?;
        let writing = guard.as_mut().ok_or_else(closed)?;
        let policy = CappedMergePolicy::new(SEGMENT_ROW_CAP, writing.segments_to_expunge.clone());
        let Some(segment_ids) =
            smallest_candidate(&policy, &self.index.searchable_segment_metas()?)
        else {
            return Ok(None);
        };
        writing.running_merges += 1;
        Ok(Some(writing.writer.merge(&segment_ids)))
    }

    /// Waits for `merge` off the writer's lock. Under it, once no merge runs, the segments holding
    /// an owner removed meanwhile are noted, the merged one among them, and committed so a restart
    /// keeps them; then the merged segments are published. Returns whether more merging remains.
    pub(crate) fn finish_merge(&self, merge: RunningMerge) -> tantivy::Result<bool> {
        let merged = merge.wait();
        let mut guard = self.lock_writing()?;
        let writing = guard.as_mut().ok_or_else(closed)?;
        writing.running_merges -= 1;
        merged?;
        self.reader.reload()?;
        if writing.running_merges == 0 && !writing.owners_removed_while_merging.is_empty() {
            note_segments_holding(
                &self.reader.searcher(),
                &self.fields,
                &writing.owners_removed_while_merging,
                &mut writing.segments_to_expunge,
            )?;
            writing.owners_removed_while_merging.clear();
            let payload = writing.payload();
            if let Err(error) = commit_with_payload(&mut writing.writer, &payload) {
                return Err(roll_back(&mut writing.writer, error));
            }
        }
        let current = self.current_version();
        let version = IndexVersion::build(
            self.reader.searcher(),
            self.fields,
            Some(&current),
            current.membership.clone(),
            current.last_applied_outbox_id,
        )?;
        self.publish(version);
        let policy = CappedMergePolicy::new(SEGMENT_ROW_CAP, writing.segments_to_expunge.clone());
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

// A batch with every key, owner and time checked, so a bad one fails it before anything is staged.
struct CheckedBatch<'a> {
    last_applied_outbox_id: u64,
    removed_keys: Vec<u64>,
    /// The removed owners as the owner field holds them.
    removed_owners: Vec<u64>,
    rows: Vec<CheckedRow<'a>>,
    group_members: Vec<(u64, Vec<u64>)>,
}

struct CheckedRow<'a> {
    key: u64,
    kind: &'a IndexRowKind,
    owner: Owner,
    text: &'a str,
    tag: Option<(&'a str, u64)>,
}

impl<'a> CheckedBatch<'a> {
    fn check(batch: &'a IndexBatch) -> tantivy::Result<CheckedBatch<'a>> {
        let removed_owners = batch
            .removed_owners
            .iter()
            .map(|removed| {
                let key = key_from_js(removed.owner_key)?;
                Ok(owner_value(if removed.is_group {
                    Owner::Group(key)
                } else {
                    Owner::Session(key)
                }))
            })
            .collect::<tantivy::Result<Vec<_>>>()?;
        let rows = batch
            .rows
            .iter()
            .map(|row| {
                let owner_key = key_from_js(row.owner_key)?;
                let owner = match row.kind {
                    IndexRowKind::Group => Owner::Group(owner_key),
                    IndexRowKind::Event | IndexRowKind::Title | IndexRowKind::Tag => {
                        Owner::Session(owner_key)
                    }
                };
                let tag = match &row.tag {
                    Some(tag) => Some((
                        tag.fold.as_str(),
                        key_from_js(tag.session_last_activity_ms)?,
                    )),
                    None => None,
                };
                Ok(CheckedRow {
                    key: key_from_js(row.key)?,
                    kind: &row.kind,
                    owner,
                    text: &row.text,
                    tag,
                })
            })
            .collect::<tantivy::Result<Vec<_>>>()?;
        Ok(CheckedBatch {
            last_applied_outbox_id: key_from_js(batch.last_outbox_id)?,
            removed_keys: keys_of(&batch.removed_keys)?,
            removed_owners,
            rows,
            group_members: group_members_from_js(&batch.group_members)?,
        })
    }
}

// Adds to `noted` each segment of `searcher` holding a row of an owner in `owners`, an owner field
// value each, deleted rows counted, since a rewrite is what expunges those.
fn note_segments_holding(
    searcher: &Searcher,
    fields: &IndexFields,
    owners: &[u64],
    noted: &mut HashSet<SegmentId>,
) -> tantivy::Result<()> {
    for owner in owners {
        let term = owner_term(fields, owner_of(*owner));
        for segment in searcher.segment_readers() {
            if segment.inverted_index(fields.owner)?.doc_freq(&term)? > 0 {
                noted.insert(segment.segment_id());
            }
        }
    }
    Ok(())
}

// Commits what `writer` holds, `payload` recorded beside it.
fn commit_with_payload(writer: &mut IndexWriter, payload: &CommitPayload) -> tantivy::Result<()> {
    let payload = serde_json::to_string(payload)
        .map_err(|error| TantivyError::InternalError(error.to_string()))?;
    let mut commit = writer.prepare_commit()?;
    commit.set_payload(&payload);
    commit.commit()?;
    Ok(())
}

// Drops what `writer` staged since its last commit after `error`; returns `error`, with the
// rollback's own failure added when it fails too.
fn roll_back(writer: &mut IndexWriter, error: TantivyError) -> TantivyError {
    match writer.rollback() {
        Ok(_) => error,
        Err(rollback_error) => TantivyError::InternalError(format!(
            "{error}; rolling back the staged batch then failed: {rollback_error}"
        )),
    }
}

/// The merge an idle step runs: the one the policy proposes over the fewest rows, deleted included.
pub(crate) fn smallest_candidate(
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
    TantivyError::SystemError(CLOSED_MESSAGE.to_string())
}

/// The largest key or outbox id: JavaScript numbers hold integers exactly up to it.
const MAX_KEY: u64 = (1 << 53) - 1;

/// `value` as a key or an outbox id, which are integers from 0 to 2^53 - 1; any other value fails
/// as an invalid argument.
pub fn key_from_js(value: i64) -> tantivy::Result<u64> {
    u64::try_from(value)
        .ok()
        .filter(|key| *key <= MAX_KEY)
        .ok_or_else(|| {
            TantivyError::InvalidArgument(format!("{value} is not an integer from 0 to 2^53 - 1"))
        })
}

/// `values` as keys.
pub fn keys_of(values: &[i64]) -> tantivy::Result<Vec<u64>> {
    values.iter().map(|value| key_from_js(*value)).collect()
}

/// Each group's key with its sessions' keys, as a batch or a load carries them.
pub fn group_members_from_js(groups: &[GroupMembers]) -> tantivy::Result<Vec<(u64, Vec<u64>)>> {
    groups
        .iter()
        .map(|group| Ok((key_from_js(group.group_key)?, keys_of(&group.session_keys)?)))
        .collect()
}
