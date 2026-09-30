// Both absence codes are raised by real `stat` calls, so the case fails if the kernel stops
// answering as the module expects; the negative controls keep "absence" from widening into
// "the call did not succeed".

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isMissingPath } from "./missing-path.js";

/** The rejection `operation` produced, or `null` when it did not reject. */
async function rejectionOf(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    return null;
  } catch (failure) {
    return failure;
  }
}

describe("isMissingPath", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "sidekicks-missing-path-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("answers a path with no entry at all", async () => {
    const failure = await rejectionOf(() => stat(join(directory, "never-written.jsonl")));

    expect((failure as { code?: unknown } | null)?.code).toBe("ENOENT");
    expect(isMissingPath(failure)).toBe(true);
  });

  it("answers a path whose parent is a file", async () => {
    const parentThatIsAFile = join(directory, "occupied");
    await writeFile(parentThatIsAFile, "not a directory", "utf8");

    const failure = await rejectionOf(() => stat(join(parentThatIsAFile, "main.jsonl")));

    expect((failure as { code?: unknown } | null)?.code).toBe("ENOTDIR");
    expect(isMissingPath(failure)).toBe(true);
  });

  it("negative control: a directory that is there is not absent", async () => {
    // A predicate widened to "something went wrong" would pass both cases above and fail here,
    // because this call does not reject at all.
    expect(await rejectionOf(() => stat(directory))).toBeNull();
  });

  it.each([
    ["a failure carrying another errno", { code: "EACCES" }],
    ["a failure carrying no code at all", new Error("the disk went away")],
    ["a code that is not a string", { code: 20 }],
    ["a rejection that is not an object", "ENOENT"],
    ["a rejection that is null", null],
  ])("negative control: %s is not absence", (_description, failure) => {
    expect(isMissingPath(failure)).toBe(false);
  });
});
