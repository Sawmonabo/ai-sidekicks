// Lifecycle and health stay two axes: the disjointness case fails the moment one axis borrows
// the other's vocabulary, which is the shape a collapse takes.

import { describe, expect, it } from "vitest";

import {
  readBindControlAvailability,
  mountHealthReading,
  mountLifecycleReading,
} from "./mount-health.js";
import { buildMount } from "./repo-mounts.test-support.js";

describe("mount-health — the health axis", () => {
  it("gives each wire status its own tone, word, and sentence", () => {
    const healthy = mountHealthReading({ status: "healthy", checkedAt: "2026-01-01T00:00:00Z" });
    const unreachable = mountHealthReading({
      status: "unreachable",
      checkedAt: "2026-01-01T00:00:00Z",
    });
    expect(healthy.label).toBe("healthy");
    expect(unreachable.label).toBe("unreachable");
    expect(healthy.tone).toBe("neutral");
    expect(unreachable.tone).toBe("failure");
    expect(unreachable.sentence).not.toBe(healthy.sentence);
  });

  it("does not soften `unreachable` into a maybe", () => {
    const unreachable = mountHealthReading({
      status: "unreachable",
      checkedAt: "2026-01-01T00:00:00Z",
    });
    // Precedence between failing verdicts is the daemon's, so the copy states the
    // consequence rather than hedging it.
    expect(unreachable.sentence).toContain("could not be probed");
    expect(unreachable.sentence.toLowerCase()).not.toContain("might");
  });
});

describe("mount-health — the third verdict", () => {
  it("reads `identity_mismatch` as its own verdict rather than a second unreachable", () => {
    const drifted = mountHealthReading({
      status: "identity_mismatch",
      checkedAt: "2026-01-01T00:00:00Z",
    });
    const unreachable = mountHealthReading({
      status: "unreachable",
      checkedAt: "2026-01-01T00:00:00Z",
    });
    expect(drifted.label).toBe("identity_mismatch");
    expect(drifted.tone).toBe("failure");
    expect(drifted.sentence).not.toBe(unreachable.sentence);
  });

  it("says the refusal is permanent, which is what separates it from unreachable", () => {
    // An unreachable root can answer again; a root holding a different repository cannot
    // become the attached one, so the copy has to say waiting is the wrong move.
    const drifted = mountHealthReading({
      status: "identity_mismatch",
      checkedAt: "2026-01-01T00:00:00Z",
    });
    expect(drifted.sentence).toContain("permanently");
    expect(drifted.sentence).toContain("mints a new mount");
  });

  it("withholds the bind controls on a drifted mount, for that reason", () => {
    const posture = readBindControlAvailability(
      buildMount({ health: { status: "identity_mismatch", checkedAt: "2026-01-01T00:00:00Z" } }),
    );
    expect(posture.offered).toBe(false);
    expect(posture.offered === false && posture.withheldBecause).toContain("permanently");
  });
});

describe("mount-health — the two axes never collapse", () => {
  it("negative control: no lifecycle word is also a health word", () => {
    // `stale` was rejected as a health status because it already names a workspace state; one
    // vocabulary across two axes leaves a reader unable to tell detached from unreachable.
    const lifecycleWords = new Set(
      (["attached", "detached", "archived"] as const).map(
        (state) => mountLifecycleReading(state).label,
      ),
    );
    for (const status of ["healthy", "unreachable"] as const) {
      expect(lifecycleWords.has(mountHealthReading({ status, checkedAt: "" }).label)).toBe(false);
    }
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

  it("negative control: lifecycle is checked before health, so a detached row never reads as unreachable", () => {
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
