import type { SettingsControl } from "../../types.js";

/** The section head the update block's rows sit under. */
export const UPDATES_HEADING = "Updates";

/** The rows the General page draws that search finds, in the order the page draws them. */
export const GENERAL_CONTROLS: Readonly<
  Record<
    | "version"
    | "platform"
    | "architecture"
    | "language"
    | "checkForUpdatesAutomatically"
    | "keepCrashReports"
    | "startOnLastModel"
    | "keepAwake"
    | "editor"
    | "defaultCheckout",
    SettingsControl
  >
> = {
  version: { id: "version", label: "Version" },
  platform: { id: "platform", label: "Platform" },
  architecture: { id: "architecture", label: "Architecture" },
  language: { id: "language", label: "Language" },
  checkForUpdatesAutomatically: {
    id: "check-for-updates-automatically",
    label: "Check for updates automatically",
    heading: UPDATES_HEADING,
  },
  keepCrashReports: {
    id: "keep-crash-reports",
    label: "Keep crash reports",
    hint: "Reports stay on this computer, with personal data stripped.",
  },
  startOnLastModel: {
    id: "start-on-last-model",
    label: "Start a new session on the last model and effort used",
    hint:
      "The permission level is never carried over. A new session starts at the level the " +
      "provider's own settings give for its project, or at YOLO when they set none.",
  },
  // A Mac's wording; the page draws the other systems' own label in its place.
  keepAwake: {
    id: "keep-awake",
    label: "Keep this Mac awake while a sidekick is working",
    hint: "Closing the lid still puts it to sleep.",
  },
  editor: { id: "editor", label: "Editor that opens files" },
  defaultCheckout: {
    id: "default-checkout",
    label: "Default checkout for a new project session",
    hint: "A choice made when a session is created always wins.",
  },
};
