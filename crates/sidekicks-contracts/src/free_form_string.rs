//! The longest path a wire string may carry. Free-form text itself is
//! [`FreeFormText`](crate::wire::text::FreeFormText).

use crate::typescript::{TypeScriptModule, ts_constants};

ts_constants! {
    /// The longest filesystem path any wire string carries, in code points. 4096 is Linux's
    /// `PATH_MAX`, above macOS's 1024 and Windows' 260-character default; a longer Windows
    /// extended-length path is refused.
    pub const FILE_PATH_MAX_LEN: usize = 4096;
}

/// The TypeScript module of the path cap.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "free-form-string",
    doc: "The longest path a wire string may carry.",
    definitions: &[],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
