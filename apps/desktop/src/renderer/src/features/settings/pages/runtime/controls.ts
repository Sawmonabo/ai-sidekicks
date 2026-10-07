import type { SettingsControl } from "../../types.js";

/** The rows the Runtime page draws that search finds, in the order the page draws them. */
export const RUNTIME_CONTROLS: Readonly<Record<"state" | "mountedRepositories", SettingsControl>> =
  {
    state: { id: "state", label: "State" },
    mountedRepositories: { id: "mounted-repositories", label: "Mounted repositories" },
  };
