// The editors a scenario's machine has, as main lists them for `native.listEditors`: catalog
// editors in the catalog's order, some installed and some not, so the editor setting draws both.

import type { EditorEntry } from "#shared/preload-api.js";

/** The scenario machine's editor list, in the catalog's order; three are installed. */
export const EDITOR_LIST: readonly EditorEntry[] = [
  { id: "vscode", label: "Visual Studio Code", installed: true },
  { id: "cursor", label: "Cursor", installed: true },
  { id: "sublime-text", label: "Sublime Text", installed: false },
  { id: "zed", label: "Zed", installed: true },
  { id: "xcode", label: "Xcode", installed: false },
];
