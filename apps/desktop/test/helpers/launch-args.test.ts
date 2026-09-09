// The command line the two launching tiers actually get.
//
// One claim, about the array `composeLaunchArgs` builds: a GPU-less host is handed
// a software GL stack and a host with its own is not, which is a property no launch
// has to run to check.
//
// That the launcher spells no switch of its own, and feeds the composer the host it
// launches on rather than a platform written down, is a structure rule rather than a
// behaviour: it lives in `apps/desktop/AGENTS.md` and reviewers hold code to it. The
// history behind it is worth keeping: `composeLaunchArgs` and its whole refusal
// machinery landed once with a passing test and NO caller, and were deleted for it
// two commits later, while the tier that motivated them went on launching with a
// hard-coded pair. A composer whose correctness is asserted and whose use is assumed
// is the exact shape that left the `terminal-instance-memory` row unreadable on
// every Linux runner.

import { describe, expect, it } from "vitest";

import {
  composeLaunchArgs,
  SOFTWARE_GRAPHICS_SWITCHES,
  softwareGraphicsSwitchesFor,
  type LaunchPlatform,
} from "../console/launch-args.js";

/** Stand-ins for the two arguments the harness owns, so a failure names the shape. */
const PROFILE_DIRECTORY = "/tmp/ai-sidekicks-console-probe";
const MAIN_ENTRY_PATH = "/repo/apps/desktop/out/main/index.js";

/** The composed argv for one platform, with everything else held still. */
function argsFor(platform: LaunchPlatform, isPreciseHeapReadingRequired = false): string[] {
  return composeLaunchArgs({
    profileDirectory: PROFILE_DIRECTORY,
    mainEntryPath: MAIN_ENTRY_PATH,
    isPreciseHeapReadingRequired,
    platform,
  });
}

describe("launch arguments — the software GL a GPU-less host is given", () => {
  it("hands a Linux launch the whole software graphics stack, in order", () => {
    // The pre-fix shape passed nothing here, so the ubuntu runner reached the
    // `terminal-instance-memory` row with no WebGL2 and the pane fell back to the
    // DOM renderer — a subject the row does not bound.
    expect(argsFor("linux")).toStrictEqual([
      `--user-data-dir=${PROFILE_DIRECTORY}`,
      ...SOFTWARE_GRAPHICS_SWITCHES,
      MAIN_ENTRY_PATH,
    ]);
  });

  it("names the three switches SwANGLE needs and no others", () => {
    // Pinned as a set rather than left to the composition case: two of them select
    // the driver and the third is the opt-in that lets WebGL be served from it, and
    // a launch missing any one of the three reaches a renderer with no WebGL2.
    expect([...SOFTWARE_GRAPHICS_SWITCHES]).toStrictEqual([
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ]);
  });

  it("gives a host that has its own GL none of them", () => {
    // The negative control, and it is not tidiness. Measured on this Electron's
    // darwin-arm64 build: with these switches the GPU process dies with
    // `eglInitialize SwANGLE failed` and the renderer reports no WebGL2 at all,
    // where the unswitched launch reports the ANGLE Metal renderer. Forcing them
    // everywhere would take the context away on exactly the platform that has one.
    for (const platform of ["darwin", "win32"] as const) {
      expect(argsFor(platform)).toStrictEqual([
        `--user-data-dir=${PROFILE_DIRECTORY}`,
        MAIN_ENTRY_PATH,
      ]);
      expect(softwareGraphicsSwitchesFor(platform)).toStrictEqual([]);
    }
  });

  it("keeps the profile first and the entry path last on every platform", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const args = argsFor(platform, true);
      expect(args.at(0)).toBe(`--user-data-dir=${PROFILE_DIRECTORY}`);
      expect(args.at(-1)).toBe(MAIN_ENTRY_PATH);
    }
  });

  it("adds the precise-heap switch only for a launch that measures a heap", () => {
    expect(argsFor("linux", true)).toContain("--enable-precise-memory-info");
    expect(argsFor("linux", false)).not.toContain("--enable-precise-memory-info");
  });

  it("cannot leak one launch's arguments into the next", () => {
    const first = argsFor("linux");
    first.push("--a-switch-a-caller-appended");
    expect(argsFor("linux")).not.toContain("--a-switch-a-caller-appended");
  });
});
