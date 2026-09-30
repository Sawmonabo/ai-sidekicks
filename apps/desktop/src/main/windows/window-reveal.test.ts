// The unobtrusive-windows decision. `vitest.config.ts` (`main-unit`) substitutes the test-tier
// build flag with `false`, the release shape, so the two pure resolvers take the build kind as an
// argument to reach the test-build arm, and the wrappers are exercised on the release arm.

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
  it("never reveals a requested macOS test build", () => {
    // Nothing is ordered onto a screen or Space.
    expect(resolveWindowRevealMode(true, REQUESTED, "darwin")).toBe("hidden");
  });

  it.each(["linux", "win32"] as const)("reveals inactive on %s", (platform) => {
    // A hidden window stops painting on Windows (electron/electron#31016).
    expect(resolveWindowRevealMode(true, REQUESTED, platform)).toBe("inactive");
  });

  it("ignores the request outside a test build", () => {
    // Negative control: the same environment in a release build reveals ordinarily.
    expect(resolveWindowRevealMode(false, REQUESTED, "darwin")).toBe("active");
  });

  it("reveals active in a test build that was not asked", () => {
    expect(resolveWindowRevealMode(true, {}, "darwin")).toBe("active");
  });

  it("accepts exactly the string 1", () => {
    // A deliberate opt-in, like the smoke probe's: a truthy-looking value is not a request.
    expect(resolveWindowRevealMode(true, { [UNOBTRUSIVE_WINDOWS_ENV]: "true" }, "darwin")).toBe(
      "active",
    );
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
    // Both flags are `false` here, so the release arm is compiled in even with the variable set.
    vi.stubEnv(UNOBTRUSIVE_WINDOWS_ENV, "1");
    const show = vi.fn();
    const showInactive = vi.fn();

    revealWindow({ show, showInactive }, "darwin");

    expect(show).toHaveBeenCalledOnce();
    expect(showInactive).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("applyRevealPreferences keeps Chromium's default throttling", () => {
    vi.stubEnv(UNOBTRUSIVE_WINDOWS_ENV, "1");
    const setBackgroundThrottling = vi.fn();

    applyRevealPreferences({ webContents: { setBackgroundThrottling } }, "darwin");

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
