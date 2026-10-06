// Opens a file or folder, at a line where one is given, in the editor `Editor that opens files`
// names. The setting is the background service's: main reads it on its own connection at each
// open, so a change made from another device holds here at once. With no editor chosen, or with the
// chosen one no longer on this machine, the open lands in the system default rather than failing.

import type { JsonRpcClient } from "@ai-sidekicks/client-sdk";
import { MACHINE_SETTINGS_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/machine-settings";
import * as z from "zod/mini";

import { findEditor } from "./catalog.js";
import type { InstalledEditors } from "./installed.js";
import type { ProgramRunner } from "./program-runner.js";

/** What an open needs: this system's installed editors, a program runner and the system default. */
export interface EditorOpening {
  /**
   * Built at the open that names an editor, so an open in the system default never needs this
   * system's form; throws where that form is not built.
   */
  readonly installedEditors: () => InstalledEditors;
  readonly runProgram: ProgramRunner;
  /** Opens the path in the app the system assigns it (`shell.openPath`); rejects on failure. */
  readonly openWithSystemDefault: (targetPath: string) => Promise<void>;
}

/** The path to open, the line where one was asked for, and the editor the setting names. */
export interface EditorOpenRequest {
  readonly targetPath: string;
  readonly line: number | undefined;
  /** `null` is `System default`. */
  readonly editorId: string | null;
}

/**
 * Read `editorId` from the service's settings on main's own connection. Throws when the service is
 * not connected or refuses the read, since without it main cannot know which editor was chosen.
 */
export async function readChosenEditorId(link: {
  readonly client: JsonRpcClient | undefined;
}): Promise<string | null> {
  const client = link.client;
  if (client === undefined) {
    throw new Error("The background service is not connected, so the chosen editor is unknown.");
  }
  const descriptor = MACHINE_SETTINGS_METHOD_DESCRIPTORS["daemon.machineSettingsRead"];
  const reading = await client.call(
    descriptor.method,
    {},
    descriptor.requestSchema,
    descriptor.responseSchema,
  );
  return reading.settings.editorId;
}

const editorOpenRequestSchema = z.strictObject({
  ref: z.string(),
  line: z.optional(z.int().check(z.minimum(1))),
});

/**
 * Read what the page asks to open: a file reference, and a line where one is given. Throws a
 * `ZodError` unless the line is absent or a whole number from 1.
 */
export function parseEditorOpenRequest(request: unknown): {
  readonly ref: string;
  readonly line: number | undefined;
} {
  const { ref, line } = editorOpenRequestSchema.parse(request);
  return { ref, line };
}

/** Open the path in the chosen editor, or in the system default when there is none to open. */
export async function openInEditor(
  opening: EditorOpening,
  request: EditorOpenRequest,
): Promise<void> {
  const editor = request.editorId === null ? undefined : findEditor(request.editorId);
  if (editor === undefined) {
    await opening.openWithSystemDefault(request.targetPath);
    return;
  }
  const installedEditors = opening.installedEditors();
  const appPath = (await installedEditors.locate([editor])).get(editor.id);
  if (appPath === undefined) {
    await opening.openWithSystemDefault(request.targetPath);
    return;
  }
  const launch = await installedEditors.launch(editor, appPath, request.targetPath, request.line);
  await opening.runProgram(launch.command, launch.programArguments);
}
