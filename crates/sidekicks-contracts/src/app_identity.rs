//! The app's identity with the operating system: the name it shows the system under, the bundle
//! identifier the desktop's build signs the app under, from which the daemon derives the
//! identifier its client helper carries, and the launchd label the service runs under on a Mac.

use crate::typescript::{TypeScriptModule, ts_constants};

// The bundle identifier's one literal, which the identifier and the service's label both read.
macro_rules! app_bundle_identifier {
    () => {
        "io.github.sawmonabo.ai-sidekicks"
    };
}

ts_constants! {
    /// The name the app gives the operating system and other programs for itself: a power
    /// assertion, a snapshot commit's author, a passkey's relying party and a provider's client
    /// title all carry it.
    pub const APP_DISPLAY_NAME: &str = "AI Sidekicks";

    /// The app's bundle identifier: the desktop's build signs the app under it, and on macOS the
    /// daemon admits the desktop's client helper by the identifier derived from it.
    pub const APP_BUNDLE_IDENTIFIER: &str = app_bundle_identifier!();

    /// The launchd label the service runs under on a Mac, one label so one service runs there. It
    /// differs from the bundle identifier, so launchd's and the privacy settings' records of the
    /// app and of the service never collide.
    pub const DAEMON_LAUNCHD_LABEL: &str = concat!(app_bundle_identifier!(), ".service");
}

/// The TypeScript module of the app's identity.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "app-identity",
    doc: "The app's identity with the operating system: its display name, its bundle identifier \
          and the launchd label the service runs under on a Mac.",
    definitions: &[],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
