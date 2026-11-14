import type { SettingsControl } from "../../types.js";

/** The section head the update block's rows sit under. */
export const UPDATES_HEADING = "Updates";

/** The rows the General page draws that search finds, in the order the page draws them. */
export const GENERAL_CONTROLS: Readonly<
  Record<
    "version" | "platform" | "architecture" | "language" | "checkForUpdatesAutomatically",
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
};
