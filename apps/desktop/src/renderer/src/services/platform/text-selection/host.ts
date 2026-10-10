// The host's selection keys, picked once from its platform.

import { HOST_CHORD_PLATFORM } from "#renderer/lib/chord-format.js";
import type { SelectionKeys } from "./keys.js";
import { MAC_SELECTION_KEYS } from "./mac.js";
import { WINDOWS_AND_LINUX_SELECTION_KEYS } from "./windows-and-linux.js";

/** This machine's selection keys: macOS's on a Mac, the browser's key table elsewhere. */
export const HOST_SELECTION_KEYS: SelectionKeys =
  HOST_CHORD_PLATFORM === "darwin" ? MAC_SELECTION_KEYS : WINDOWS_AND_LINUX_SELECTION_KEYS;
