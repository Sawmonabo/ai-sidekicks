import type { SupportedPlatform } from "@ai-sidekicks/contracts/platform";

import type { SettingsControl } from "../../types.js";

/** The section head the update block's rows sit under. */
export const UPDATES_HEADING = "Updates";

/** The rows the General page draws that search finds and read alike on every platform. */
export const GENERAL_CONTROLS: Readonly<
  Record<
    | "version"
    | "platform"
    | "architecture"
    | "language"
    | "checkForUpdatesAutomatically"
    | "keepCrashReports"
    | "startOnLastModel"
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
  editor: { id: "editor", label: "Editor that opens files" },
  defaultCheckout: {
    id: "default-checkout",
    label: "Default checkout for a new project session",
    hint: "A choice made when a session is created always wins.",
  },
};

/** The keep-awake switch as `platform` words it: a Mac by its name, any other computer as one. */
export function keepAwakeControlOn(platform: SupportedPlatform): SettingsControl {
  return {
    id: "keep-awake",
    label:
      platform === "darwin"
        ? "Keep this Mac awake while a sidekick is working"
        : "Keep this computer awake while a sidekick is working",
    hint: "Closing the lid still puts it to sleep.",
  };
}

/** Every row the General page draws on `platform` that search finds, in the page's order. */
export function generalControlListOn(platform: SupportedPlatform): readonly SettingsControl[] {
  return [
    GENERAL_CONTROLS.version,
    GENERAL_CONTROLS.platform,
    GENERAL_CONTROLS.architecture,
    GENERAL_CONTROLS.language,
    GENERAL_CONTROLS.checkForUpdatesAutomatically,
    GENERAL_CONTROLS.keepCrashReports,
    GENERAL_CONTROLS.startOnLastModel,
    keepAwakeControlOn(platform),
    GENERAL_CONTROLS.editor,
    GENERAL_CONTROLS.defaultCheckout,
  ];
}
