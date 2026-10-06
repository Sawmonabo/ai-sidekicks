// A dropped or pasted file reaches the page only as a token. A pasted picture is a file only the
// person can read, gone with the page that pasted it, a paste waits on the start's folder
// preparation and a failed one is tried again, and nothing the page builds itself becomes a path
// main hands out.

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilePathRefs } from "../file-path/refs.js";
import { pageOwner } from "../file-path/refs.test-support.js";
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
    expect(refs.requirePath(owner, ref, "attach")).toBe(dropped);
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
    const filePath = refs.requirePath(owner, ref, "attach");

    expect(ref).not.toContain(folder);
    expect(path.dirname(filePath)).toBe(folder);
    expect(new Uint8Array(await readFile(filePath))).toStrictEqual(bytes);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
  });

  it("is removed when its page goes", async () => {
    const folder = path.join(scratch, "pasted");
    const refs = new FilePathRefs();
    const owner = pageOwner(1);
    const ref = await pastedImagesIn(folder, refs).save(owner, new Uint8Array([1, 2, 3]).buffer);
    const filePath = refs.requirePath(owner, ref, "attach");

    owner.destroy();

    await vi.waitFor(async () => {
      await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("is removed when its page loads a new document, whose tokens it no longer serves", async () => {
    const folder = path.join(scratch, "pasted");
    const refs = new FilePathRefs();
    const owner = pageOwner(1);
    const ref = await pastedImagesIn(folder, refs).save(owner, new Uint8Array([1]).buffer);
    const filePath = refs.requirePath(owner, ref, "attach");

    owner.navigate();

    await vi.waitFor(async () => {
      await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("is not kept for a page that went while it was being written", async () => {
    const folder = path.join(scratch, "pasted");
    const owner = pageOwner(1);
    const pastedImages = pastedImagesIn(folder, new FilePathRefs());
    const saving = pastedImages.save(owner, new Uint8Array([1]).buffer);
    owner.destroy();

    await expect(saving).rejects.toThrow("has closed");
    await expect(readdir(folder)).resolves.toStrictEqual([]);
  });

  it("clears what an earlier run left in its folder at start, before any paste", async () => {
    const folder = path.join(scratch, "pasted");
    await mkdir(folder);
    const leftOver = path.join(folder, "pasted-image-from-an-earlier-run");
    await writeFile(leftOver, "old", "utf8");

    pastedImagesIn(folder, new FilePathRefs());

    await vi.waitFor(async () => {
      await expect(stat(leftOver)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  // Windows keeps no POSIX mode bits to lock a folder with.
  it.skipIf(process.platform === "win32")(
    "fails a paste made while the start's preparation fails, and prepares again at the next",
    async () => {
      // The folder an earlier run left, open to others, under a parent main may not change, so
      // the start can neither empty it nor make it the person's alone.
      const parent = path.join(scratch, "profile");
      const folder = path.join(parent, "pasted");
      await mkdir(folder, { recursive: true, mode: 0o755 });
      await chmod(parent, 0o500);
      const owner = pageOwner(1);
      const refs = new FilePathRefs();
      try {
        const pastedImages = pastedImagesIn(folder, refs);
        await expect(pastedImages.save(owner, new Uint8Array([1]).buffer)).rejects.toMatchObject({
          code: "EACCES",
        });
        await expect(readdir(folder)).resolves.toStrictEqual([]);

        await chmod(parent, 0o700);
        const ref = await pastedImages.save(owner, new Uint8Array([2]).buffer);
        expect(path.dirname(refs.requirePath(owner, ref, "attach"))).toBe(folder);
        expect((await stat(folder)).mode & 0o777).toBe(0o700);
      } finally {
        await chmod(parent, 0o700);
      }
    },
  );

  it("is removed once the service has copied it, and only that one", async () => {
    const folder = path.join(scratch, "pasted");
    const refs = new FilePathRefs();
    const owner = pageOwner(1);
    const pastedImages = pastedImagesIn(folder, refs);
    const copied = refs.requirePath(
      owner,
      await pastedImages.save(owner, new Uint8Array([1]).buffer),
      "attach",
    );
    const kept = refs.requirePath(
      owner,
      await pastedImages.save(owner, new Uint8Array([2]).buffer),
      "attach",
    );

    // Another page's paths, and a path no paste wrote, are left alone.
    pastedImages.removeCopied(pageOwner(2), [kept]);
    pastedImages.removeCopied(owner, [copied, path.join(scratch, "somewhere-else.png")]);

    await vi.waitFor(async () => {
      await expect(stat(copied)).rejects.toMatchObject({ code: "ENOENT" });
    });
    await expect(stat(kept)).resolves.toBeDefined();
  });

  it("refuses empty or non-byte input", async () => {
    const pastedImages = pastedImagesIn(path.join(scratch, "pasted"), new FilePathRefs());
    for (const bytes of [new ArrayBuffer(0), new Uint8Array([1]), "a picture", [1, 2], undefined]) {
      await expect(pastedImages.save(pageOwner(1), bytes)).rejects.toThrow(TypeError);
    }
  });
});
