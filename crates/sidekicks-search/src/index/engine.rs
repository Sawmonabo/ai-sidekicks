//! The index in one folder: Tantivy's writer with its indexing thread and one merge thread, its
//! reader, and the version every search opens on, published after each commit and merge.

use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
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

use crate::index::directory::{FolderDirectory, ReadCaches, ReadMode};
use crate::index::find;
use crate::index::membership::GroupMembership;
use crate::index::merge_policy::{CappedMergePolicy, SEGMENT_ROW_CAP};
use crate::index::schema::{
    IndexFields, Owner, index_schema, key_term, owner_of, owner_term, owner_value,
    register_tokenizers, row_document,
};
use crate::index::version::IndexVersion;
use crate::index::view::HeldSearch;
use crate::index::{
    GroupMembers, IndexBatch, IndexRowKind, SearchIndexError, SearchIndexOptions, SearchQuery,
    SessionFind,
};

// One indexing thread, so a rebuild or a batch leaves the machine's other cores free.
const INDEXING_THREADS: usize = 1;

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

/// The daemon's session search index in one folder; one instance per folder.
pub struct SearchIndex {
    index: Index,
    fields: IndexFields,
    reader: IndexReader,
    // Held through every commit, merge publish and member change, so versions publish in commit
    // order with the members of their own commit; `None` once closed.
    writing: Mutex<Option<Writing>>,
    // Set by `close`, so a search refuses a closed index without waiting on a commit's lock.
    is_closed: AtomicBool,
    version: RwLock<Arc<IndexVersion>>,
    read_caches: Arc<ReadCaches>,
}

impl SearchIndex {
    /// Opens the index in `folder`, creating the folder and an empty index when there is none.
    /// Fails with `SearchIndexError::Unreadable` when the folder's files cannot be read as this
    /// index, so the caller removes the folder and rebuilds it from the database.
    pub fn open(
        folder: &Path,
        options: SearchIndexOptions,
    ) -> Result<SearchIndex, SearchIndexError> {
        SearchIndex::open_in(folder, options, ReadMode::DEFAULT)
    }

    /// `open`, reading the index's files in `read_mode`.
    pub(crate) fn open_in(
        folder: &Path,
        options: SearchIndexOptions,
        read_mode: ReadMode,
    ) -> Result<SearchIndex, SearchIndexError> {
        fs::create_dir_all(folder).map_err(TantivyError::from)?;
        let directory = FolderDirectory::open(folder, read_mode).map_err(TantivyError::from)?;
        let (schema, fields) = index_schema();
        let exists = Index::exists(&directory).map_err(TantivyError::from)?;
        let index = if exists {
            let index = Index::open(directory).map_err(SearchIndexError::Unreadable)?;
            if index.schema() != schema {
                return Err(SearchIndexError::Unreadable(TantivyError::SchemaError(
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
            Index::create(directory, schema, settings)?
        };
        register_tokenizers(&index);
        let mut payload = read_payload(&index).map_err(SearchIndexError::Unreadable)?;
        let reader: IndexReader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .doc_store_cache_num_blocks(0)
            .try_into()
            .map_err(SearchIndexError::Unreadable)?;
        // Owners removed while a merge ran whose segments the daemon stopped before noting: noted
        // now. The next commit records the notes; until then the payload still holds the owners.
        note_segments_holding(
            &reader.searcher(),
            &fields,
            &payload.owners_removed_while_merging,
            &mut payload.segments_to_expunge,
        )
        .map_err(SearchIndexError::Unreadable)?;
        let version = IndexVersion::build(
            reader.searcher(),
            fields,
            None,
            Arc::new(GroupMembership::default()),
            payload.last_applied_outbox_id,
        )
        .map_err(SearchIndexError::Unreadable)?;
        let writer_options = IndexWriterOptions::builder()
            .memory_budget_per_thread(options.writer_memory_bytes)
            .num_worker_threads(INDEXING_THREADS)
            .num_merge_threads(1)
            .build();
        let writer: IndexWriter = index.writer_with_options(writer_options)?;
        writer.set_merge_policy(Box::new(NoMergePolicy));
        Ok(SearchIndex {
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
            is_closed: AtomicBool::new(false),
            version: RwLock::new(Arc::new(version)),
            read_caches: Arc::default(),
        })
    }

    /// The outbox id the newest durable commit records; 0 for a new index.
    pub fn last_applied_outbox_id(&self) -> u64 {
        self.current_version().last_applied_outbox_id
    }

    /// The version searches open on now.
    pub(crate) fn current_version(&self) -> Arc<IndexVersion> {
        self.version
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// The read caches of the searches held on this index, bounded together.
    pub(crate) fn read_caches(&self) -> &Arc<ReadCaches> {
        &self.read_caches
    }

    fn publish(&self, version: IndexVersion) {
        *self.version.write().unwrap_or_else(PoisonError::into_inner) = Arc::new(version);
    }

    fn lock_writing(&self) -> tantivy::Result<MutexGuard<'_, Option<Writing>>> {
        self.writing.lock().map_err(TantivyError::from)
    }

    fn refuse_when_closed(&self) -> Result<(), SearchIndexError> {
        if self.is_closed.load(Ordering::Acquire) {
            return Err(SearchIndexError::Closed);
        }
        Ok(())
    }

    /// Indexes `batch` and commits it durably with its outbox id, then publishes the commit with
    /// the batch's group members; searches opened afterward see it. A batch whose commit fails is
    /// rolled back whole, so replaying it is safe, and applying the same batch twice leaves the
    /// index as one apply does. A failure after the commit, while publishing it, leaves the commit
    /// durable. Blocks on the disk write.
    pub fn apply(&self, batch: &IndexBatch) -> Result<(), SearchIndexError> {
        let removed_owners: Vec<u64> = batch
            .removed_owners
            .iter()
            .map(|removed| {
                owner_value(if removed.is_group {
                    Owner::Group(removed.owner_key)
                } else {
                    Owner::Session(removed.owner_key)
                })
            })
            .collect();
        let mut guard = self.lock_writing()?;
        let writing = guard.as_mut().ok_or(SearchIndexError::Closed)?;
        let mut committed = CommitPayload {
            last_applied_outbox_id: batch.last_outbox_id,
            ..writing.payload()
        };
        if writing.running_merges > 0 {
            committed
                .owners_removed_while_merging
                .extend(&removed_owners);
        }
        if let Err(error) = self.stage(&mut writing.writer, batch, &removed_owners, &mut committed)
        {
            return Err(roll_back(&mut writing.writer, error).into());
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
            Arc::new(current.membership.with_replacements(&batch.group_members))
        };
        let version = IndexVersion::build(
            self.reader.searcher(),
            self.fields,
            Some(&current),
            membership,
            batch.last_outbox_id,
        )?;
        self.publish(version);
        Ok(())
    }

    // Removals first, then rows: a row in the batch is as the database holds it now. A row whose
    // key is above its slot's highest was never added, so it is added without a delete; any other
    // row replaces whatever its key holds, deleted once before its first page so its later pages
    // stay. The segments of a removed owner, a purged session or a deleted group, are noted for
    // rewriting, so its words leave the index's files however few its rows.
    fn stage(
        &self,
        writer: &mut IndexWriter,
        batch: &IndexBatch,
        removed_owners: &[u64],
        committed: &mut CommitPayload,
    ) -> tantivy::Result<()> {
        let searcher = self.reader.searcher();
        let highest_row_keys = &mut committed.highest_row_keys;
        for key in &batch.removed_keys {
            if *key <= highest_row_keys[key_slot(*key)] {
                writer.delete_term(key_term(&self.fields, *key));
            }
        }
        note_segments_holding(
            &searcher,
            &self.fields,
            removed_owners,
            &mut committed.segments_to_expunge,
        )?;
        for owner in removed_owners {
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
        let mut staged_keys = HashSet::new();
        for row in &batch.rows {
            let highest = &mut highest_row_keys[key_slot(row.key)];
            if staged_keys.insert(row.key) {
                if row.key <= *highest {
                    writer.delete_term(key_term(&self.fields, row.key));
                } else {
                    *highest = row.key;
                }
            }
            let owner = match row.kind {
                IndexRowKind::Group => Owner::Group(row.owner_key),
                IndexRowKind::Event | IndexRowKind::Title | IndexRowKind::Tag => {
                    Owner::Session(row.owner_key)
                }
            };
            let tag = row
                .tag
                .as_ref()
                .map(|tag| (tag.fold.as_str(), tag.session_last_activity_ms));
            let document = row_document(&self.fields, row.key, row.kind, owner, &row.text, tag);
            writer.add_document(document)?;
        }
        commit_with_payload(writer, committed)
    }

    /// Loads every group's members once after open, before the first search; later changes
    /// arrive in an `IndexBatch`'s `group_members`, so a search sees members and rows from the
    /// same commit.
    pub fn set_group_members(&self, groups: &[GroupMembers]) -> Result<(), SearchIndexError> {
        let guard = self.lock_writing()?;
        guard.as_ref().ok_or(SearchIndexError::Closed)?;
        let version = self
            .current_version()
            .with_membership(Arc::new(GroupMembership::from_groups(groups)));
        self.publish(version);
        Ok(())
    }

    /// A search over the index as it is now, held until dropped. With `tag_folds`, each a tag
    /// folded as the tag store folds it, only the sessions carrying every one of those tags or one
    /// nested under it count, with their groups' rows: ranked by `query`'s words when it is given,
    /// most recently active first when it is not. A ranking first holds `first_ranked_sessions`
    /// sessions, so a page that reads no further ranks once.
    pub fn open_search(
        &self,
        tag_folds: Vec<String>,
        first_ranked_sessions: usize,
        query: Option<&SearchQuery>,
    ) -> Result<HeldSearch, SearchIndexError> {
        self.refuse_when_closed()?;
        Ok(HeldSearch::open(
            self,
            query,
            tag_folds,
            first_ranked_sessions,
        )?)
    }

    /// One session's matching log rows and every match in them.
    pub fn find_in_session(
        &self,
        session_key: u64,
        query: &SearchQuery,
    ) -> Result<SessionFind, SearchIndexError> {
        self.refuse_when_closed()?;
        Ok(find::find_in_session(
            &self.current_version(),
            session_key,
            query,
        )?)
    }

    /// Runs one merge step, the smallest the capped merge policy proposes, off the writer's lock,
    /// then publishes the merged segments; returns whether more merging remains. Blocks on the
    /// merge.
    pub fn merge_segments(&self) -> Result<bool, SearchIndexError> {
        match self.start_merge()? {
            Some(merge) => self.finish_merge(merge),
            None => Ok(false),
        }
    }

    /// Starts the smallest merge the policy proposes, when it proposes one. Fails with
    /// `SearchIndexError::Closed` after `close`.
    pub(crate) fn start_merge(&self) -> Result<Option<RunningMerge>, SearchIndexError> {
        let mut guard = self.lock_writing()?;
        let writing = guard.as_mut().ok_or(SearchIndexError::Closed)?;
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
    pub(crate) fn finish_merge(&self, merge: RunningMerge) -> Result<bool, SearchIndexError> {
        let merged = merge.wait();
        let mut guard = self.lock_writing()?;
        let writing = guard.as_mut().ok_or(SearchIndexError::Closed)?;
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
                return Err(roll_back(&mut writing.writer, error).into());
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

    /// Waits for the writes and the merge under way, then stops the writer's threads; every later
    /// call but `last_applied_outbox_id` and `close` itself fails with `SearchIndexError::Closed`.
    /// Searches already open keep their files until dropped.
    pub fn close(&self) -> Result<(), SearchIndexError> {
        self.is_closed.store(true, Ordering::Release);
        let writing = self.lock_writing()?.take();
        if let Some(writing) = writing {
            writing.writer.wait_merging_threads()?;
        }
        Ok(())
    }
}

// The slot a key's highest is kept in: the key modulo four.
fn key_slot(key: u64) -> usize {
    usize::try_from(key % 4).expect("a key modulo four fits in a usize")
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
            .map_or(0, SegmentMeta::max_doc)
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
