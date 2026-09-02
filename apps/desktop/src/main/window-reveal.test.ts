// `window-reveal.ts` unit tests — the unobtrusive-windows decision.
//
// This project substitutes both build flags with `false` (see `vitest.config.ts`,
// `main-unit`), which is the release shape. The two pure resolvers therefore
// take the build kind as an argument so the test-build arm is reachable here,
// and the two wrappers are exercised on the release arm they are compiled into.

import { describe, expect, it, vi } from "vitest";

import {
  UNOBTRUSIVE_WINDOWS_ENV,
  applyRevealPreferences,
  installActivationPolicy,
  resolveActivationPolicyChange,
  resolveWindowRevealMode,
  revealWindow,
} from "./window-reveal.js";

const REQUESTED: NodeJS.ProcessEnv = { [UNOBTRUSIVE_WINDOWS_ENV]: "1" };

describe("resolveWindowRevealMode", () => {
  it("reveals inactive when a test build is asked to", () => {
    expect(resolveWindowRevealMode(true, REQUESTED)).toBe("inactive");
  });

  it("ignores the request outside a test build", () => {
    // Negative control for the production-safety claim: the same environment,
    // a release build, an ordinary reveal.
    expect(resolveWindowRevealMode(false, REQUESTED)).toBe("active");
  });

  it("reveals active in a test build that was not asked", () => {
    expect(resolveWindowRevealMode(true, {})).toBe("active");
  });

  it("accepts exactly the string 1", () => {
    // The opt-in is deliberate, like the smoke probe's: a truthy-looking value
    // is not a request.
    expect(resolveWindowRevealMode(true, { [UNOBTRUSIVE_WINDOWS_ENV]: "true" })).toBe("active");
  });
});

describe("resolveActivationPolicyChange", () => {
  it("moves a requested macOS test build to the accessory policy", () => {
    expect(resolveActivationPolicyChange(true, REQUESTED, "darwin")).toBe("accessory");
  });

  it.each(["linux", "win32"] as const)("changes nothing on %s", (platform) => {
    expect(resolveActivationPolicyChange(true, REQUESTED, platform)).toBeNull();
  });

  it("changes nothing on macOS without the request", () => {
    expect(resolveActivationPolicyChange(true, {}, "darwin")).toBeNull();
  });

  it("changes nothing on macOS outside a test build", () => {
    expect(resolveActivationPolicyChange(false, REQUESTED, "darwin")).toBeNull();
  });
});

describe("the release-compiled wrappers", () => {
  it("revealWindow shows the window the ordinary way", () => {
    // Both flags are `false` in this project, so even with the variable set in
    // the real environment the release arm is the one compiled in.
    vi.stubEnv(UNOBTRUSIVE_WINDOWS_ENV, "1");
    const show = vi.fn();
    const showInactive = vi.fn();

    revealWindow({ show, showInactive });

    expect(show).toHaveBeenCalledOnce();
    expect(showInactive).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("applyRevealPreferences keeps Chromium's default throttling", () => {
    vi.stubEnv(UNOBTRUSIVE_WINDOWS_ENV, "1");
    const setBackgroundThrottling = vi.fn();

    applyRevealPreferences({ webContents: { setBackgroundThrottling } });

    expect(setBackgroundThrottling).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("installActivationPolicy leaves the policy alone", () => {
    vi.stubEnv(UNOBTRUSIVE_WINDOWS_ENV, "1");
    const setActivationPolicy = vi.fn();

    installActivationPolicy({ setActivationPolicy }, "darwin");

    expect(setActivationPolicy).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
