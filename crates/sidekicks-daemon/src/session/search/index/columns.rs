//! How the search index's rows are keyed. A row's key is its source row's rowid times the number
//! of kinds plus its kind's slot, so the key names the row's table and its row there, and a
//! session's title or a group's name is reached by arithmetic.

use sidekicks_search::index::IndexRowKind;

/// Every kind of index row; each kind's slot is its place in this list.
const INDEX_ROW_KINDS: [IndexRowKind; 4] = [
    IndexRowKind::Event,
    IndexRowKind::Title,
    IndexRowKind::Group,
    IndexRowKind::Tag,
];

// One key slot per kind, so every source row owns this many keys.
const SLOT_COUNT: u64 = INDEX_ROW_KINDS.len() as u64;

/// The SQL for the key of the `kind` index row of the source row whose rowid is `rowid_sql`.
pub(crate) fn index_key_sql(rowid_sql: &str, kind: IndexRowKind) -> String {
    format!("({rowid_sql} * {SLOT_COUNT} + {})", slot_of(kind))
}

/// The key of the `kind` index row of the source row with this rowid, as [`index_key_sql`]
/// writes it.
pub(crate) fn index_key_of(source_rowid: u64, kind: IndexRowKind) -> u64 {
    source_rowid * SLOT_COUNT + slot_of(kind)
}

/// The kind of the index row with this key.
pub(crate) fn index_row_kind_of(key: u64) -> IndexRowKind {
    INDEX_ROW_KINDS[usize::try_from(key % SLOT_COUNT).expect("a slot is below the kind count")]
}

/// The rowid of the source row behind the index row with this key.
pub(crate) fn source_rowid_of(key: u64) -> u64 {
    key / SLOT_COUNT
}

fn slot_of(kind: IndexRowKind) -> u64 {
    let slot = INDEX_ROW_KINDS
        .iter()
        .position(|listed| *listed == kind)
        .expect("every index row kind is listed");
    slot as u64
}

/// A stored index row kind word that names no kind.
#[derive(Debug, thiserror::Error)]
#[error("`{0}` is not an index row kind")]
pub(crate) struct UnknownIndexRowKind(String);

/// The word a stored row writes for `kind`, as the outbox's and the floor log's `kind` columns
/// hold it.
pub(crate) fn index_row_kind_word(kind: IndexRowKind) -> &'static str {
    match kind {
        IndexRowKind::Event => "event",
        IndexRowKind::Title => "title",
        IndexRowKind::Group => "group",
        IndexRowKind::Tag => "tag",
    }
}

/// The kind a stored `kind` word names; fails for a word that names none.
pub(crate) fn index_row_kind_of_word(word: String) -> Result<IndexRowKind, UnknownIndexRowKind> {
    match word.as_str() {
        "event" => Ok(IndexRowKind::Event),
        "title" => Ok(IndexRowKind::Title),
        "group" => Ok(IndexRowKind::Group),
        "tag" => Ok(IndexRowKind::Tag),
        _ => Err(UnknownIndexRowKind(word)),
    }
}
