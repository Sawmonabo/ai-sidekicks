//! How the search index's rows are keyed. A row's key is its source row's rowid times the number
//! of kinds plus its kind's slot, so the key names the row's table and its row there, and a
//! session's title or a group's name is reached by arithmetic.

use sidekicks_search::index::IndexRowKind;
use strum::VariantArray;

// One key slot per kind, so every source row owns this many keys.
const SLOT_COUNT: u64 = IndexRowKind::VARIANTS.len() as u64;

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
    IndexRowKind::VARIANTS
        [usize::try_from(key % SLOT_COUNT).expect("a slot is below the kind count")]
}

/// The rowid of the source row behind the index row with this key.
pub(crate) fn source_rowid_of(key: u64) -> u64 {
    key / SLOT_COUNT
}

// Each kind's slot is its place in the kind's declaration.
fn slot_of(kind: IndexRowKind) -> u64 {
    let slot = IndexRowKind::VARIANTS
        .iter()
        .position(|listed| *listed == kind)
        .expect("every index row kind is a variant");
    slot as u64
}
