// A tier may ADD a launch switch; it may not take one away.
//
// The harness owns two arguments — the private `--user-data-dir` that keeps a
// launch off Electron's machine-wide `SingletonLock`, and the built main entry
// that says which application this is — and a tier that could drop or reorder
// either would produce failures that look nothing like their cause: an Electron
// losing `requestSingleInstanceLock()` quits before opening a window, which
// reaches the tier as a timeout with no error at all.
//
// So the composition is a concatenation and never a merge, and that is what this
// file holds. Reaching the same property through `launchConsole` would mean
// launching a real Electron to make an assertion about a string array, which is
// why `composeLaunchArgs` is a free function in a module free of
// `@playwright/test` rather than an expression inside the harness.

import { describe, expect, it } from "vitest";

import { composeLaunchArgs } from "../launch-args.js";

/** Stand-ins: the property under test is positional, so the values only have to be distinguishable. */
const PROFILE_DIRECTORY = "/tmp/ai-sidekicks-console-TESTONLY";
const MAIN_ENTRY = "/repo/apps/desktop/out/main/index.js";

/** What the harness owns, written once so the cases below cannot disagree about it. */
const FIXED_ARGS = [`--user-data-dir=${PROFILE_DIRECTORY}`, MAIN_ENTRY];

describe("launch args — the fixed set is authoritative and first", () => {
  it("yields exactly the fixed set when a caller passes none", () => {
    // Byte-identical, and asserted as a whole array rather than by membership:
    // an extra argument nobody asked for is as much a defect as a missing one,
    // and `toContain` would see neither.
    expect(composeLaunchArgs(PROFILE_DIRECTORY, MAIN_ENTRY)).toStrictEqual(FIXED_ARGS);
    // An explicitly empty list is the same statement as omitting it. Callers
    // build these conditionally — `platform === "linux" ? GL_FLAGS : []` — so the
    // empty case is the ordinary one on three quarters of the matrix, not an edge.
    expect(composeLaunchArgs(PROFILE_DIRECTORY, MAIN_ENTRY, [])).toStrictEqual(FIXED_ARGS);
  });

  it("appends a caller's switches after the fixed ones, in the caller's order", () => {
    // The real motivating set: ANGLE onto SwiftShader on a GPU-less runner, which
    // is what lets a tier tell a genuine WebGL renderer tier from a silent canvas
    // fallback.
    const callerArgs = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
    expect(composeLaunchArgs(PROFILE_DIRECTORY, MAIN_ENTRY, callerArgs)).toStrictEqual([
      ...FIXED_ARGS,
      ...callerArgs,
    ]);
  });

  it("lets a caller's switch shadow nothing: the harness's copy still comes first", () => {
    // The case the append order exists for. A caller that passes its own
    // `--user-data-dir` does not replace the harness's — Chromium takes the
    // first occurrence of a switch, so the private profile still wins and the
    // caller's is inert rather than able to break the isolation.
    const composed = composeLaunchArgs(PROFILE_DIRECTORY, MAIN_ENTRY, [
      "--user-data-dir=/somewhere/else",
    ]);
    expect(composed[0]).toBe(`--user-data-dir=${PROFILE_DIRECTORY}`);
    expect(composed.indexOf(`--user-data-dir=${PROFILE_DIRECTORY}`)).toBeLessThan(
      composed.indexOf("--user-data-dir=/somewhere/else"),
    );
    // And the main entry keeps its place between them, so the launch still points
    // at this application.
    expect(composed[1]).toBe(MAIN_ENTRY);
  });

  it("negative control: a caller's switches are absent unless they are passed", () => {
    // Without this the cases above would pass over a composer that appended a
    // hardcoded list, which is the shape the inert `ELECTRON_EXTRA_LAUNCH_ARGS`
    // mechanism this replaces had at the point of use.
    expect(composeLaunchArgs(PROFILE_DIRECTORY, MAIN_ENTRY)).not.toContain("--use-gl=angle");
  });

  it("does not let a caller mutate the harness's own array", () => {
    // Two launches in one endurance file share this module. A composer that
    // returned or spliced a shared array would let the first launch's switches
    // reach the second, which is a defect no single-launch assertion can see.
    const first = composeLaunchArgs(PROFILE_DIRECTORY, MAIN_ENTRY, ["--first-only"]);
    first.push("--mutated");
    expect(composeLaunchArgs(PROFILE_DIRECTORY, MAIN_ENTRY)).toStrictEqual(FIXED_ARGS);
  });
});
