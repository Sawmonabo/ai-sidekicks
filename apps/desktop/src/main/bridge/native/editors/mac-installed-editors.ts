// The macOS form of the installed editors. Launch Services, asked for every bundle identifier in
// one run of `osascript`, says which editors this machine has; a file opens with `open -a`, or at
// a line through the command the app bundle ships, Xcode's `xed`, or a JetBrains IDE's `--line`.

import { access } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { isMissingPath } from "#main/services/missing-path.js";
import type { EditorDefinition, MacLineLaunch } from "./catalog.js";
import type {
  EditorLaunch,
  InstalledEditorLocations,
  InstalledEditors,
} from "./installed-editors.js";
import type { ProgramRunner } from "./program-runner.js";

/**
 * The Launch Services lookup, as a JavaScript for Automation script: each bundle identifier in the
 * JSON list it is handed, answered with the path of the app the register holds for it.
 */
const LAUNCH_SERVICES_LOOKUP_SCRIPT = [
  "function run(argv) {",
  '  ObjC.import("AppKit");',
  "  const found = {};",
  "  for (const id of JSON.parse(argv[0])) {",
  "    const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(id);",
  "    if (!url.isNil()) { found[id] = ObjC.unwrap(url.path); }",
  "  }",
  "  return JSON.stringify(found);",
  "}",
].join("\n");

const appPathsByBundleIdSchema = z.record(z.string(), z.string());

/** The macOS launcher that opens a file with a named app. */
const OPEN_COMMAND = "/usr/bin/open";

/**
 * Xcode's own command inside the found app, which takes a line. Not `/usr/bin/xed`: that asks
 * `xcrun`, which finds no `xed` while only the Command Line Tools are selected.
 */
const XED_IN_APP = "Contents/Developer/usr/bin/xed";

/** The macOS form: Launch Services through `osascript`, and the system's own launchers. */
export class MacInstalledEditors implements InstalledEditors {
  readonly #runProgram: ProgramRunner;

  public constructor(runProgram: ProgramRunner) {
    this.#runProgram = runProgram;
  }

  /** Throws when `osascript` fails or answers anything but bundle ids mapped to app paths. */
  public async locate(editors: readonly EditorDefinition[]): Promise<InstalledEditorLocations> {
    const bundleIds = editors.flatMap((editor) => editor.macBundleIds);
    const printed = await this.#runProgram("/usr/bin/osascript", [
      "-l",
      "JavaScript",
      "-e",
      LAUNCH_SERVICES_LOOKUP_SCRIPT,
      JSON.stringify(bundleIds),
    ]);
    const appPathsByBundleId = appPathsByBundleIdSchema.parse(JSON.parse(printed));
    const locations = new Map<string, string>();
    for (const editor of editors) {
      const appPath = editor.macBundleIds
        .map((bundleId) => appPathsByBundleId[bundleId])
        .find((found) => found !== undefined);
      if (appPath !== undefined) {
        locations.set(editor.id, appPath);
      }
    }
    return locations;
  }

  /** At a line where the editor takes one; otherwise, or with no command shipped, a plain open. */
  public async launch(
    editor: EditorDefinition,
    appPath: string,
    targetPath: string,
    line: number | undefined,
  ): Promise<EditorLaunch> {
    const plainOpen = { command: OPEN_COMMAND, programArguments: ["-a", appPath, targetPath] };
    if (line === undefined || editor.macLineLaunch === undefined) {
      return plainOpen;
    }
    return (await lineLaunch(editor.macLineLaunch, appPath, targetPath, line)) ?? plainOpen;
  }
}

/** The launch that opens at a line, or `undefined` when the app ships none of its commands. */
async function lineLaunch(
  launch: MacLineLaunch,
  appPath: string,
  targetPath: string,
  line: number,
): Promise<EditorLaunch | undefined> {
  const atLine = `${targetPath}:${String(line)}`;
  switch (launch.kind) {
    case "xed": {
      const command = await firstExisting([path.join(appPath, XED_IN_APP)]);
      return command === undefined
        ? undefined
        : { command, programArguments: ["--line", String(line), targetPath] };
    }
    case "jetbrains":
      return {
        command: OPEN_COMMAND,
        programArguments: ["-na", appPath, "--args", "--line", String(line), targetPath],
      };
    case "bundledCommand": {
      const command = await firstExisting(
        launch.relativePaths.map((relativePath) => path.join(appPath, relativePath)),
      );
      if (command === undefined) {
        return undefined;
      }
      return {
        command,
        programArguments: launch.lineForm === "goto" ? ["--goto", atLine] : [atLine],
      };
    }
  }
}

async function firstExisting(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch (failure) {
      // Not shipped at this place by this install: the next candidate, or the plain open, follows.
      if (!isMissingPath(failure)) {
        throw failure;
      }
    }
  }
  return undefined;
}
