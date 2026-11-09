// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The app's identity with the operating system: its display name, its bundle identifier and the launchd label the service runs under on a Mac.

/**
 * The name the app gives the operating system and other programs for itself: a power
 * assertion, a snapshot commit's author, a passkey's relying party and a provider's client
 * title all carry it.
 */
export const APP_DISPLAY_NAME = "AI Sidekicks" as const;

/**
 * The app's bundle identifier: the desktop's build signs the app under it, and on macOS the
 * daemon starts the app by it with no window for a banner and admits the desktop's client
 * helper by the identifier derived from it.
 */
export const APP_BUNDLE_IDENTIFIER = "io.github.sawmonabo.ai-sidekicks" as const;

/**
 * The launchd label the service runs under on a Mac, one label so one service runs there. It
 * differs from the bundle identifier, so launchd's and the privacy settings' records of the
 * app and of the service never collide.
 */
export const DAEMON_LAUNCHD_LABEL = "io.github.sawmonabo.ai-sidekicks.service" as const;
