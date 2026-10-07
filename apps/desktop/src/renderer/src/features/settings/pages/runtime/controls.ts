import type { SettingsControl } from "../../types.js";

/** The rows the Runtime page draws that search finds, in the order the page draws them. */
export const RUNTIME_CONTROLS: Readonly<
  Record<"state" | "foldersThisMachineCanReach", SettingsControl>
> = {
  state: { id: "state", label: "State" },
  foldersThisMachineCanReach: {
    id: "folders-this-machine-can-reach",
    label: "Folders this machine can reach",
  },
};
