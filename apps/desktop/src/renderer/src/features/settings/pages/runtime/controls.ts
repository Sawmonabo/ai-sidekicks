import type { SettingsControl } from "../../types.js";

/** The rows the Runtime page draws that search finds, in the order the page draws them. */
export const RUNTIME_CONTROLS: readonly SettingsControl[] = [
  { id: "state", label: "State" },
  { id: "mounted-repositories", label: "Mounted repositories" },
];
