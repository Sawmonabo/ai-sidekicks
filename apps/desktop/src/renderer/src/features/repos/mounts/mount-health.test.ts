// Whether a mount offers its bind controls: withheld on a failing health verdict or an ended
// lifecycle, with lifecycle read first so the reason given is the one that holds.

import { describe, expect, it } from "vitest";

import { readBindControlAvailability } from "./mount-health.js";
import { buildMount } from "./repo-mounts.test-support.js";

describe("mount-health — the third verdict", () => {
  it("withholds the bind controls on a drifted mount, for that reason", () => {
    const posture = readBindControlAvailability(
      buildMount({ health: { status: "identity_mismatch", checkedAt: "2026-01-01T00:00:00Z" } }),
    );
    expect(posture.offered).toBe(false);
    expect(posture.offered === false && posture.withheldBecause).toContain("permanently");
  });
});

describe("mount-health — the bind-control posture", () => {
  it("offers controls on an attached, healthy mount", () => {
    expect(readBindControlAvailability(buildMount())).toStrictEqual({ offered: true });
  });

  it("withholds them on an unreachable mount, and says why", () => {
    const posture = readBindControlAvailability(
      buildMount({ health: { status: "unreachable", checkedAt: "2026-01-01T00:00:00Z" } }),
    );
    expect(posture.offered).toBe(false);
    expect(posture.offered === false && posture.withheldBecause).toContain("could not be probed");
  });

  it("withholds them on a detached mount, which is history rather than a failure", () => {
    const posture = readBindControlAvailability(buildMount({ state: "detached" }));
    expect(posture.offered).toBe(false);
    expect(posture.offered === false && posture.withheldBecause).toContain("mints a new mount");
  });

  it("checks lifecycle before health, so a detached row never reads as unreachable", () => {
    // Both axes are failing. Reporting the health reason would tell a reader to fix a path
    // when the row's life is over.
    const posture = readBindControlAvailability(
      buildMount({
        state: "detached",
        health: { status: "unreachable", checkedAt: "2026-01-01T00:00:00Z" },
      }),
    );
    expect(posture.offered === false && posture.withheldBecause).not.toContain(
      "could not be probed",
    );
  });
});
