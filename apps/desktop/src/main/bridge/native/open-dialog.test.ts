// The page gets a token for each pick, never its path.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenDialogResult, PickedFolder } from "#shared/preload-api.js";
import { FilePathRefs } from "../file-path/refs.js";
import { pageOwner } from "../file-path/refs.test-support.js";
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
    expect(refs.requirePath(owner, file?.ref, "attach")).toBe(picked);
  });

  it("answers a picked folder as one token and its name, its path kept in main, or null on cancel", async () => {
    const refs = new FilePathRefs();
    const owner = pageOwner(1);

    const picked = (await showOpenDialog(dialogPicking([folder]), refs, owner, {
      purpose: "pickFolder",
    })) as PickedFolder | null;

    expect(picked?.name).toBe(path.basename(folder));
    expect(picked?.ref).not.toContain(folder);
    expect(refs.requirePath(owner, picked?.ref, "folder")).toBe(folder);

    const canceled: OpenDialogHost = {
      showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    };
    await expect(
      showOpenDialog(canceled, refs, owner, { purpose: "pickFolder" }),
    ).resolves.toBeNull();
  });
});
