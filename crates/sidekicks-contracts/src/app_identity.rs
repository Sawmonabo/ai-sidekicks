//! The app's identity with the operating system: the bundle identifier the desktop's build signs
//! the app under, from which the daemon derives the identifier its client helper carries.

use crate::typescript::{TypeScriptModule, ts_constants};

ts_constants! {
    /// The app's bundle identifier: the desktop's build signs the app under it, and on macOS the
    /// daemon admits the desktop's client helper by the identifier derived from it.
    pub const APP_BUNDLE_IDENTIFIER: &str = "io.github.sawmonabo.ai-sidekicks";
}

/// The TypeScript module of the app's identity.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "app-identity",
    doc: "The app's identity with the operating system: its bundle identifier.",
    definitions: &[],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
