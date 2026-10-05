// The page gets a token, never a path, and nothing it sends is acted on unchecked.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenDialogResult } from "@shared/preload-api.js";
import { FilePathRefs } from "../file-path/file-path-refs.js";
import { pageOwner } from "../file-path/file-path-refs.test-support.js";
import { showOpenDialog, type OpenDialogHost } from "./open-dialog.js";

let folder: string;

/** The open dialog for a file purpose, whose answer is the picked files. */
async function showFileDialog(
  ...args: Parameters<typeof showOpenDialog>
): Promise<OpenDialogResult> {
  return (await showOpenDialog(...args)) as OpenDialogResult;
}

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "sidekicks-open-dialog-test-"));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

function dialogPicking(filePaths: readonly string[]): OpenDialogHost {
  return {
    showOpenDialog: vi.fn(() => Promise.resolve({ canceled: false, filePaths })),
  };
}

describe("the open dialog", () => {
  it("answers each picked file as a token, name and size, and keeps the path in main", async () => {
    const picked = path.join(folder, "notes.md");
    await writeFile(picked, "twelve bytes", "utf8");
    const refs = new FilePathRefs();
    const owner = pageOwner(1);

    const result = await showFileDialog(dialogPicking([picked]), refs, owner, {
      purpose: "attachFiles",
    });

    expect(result.refs).toHaveLength(1);
    const [file] = result.refs;
    expect(file?.name).toBe("notes.md");
    expect(file?.sizeBytes).toBe(12);
    expect(JSON.stringify(result)).not.toContain(folder);
    expect(file === undefined ? undefined : refs.pathOf(owner, file.ref)).toBe(picked);
  });

  it("answers a picked folder as one token, its path kept in main, or null on cancel", async () => {
    const refs = new FilePathRefs();
    const owner = pageOwner(1);

    const ref = await showOpenDialog(dialogPicking([folder]), refs, owner, {
      purpose: "pickFolder",
    });

    expect(typeof ref).toBe("string");
    expect(ref).not.toContain(folder);
    expect(typeof ref === "string" ? refs.pathOf(owner, ref) : undefined).toBe(folder);

    const canceled: OpenDialogHost = {
      showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    };
    await expect(
      showOpenDialog(canceled, refs, owner, { purpose: "pickFolder" }),
    ).resolves.toBeNull();
  });

  it("refuses a purpose it does not know before showing anything", async () => {
    const host = dialogPicking([]);
    await expect(
      showOpenDialog(host, new FilePathRefs(), pageOwner(1), { purpose: "openFolder" }),
    ).rejects.toThrow(TypeError);
    expect(host.showOpenDialog).not.toHaveBeenCalled();
  });

  it("forgets a page's tokens when it goes, and never answers one page another's", async () => {
    const picked = path.join(folder, "a.txt");
    await writeFile(picked, "a", "utf8");
    const refs = new FilePathRefs();
    const owner = pageOwner(1);
    const [file] = (
      await showFileDialog(dialogPicking([picked]), refs, owner, { purpose: "importFile" })
    ).refs;
    if (file === undefined) {
      throw new Error("the dialog picked nothing");
    }

    expect(refs.pathOf(pageOwner(2), file.ref)).toBeUndefined();
    owner.destroy();
    expect(refs.pathOf(owner, file.ref)).toBeUndefined();
  });
});
