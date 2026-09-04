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

import { composeLaunchArgs, HarnessOwnedSwitchError } from "../launch-args.js";

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

  it("refuses a switch the harness owns, naming it", () => {
    // This case previously asserted the OPPOSITE and passed, which is the whole
    // lesson: it checked that the harness's `--user-data-dir` sat at a lower
    // index than the caller's and concluded the caller's was inert. Array
    // position is not what Chromium reads. `base::CommandLine` assigns each
    // parsed switch into a map, so the LAST duplicate wins — measured against a
    // real launch, where `app.getPath("userData")` reported the CALLER's
    // directory. Order can therefore never be the guarantee; refusal is.
    let refusal: unknown;
    try {
      composeLaunchArgs(PROFILE_DIRECTORY, MAIN_ENTRY, ["--user-data-dir=/somewhere/else"]);
    } catch (error: unknown) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(HarnessOwnedSwitchError);
    expect((refusal as HarnessOwnedSwitchError).switchName).toBe("--user-data-dir");
  });

  it("refuses the valueless form of an owned switch too", () => {
    // `--user-data-dir` with no `=` is still that switch, and Chromium would
    // still take it as the later occurrence. Matching on the name rather than on
    // the whole argument is what makes the refusal cover both spellings.
    expect(() => composeLaunchArgs(PROFILE_DIRECTORY, MAIN_ENTRY, ["--user-data-dir"])).toThrow(
      HarnessOwnedSwitchError,
    );
    // And a value containing its own `=` still names the same switch, so the
    // split is on the FIRST one.
    expect(() =>
      composeLaunchArgs(PROFILE_DIRECTORY, MAIN_ENTRY, ["--user-data-dir=/tmp/a=b"]),
    ).toThrow(HarnessOwnedSwitchError);
  });

  it("negative control: an unowned switch that merely resembles one is admitted", () => {
    // Without this the refusal could be a rule that rejects anything with
    // `user-data-dir` in it, or anything at all. These are distinct switches
    // Chromium treats separately, and a tier must still be able to pass them.
    const admitted = ["--user-data-dir-suffix=x", "--use-gl=angle"];
    expect(composeLaunchArgs(PROFILE_DIRECTORY, MAIN_ENTRY, admitted)).toStrictEqual([
      ...FIXED_ARGS,
      ...admitted,
    ]);
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
