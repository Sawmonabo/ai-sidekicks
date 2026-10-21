//! The app's identity with the operating system: the name it shows the system under, and the
//! bundle identifier the desktop's build signs the app under, from which the daemon derives the
//! identifier its client helper carries.

use crate::typescript::{TypeScriptModule, ts_constants};

ts_constants! {
    /// The name the app gives the operating system and other programs for itself: a power
    /// assertion, a snapshot commit's author, a passkey's relying party and a provider's client
    /// title all carry it.
    pub const APP_DISPLAY_NAME: &str = "AI Sidekicks";

    /// The app's bundle identifier: the desktop's build signs the app under it, and on macOS the
    /// daemon admits the desktop's client helper by the identifier derived from it.
    pub const APP_BUNDLE_IDENTIFIER: &str = "io.github.sawmonabo.ai-sidekicks";
}

/// The TypeScript module of the app's identity.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "app-identity",
    doc: "The app's identity with the operating system: its display name and bundle identifier.",
    definitions: &[],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
