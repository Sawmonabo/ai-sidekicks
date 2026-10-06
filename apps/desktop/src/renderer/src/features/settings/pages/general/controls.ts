import type { SettingsControl } from "../../types.js";

/** The rows the General page draws that search finds, in the order the page draws them. */
export const GENERAL_CONTROLS: readonly SettingsControl[] = [
  { id: "version", label: "Version" },
  { id: "platform", label: "Platform" },
  { id: "architecture", label: "Architecture" },
  { id: "locale", label: "Locale" },
];
