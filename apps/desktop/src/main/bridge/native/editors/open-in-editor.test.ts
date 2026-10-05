// An open lands in the chosen editor, through this system's launch for it, and in the system
// default when no editor is chosen or the chosen one is gone, never failing for want of one.

import { describe, expect, it, vi } from "vitest";

import type { InstalledEditors } from "./installed-editors.js";
import { openInEditor, parseEditorOpenRequest, type EditorOpening } from "./open-in-editor.js";

/** A system that has exactly the editors given, at the app paths given. */
function installedEditorsFinding(locations: Readonly<Record<string, string>>): InstalledEditors {
  return {
    locate: (editors) =>
      Promise.resolve(
        new Map(
          editors.flatMap((editor) => {
            const appPath = locations[editor.id];
            return appPath === undefined ? [] : [[editor.id, appPath] as const];
          }),
        ),
      ),
    launch: (editor, appPath, targetPath, line) =>
      Promise.resolve({
        command: `launch-${editor.id}`,
        programArguments: [appPath, targetPath, String(line)],
      }),
  };
}

function recordingOpening(installedEditors: InstalledEditors): EditorOpening & {
  readonly installedEditors: ReturnType<typeof vi.fn>;
  readonly runProgram: ReturnType<typeof vi.fn>;
  readonly openWithSystemDefault: ReturnType<typeof vi.fn>;
} {
  return {
    installedEditors: vi.fn(() => installedEditors),
    runProgram: vi.fn(() => Promise.resolve("")),
    openWithSystemDefault: vi.fn(() => Promise.resolve()),
  };
}

const TARGET = "/Users/someone/project/src/main.ts";

describe("opening in the editor", () => {
  it("lands in the system default with no editor chosen or an unknown id, asking no system form", async () => {
    for (const editorId of [null, "an-editor-no-catalog-holds"]) {
      const opening = recordingOpening(installedEditorsFinding({ zed: "/Applications/Zed.app" }));

      await openInEditor(opening, { targetPath: TARGET, line: 12, editorId });

      expect(opening.openWithSystemDefault.mock.calls).toStrictEqual([[TARGET]]);
      expect(opening.installedEditors).not.toHaveBeenCalled();
      expect(opening.runProgram).not.toHaveBeenCalled();
    }
  });

  it("lands in the system default when the chosen editor is gone from this machine", async () => {
    const opening = recordingOpening(installedEditorsFinding({}));

    await openInEditor(opening, { targetPath: TARGET, line: 12, editorId: "zed" });

    expect(opening.openWithSystemDefault.mock.calls).toStrictEqual([[TARGET]]);
    expect(opening.runProgram).not.toHaveBeenCalled();
  });

  it("runs this system's launch for the chosen editor at the line", async () => {
    const opening = recordingOpening(installedEditorsFinding({ zed: "/Applications/Zed.app" }));

    await openInEditor(opening, { targetPath: TARGET, line: 12, editorId: "zed" });

    expect(opening.runProgram.mock.calls).toStrictEqual([
      ["launch-zed", ["/Applications/Zed.app", TARGET, "12"]],
    ]);
    expect(opening.openWithSystemDefault).not.toHaveBeenCalled();
  });

  it("takes a line only as a whole number from 1", () => {
    const ref = "a-file-reference";
    expect(parseEditorOpenRequest({ ref })).toStrictEqual({ ref, line: undefined });
    expect(parseEditorOpenRequest({ ref, line: 7 })).toStrictEqual({ ref, line: 7 });
    for (const line of [0, -1, 1.5, "7", null]) {
      expect(() => parseEditorOpenRequest({ ref, line })).toThrow();
    }
  });
});
