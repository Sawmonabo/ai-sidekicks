// The absence predicate, driven with rejections the file system actually produced.
//
// Hand-built `{ code: "ENOTDIR" }` objects would prove only that the predicate reads a
// property this file wrote. Both absence codes are raised here by real `stat` calls
// against real paths, so the case fails if the kernel ever stops answering the way the
// module's header says it does — and the negative controls are what keep "absence" from
// quietly widening into "the call did not succeed".

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
    // The code the two private predicates disagreed on. Asserted on the rejection the
    // kernel raised rather than on a literal, so this reads ENOTDIR only for as long as
    // `stat` keeps answering that way.
    const parentThatIsAFile = join(directory, "occupied");
    await writeFile(parentThatIsAFile, "not a directory", "utf8");

    const failure = await rejectionOf(() => stat(join(parentThatIsAFile, "main.jsonl")));

    expect((failure as { code?: unknown } | null)?.code).toBe("ENOTDIR");
    expect(isMissingPath(failure)).toBe(true);
  });

  it("negative control: a directory that is there is not absent", async () => {
    // The control for the two cases above. A predicate that had widened to "something
    // went wrong" would still pass both of them and fail here, because this call does
    // not reject at all.
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
