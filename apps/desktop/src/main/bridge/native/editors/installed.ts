// Which of the catalog's editors this machine has, and how to open a file in one. Both differ by
// operating system, so they sit behind `InstalledEditors`, one form per system, and `platform.ts`
// picks this system's. Finding an editor goes through the system's own register of installed apps
// and never through a command path: an app started from the Dock has no command path of the
// person's to search.

import type { EditorEntry } from "#shared/preload-api.js";
import { EDITOR_CATALOG, type EditorDefinition } from "./catalog.js";

/** Where each installed editor lives, by editor id; an editor this machine lacks is absent. */
export type InstalledEditorLocations = ReadonlyMap<string, string>;

/** One program run that opens a file in an editor. */
export interface EditorLaunch {
  readonly command: string;
  readonly programArguments: readonly string[];
}

/** One operating system's way of finding the catalog's editors and opening a file in one. */
export interface InstalledEditors {
  /** Which of `editors` this machine has, and where each one's app is. */
  locate(editors: readonly EditorDefinition[]): Promise<InstalledEditorLocations>;
  /** The run that opens `targetPath`, at `line` where one is given, in the editor at `appPath`. */
  launch(
    editor: EditorDefinition,
    appPath: string,
    targetPath: string,
    line: number | undefined,
  ): Promise<EditorLaunch>;
}

/** Every catalog editor in list order, each saying whether this machine has it. */
export async function listEditors(installedEditors: InstalledEditors): Promise<EditorEntry[]> {
  const locations = await installedEditors.locate(EDITOR_CATALOG);
  return EDITOR_CATALOG.map((editor) => ({
    id: editor.id,
    label: editor.label,
    installed: locations.has(editor.id),
  }));
}
