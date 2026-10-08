// A publish on a volume with no hard links, where the link answers `ENOTSUP`: the file takes a
// free name by rename, and a name already taken keeps its file.

import { lstat, mkdtemp, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { publishWithoutReplacing, type PublishFileSystem } from "../publish-without-replacing.js";

// Node's own calls but the link, which a FAT-family volume on macOS refuses.
const NO_HARD_LINKS: PublishFileSystem = {
  link: () =>
    Promise.reject(Object.assign(new Error("Operation not supported"), { code: "ENOTSUP" })),
  lstat,
  rename,
  unlink,
};

describe("publishWithoutReplacing on a volume with no hard links", () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "publish-without-replacing-"));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it("renames into a free name and leaves a taken one's file as it was", async () => {
    const temporaryPath = join(folder, ".copy");
    await writeFile(temporaryPath, "the daemon's copy");
    expect(
      await publishWithoutReplacing(temporaryPath, join(folder, "free.md"), NO_HARD_LINKS),
    ).toBe("published");

    await writeFile(join(folder, "taken.md"), "the person's file");
    await writeFile(temporaryPath, "the daemon's copy");
    expect(
      await publishWithoutReplacing(temporaryPath, join(folder, "taken.md"), NO_HARD_LINKS),
    ).toBe("target_exists");

    expect(await readFile(join(folder, "free.md"), "utf8")).toBe("the daemon's copy");
    expect(await readFile(join(folder, "taken.md"), "utf8")).toBe("the person's file");
    expect((await readdir(folder)).toSorted()).toEqual(["free.md", "taken.md"]);
  });
});
