// On macOS the editor list comes from Launch Services, read and never assumed, and a file opens at
// a line in the form each editor takes, falling back to a plain open.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EDITOR_CATALOG, findEditor, type EditorDefinition } from "./catalog.js";
import { listEditors } from "./installed-editors.js";
import { MacInstalledEditors } from "./mac-installed-editors.js";
import { runProgram } from "./program-runner.js";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "sidekicks-mac-editors-test-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function catalogEditor(id: string): EditorDefinition {
  const editor = findEditor(id);
  if (editor === undefined) {
    throw new Error(`the catalog holds no ${id}`);
  }
  return editor;
}

const TARGET = "/Users/someone/project/src/main.ts";

describe("the installed editors on macOS", () => {
  it("marks each catalog editor by whether the register holds any of its bundle ids", async () => {
    const installedEditors = new MacInstalledEditors(() =>
      Promise.resolve(
        JSON.stringify({
          "com.sublimetext.3": "/Applications/Sublime Text.app",
          "com.apple.dt.Xcode": "/Applications/Xcode.app",
        }),
      ),
    );

    const entries = await listEditors(installedEditors);

    expect(entries.map((entry) => entry.id)).toStrictEqual(EDITOR_CATALOG.map((e) => e.id));
    expect(entries.filter((entry) => entry.installed).map((entry) => entry.id)).toStrictEqual([
      "sublime-text",
      "xcode",
    ]);
  });

  it("refuses a register answer that is not bundle ids mapped to app paths", async () => {
    const installedEditors = new MacInstalledEditors(() => Promise.resolve('{"dev.zed.Zed": 1}'));

    await expect(listEditors(installedEditors)).rejects.toThrow();
  });

  it.runIf(process.platform === "darwin")(
    "finds an app the register always holds through the real lookup",
    async () => {
      const finder = { id: "finder", label: "Finder", macBundleIds: ["com.apple.finder"] };
      const absent = { id: "absent", label: "Absent", macBundleIds: ["invalid.sidekicks.absent"] };

      const locations = await new MacInstalledEditors(runProgram).locate([finder, absent]);

      expect(locations.get("finder")).toMatch(/Finder\.app$/u);
      expect(locations.has("absent")).toBe(false);
    },
    // Past the runner's own 10-second bound, so a stuck lookup fails as the runner's timeout.
    15_000,
  );

  it("runs the command the app bundle ships at the line, and opens the app without it", async () => {
    const appPath = path.join(scratch, "Visual Studio Code.app");
    const command = path.join(appPath, "Contents/Resources/app/bin/code");
    await mkdir(path.dirname(command), { recursive: true });
    await writeFile(command, "", "utf8");
    const installedEditors = new MacInstalledEditors(runProgram);
    const vscode = catalogEditor("vscode");

    await expect(installedEditors.launch(vscode, appPath, TARGET, 12)).resolves.toStrictEqual({
      command,
      programArguments: ["--goto", `${TARGET}:12`],
    });
    await expect(
      installedEditors.launch(vscode, appPath, TARGET, undefined),
    ).resolves.toStrictEqual({
      command: "/usr/bin/open",
      programArguments: ["-a", appPath, TARGET],
    });
    // An install that ships no command still opens the file.
    await expect(
      installedEditors.launch(catalogEditor("cursor"), scratch, TARGET, 12),
    ).resolves.toStrictEqual({
      command: "/usr/bin/open",
      programArguments: ["-a", scratch, TARGET],
    });
  });

  it("passes the line the way Xcode and the JetBrains IDEs take it", async () => {
    const installedEditors = new MacInstalledEditors(runProgram);
    const xcodePath = path.join(scratch, "Xcode.app");
    const xed = path.join(xcodePath, "Contents/Developer/usr/bin/xed");
    await mkdir(path.dirname(xed), { recursive: true });
    await writeFile(xed, "", "utf8");

    // The found Xcode's own command, which needs no developer folder selected.
    await expect(
      installedEditors.launch(catalogEditor("xcode"), xcodePath, TARGET, 3),
    ).resolves.toStrictEqual({
      command: xed,
      programArguments: ["--line", "3", TARGET],
    });
    await expect(
      installedEditors.launch(catalogEditor("xcode"), scratch, TARGET, 3),
    ).resolves.toStrictEqual({
      command: "/usr/bin/open",
      programArguments: ["-a", scratch, TARGET],
    });
    await expect(
      installedEditors.launch(catalogEditor("webstorm"), "/Applications/WebStorm.app", TARGET, 3),
    ).resolves.toStrictEqual({
      command: "/usr/bin/open",
      programArguments: ["-na", "/Applications/WebStorm.app", "--args", "--line", "3", TARGET],
    });
  });
});
