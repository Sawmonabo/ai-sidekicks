// The open dialog and the clipboard: what reaches the page is a token, never a path, and
// nothing the page sends is acted on before it is checked.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilePathRefs, type FilePathRefOwner } from "./file-path-refs.js";
import { copyToClipboard, showOpenDialog, type OpenDialogHost } from "./native-handlers.js";

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "sidekicks-open-dialog-test-"));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

/** A page that can be told it has gone. */
function page(id: number): FilePathRefOwner & { readonly destroy: () => void } {
  let onDestroyed: (() => void) | undefined;
  return {
    id,
    once: (_event, listener) => {
      onDestroyed = listener;
    },
    destroy: () => {
      onDestroyed?.();
    },
  };
}

function dialogPicking(filePaths: readonly string[]): OpenDialogHost {
  return {
    showOpenDialog: vi.fn(() => Promise.resolve({ canceled: false, filePaths })),
  };
}

describe("the open dialog", () => {
  it("answers each picked file as a token, its name and its size, and keeps the path in main", async () => {
    const picked = path.join(folder, "notes.md");
    await writeFile(picked, "twelve bytes", "utf8");
    const refs = new FilePathRefs();
    const owner = page(1);

    const result = await showOpenDialog(dialogPicking([picked]), refs, owner, {
      purpose: "attachFiles",
    });

    expect(result.refs).toHaveLength(1);
    const [file] = result.refs;
    expect(file?.name).toBe("notes.md");
    expect(file?.sizeBytes).toBe(12);
    expect(JSON.stringify(result)).not.toContain(folder);
    expect(file === undefined ? undefined : refs.pathOf(owner, file.ref)).toBe(picked);
  });

  it("picks several files for an attachment and one file for an import, never a folder", async () => {
    const attach = dialogPicking([]);
    await showOpenDialog(attach, new FilePathRefs(), page(1), { purpose: "attachFiles" });
    expect(attach.showOpenDialog).toHaveBeenCalledWith({
      properties: ["openFile", "multiSelections"],
    });

    const importOne = dialogPicking([]);
    await showOpenDialog(importOne, new FilePathRefs(), page(1), { purpose: "importFile" });
    expect(importOne.showOpenDialog).toHaveBeenCalledWith({ properties: ["openFile"] });
  });

  it("answers no files when the person cancels", async () => {
    const canceled: OpenDialogHost = {
      showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    };
    await expect(
      showOpenDialog(canceled, new FilePathRefs(), page(1), { purpose: "attachFiles" }),
    ).resolves.toStrictEqual({ refs: [] });
  });

  it("refuses a purpose it does not know before showing anything", async () => {
    const host = dialogPicking([]);
    await expect(
      showOpenDialog(host, new FilePathRefs(), page(1), { purpose: "openFolder" }),
    ).rejects.toThrow(TypeError);
    expect(host.showOpenDialog).not.toHaveBeenCalled();
  });

  it("forgets a page's tokens when the page goes, and never answers one page another's", async () => {
    const picked = path.join(folder, "a.txt");
    await writeFile(picked, "a", "utf8");
    const refs = new FilePathRefs();
    const owner = page(1);
    const [file] = (
      await showOpenDialog(dialogPicking([picked]), refs, owner, { purpose: "importFile" })
    ).refs;
    if (file === undefined) {
      throw new Error("the dialog picked nothing");
    }

    expect(refs.pathOf(page(2), file.ref)).toBeUndefined();
    owner.destroy();
    expect(refs.pathOf(owner, file.ref)).toBeUndefined();
  });
});

describe("the clipboard", () => {
  it("writes text, and refuses anything else without touching the clipboard", () => {
    const clipboard = { writeText: vi.fn() };

    copyToClipboard(clipboard, "copied");
    expect(clipboard.writeText).toHaveBeenCalledWith("copied");

    expect(() => {
      copyToClipboard(clipboard, { toString: () => "copied" });
    }).toThrow(TypeError);
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
  });
});
