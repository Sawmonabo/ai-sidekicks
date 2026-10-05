// A dropped or pasted file reaches the page only as a token. A pasted picture is a file only the
// person can read, gone with the page that pasted it, and nothing the page builds itself becomes a
// path main hands out.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilePathRefs } from "../file-path-refs.js";
import { pageOwner } from "../file-path-refs.test-support.js";
import { PastedImages, refForDroppedFile } from "./file-intake.js";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "sidekicks-file-intake-test-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function pastedImagesIn(folder: string, refs: FilePathRefs): PastedImages {
  return new PastedImages({
    folder,
    filePathRefs: refs,
    log: { write: vi.fn() },
    now: () => new Date(),
  });
}

describe("a dropped file", () => {
  it("answers a token for a dropped file and refuses a folder, a relative path and a non-path", async () => {
    const dropped = path.join(scratch, "notes.md");
    await writeFile(dropped, "notes", "utf8");
    const refs = new FilePathRefs();
    const owner = pageOwner(1);

    const ref = await refForDroppedFile(refs, owner, dropped);

    expect(ref).not.toContain(scratch);
    expect(refs.pathOf(owner, ref)).toBe(dropped);
    for (const droppedPath of [scratch, "notes.md", "", undefined]) {
      await expect(refForDroppedFile(refs, owner, droppedPath)).rejects.toThrow(TypeError);
    }
  });
});

describe("a pasted picture", () => {
  it("is written whole to a file only the person can read, and answered as a token", async () => {
    const folder = path.join(scratch, "pasted");
    const refs = new FilePathRefs();
    const owner = pageOwner(1);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    const ref = await pastedImagesIn(folder, refs).save(owner, bytes.buffer);
    const filePath = refs.requirePath(owner, ref);

    expect(ref).not.toContain(folder);
    expect(path.dirname(filePath)).toBe(folder);
    expect(new Uint8Array(await readFile(filePath))).toStrictEqual(bytes);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
  });

  it("is removed when its page goes, and a later page's token never opens it", async () => {
    const folder = path.join(scratch, "pasted");
    const refs = new FilePathRefs();
    const owner = pageOwner(1);
    const ref = await pastedImagesIn(folder, refs).save(owner, new Uint8Array([1, 2, 3]));
    const filePath = refs.requirePath(owner, ref);

    expect(() => refs.requirePath(pageOwner(2), ref)).toThrow(TypeError);
    owner.destroy();

    await vi.waitFor(async () => {
      await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
    expect(() => refs.requirePath(owner, ref)).toThrow(TypeError);
  });

  it("clears what an earlier run left in its folder, and refuses empty or non-byte input", async () => {
    const folder = path.join(scratch, "pasted");
    await mkdir(folder);
    const leftOver = path.join(folder, "pasted-image-from-an-earlier-run");
    await writeFile(leftOver, "old", "utf8");
    const pastedImages = pastedImagesIn(folder, new FilePathRefs());

    await pastedImages.save(pageOwner(1), new Uint8Array([7]));

    await expect(stat(leftOver)).rejects.toMatchObject({ code: "ENOENT" });
    for (const bytes of [new Uint8Array(0), "a picture", [1, 2], undefined]) {
      await expect(pastedImages.save(pageOwner(1), bytes)).rejects.toThrow(TypeError);
    }
  });
});
