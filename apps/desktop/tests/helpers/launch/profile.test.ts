import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { createLaunchProfile, GpuCacheCarry, type MintedLaunchProfile } from "./profile.js";

const CARRIED_DIRECTORIES = ["DawnGraphiteCache", "DawnWebGPUCache", "GPUCache"];

/** A carry removed when the test ends, as the harness removes the running test's. */
function mintedCarry(): GpuCacheCarry {
  const carry = new GpuCacheCarry();
  onTestFinished(() => {
    carry.remove();
  });
  return carry;
}

/** A profile whose directory is removed when the test ends, whatever it asserted first. */
function mintedProfile(carry: GpuCacheCarry): MintedLaunchProfile {
  const profile = createLaunchProfile({ gpuCacheCarry: carry });
  onTestFinished(() => {
    profile.remove();
  });
  return profile;
}

/** Write what Chromium would leave in a profile's GPU cache folders, one file per folder. */
function writeGpuCaches(profileDirectory: string, contents: string): void {
  for (const name of CARRIED_DIRECTORIES) {
    mkdirSync(join(profileDirectory, name));
    writeFileSync(join(profileDirectory, name, "data_0"), contents);
  }
}

describe("GpuCacheCarry", () => {
  it("starts a test's first profile cold and hands each later one the caches the last closed with", () => {
    const carry = mintedCarry();

    const first = mintedProfile(carry);
    expect(first.carriedGpuCaches).toEqual([]);
    for (const name of CARRIED_DIRECTORIES) {
      expect(existsSync(join(first.directory, name))).toBe(false);
    }
    writeGpuCaches(first.directory, "first launch");
    first.remove();
    expect(existsSync(first.directory)).toBe(false);

    const second = mintedProfile(carry);
    expect(second.carriedGpuCaches).toEqual(CARRIED_DIRECTORIES);
    for (const name of CARRIED_DIRECTORIES) {
      expect(readFileSync(join(second.directory, name, "data_0"), "utf8")).toBe("first launch");
    }
  });

  it("leaves no copy behind once removed, even when a launch closes after its test finished", () => {
    const carry = new GpuCacheCarry();
    const profile = createLaunchProfile({ gpuCacheCarry: carry });
    writeGpuCaches(profile.directory, "a launch still closing");
    carry.remove();
    // A close that settles after the carry was removed must not copy its caches back into it.
    profile.remove();

    expect(existsSync(carry.directory)).toBe(false);
    expect(existsSync(profile.directory)).toBe(false);
  });
});
