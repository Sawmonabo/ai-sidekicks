// Whether a mount offers its bind controls: withheld on a failing health verdict or an ended
// lifecycle, with lifecycle read first so the reason given is the one that holds.

import { describe, expect, it } from "vitest";

import { readBindControlAvailability } from "./health.js";
import { buildMount } from "./repo-mounts.test-support.js";

describe("mount-health — a drifted mount", () => {
  it("withholds the bind controls, saying the drift is permanent", () => {
    const availability = readBindControlAvailability(
      buildMount({ health: { status: "identity_mismatch", checkedAt: "2026-01-01T00:00:00Z" } }),
    );
    expect(availability.available).toBe(false);
    expect(availability.available === false && availability.unavailableBecause).toContain(
      "permanently",
    );
  });
});

describe("mount-health — the bind-control availability", () => {
  it("offers controls on an attached, healthy mount", () => {
    expect(readBindControlAvailability(buildMount())).toStrictEqual({ available: true });
  });

  it("withholds them on an unreachable mount, and says why", () => {
    const availability = readBindControlAvailability(
      buildMount({ health: { status: "unreachable", checkedAt: "2026-01-01T00:00:00Z" } }),
    );
    expect(availability.available).toBe(false);
    expect(availability.available === false && availability.unavailableBecause).toContain(
      "could not be probed",
    );
  });

  it("withholds them on a detached mount, which is history rather than a failure", () => {
    const availability = readBindControlAvailability(buildMount({ state: "detached" }));
    expect(availability.available).toBe(false);
    expect(availability.available === false && availability.unavailableBecause).toContain(
      "mints a new mount",
    );
  });

  it("checks lifecycle before health, so a detached row never reads as unreachable", () => {
    // Both axes are failing. Reporting the health reason would tell a reader to fix a path
    // when the row's life is over.
    const availability = readBindControlAvailability(
      buildMount({
        state: "detached",
        health: { status: "unreachable", checkedAt: "2026-01-01T00:00:00Z" },
      }),
    );
    expect(availability.available === false && availability.unavailableBecause).not.toContain(
      "could not be probed",
    );
  });
});
