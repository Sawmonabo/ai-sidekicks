// The words the update block draws for the updater's state and its reported failure.
import type { UpdateState } from "#shared/preload-api.js";

/**
 * What the updater reporting a failure reads as on screen. Its own message is never drawn: it goes
 * to the diagnostic log, since it is the updater's wording and may name a path or a stack.
 */
export const UPDATE_FAILED_DETAIL = "The update could not be verified and was not installed.";

/**
 * The words each settled arm of the updater's state draws, which is also what a screen reader is
 * told. The figures drawn beside them (when it last checked, the version, the percent) are not.
 */
export const UPDATE_STATE_WORDS: Readonly<Record<Exclude<UpdateState["status"], "error">, string>> =
  {
    idle: "No update is waiting.",
    checking: "Checking for an update…",
    available: "Update available.",
    downloading: "Downloading",
    verifying: "Checking the signature…",
    ready: "An update has finished downloading and installs on the next restart.",
  };
