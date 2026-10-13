//! The transcript's limits: the most rows a read or a search page holds, the longest search query
//! and snippet, and the largest body that travels with its row.

use crate::typescript::{TypeScriptModule, ts_constants};

ts_constants! {
    /// Ceiling on a single `transcript.read` window. It is a count ceiling, not a size one: the
    /// page budget typically trips first, since this many worst-case rows do not fit one frame.
    pub const TRANSCRIPT_READ_LIMIT_MAX: usize = 256;
}

/// The longest query, and the longest snippet a hit carries, in code points: each is one line of
/// a row's text.
pub const TRANSCRIPT_SEARCH_TEXT_MAX_LEN: usize = 4096;

/// The most JSON bytes a row's body takes and still travels with its row on a read; a larger
/// one comes back as the `large` arm, which carries its size alone.
pub const TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES: usize = 32_768;

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "transcript/limits",
    doc: "The transcript's limits: the most rows a read or a search page holds.",
    definitions: &[],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
