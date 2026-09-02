// The two axes stay two axes.
//
// `mount-health.ts`'s central claim about this surface is a
// NEGATIVE one — lifecycle and health never collapse into one chip — and a negative
// claim needs a case that fails when it stops holding. The disjointness case below is
// that case: it fails the moment one axis borrows the other's vocabulary, which is
// the shape a collapse actually takes.

import type { RepoMountReadResponse } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  bindControlPosture,
  mountHealthReading,
  mountLifecycleReading,
  mountVcsReading,
} from "./mount-health.js";

function mount(overrides: Partial<RepoMountReadResponse> = {}): RepoMountReadResponse {
  return {
    id: "mount-1",
    sessionId: "session-1",
    nodeId: "node-1",
    localPath: "/Users/dev/code/thing/packages/inner",
    canonicalRoot: "/Users/dev/code/thing",
    vcsType: "git",
    state: "attached",
    health: { status: "healthy", checkedAt: "2026-01-01T09:05:01.000Z" },
    attachedAt: "2026-01-01T09:05:00.200Z",
    ...overrides,
  } as RepoMountReadResponse;
}

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

describe("mount-health — the two axes never collapse", () => {
  it("negative control: no lifecycle word is also a health word", () => {
    // The failure this guards is not hypothetical: `stale` was rejected as a health
    // status in `packages/contracts/src/repo.ts` precisely because it already names a
    // WORKSPACE state, and one vocabulary across two axes is how a reader stops being
    // able to tell a detached mount from an unreachable one.
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

describe("mount-health — the capability axis", () => {
  it("marks a plain-directory mount as reduced rather than broken", () => {
    const plain = mountVcsReading("none");
    expect(plain.tone).toBe("attention");
    // `Spec-009 §Acceptance Criteria`: such a workspace stays usable; the git-only
    // features are unavailable rather than pretended.
    expect(plain.sentence).toContain("stays usable");
    expect(mountVcsReading("git").tone).toBe("neutral");
  });
});

describe("mount-health — the bind-control posture", () => {
  it("offers controls on an attached, healthy mount", () => {
    expect(bindControlPosture(mount())).toStrictEqual({ offered: true });
  });

  it("withholds them on an unreachable mount, and says why", () => {
    const posture = bindControlPosture(
      mount({ health: { status: "unreachable", checkedAt: "2026-01-01T00:00:00Z" } }),
    );
    expect(posture.offered).toBe(false);
    expect(posture.offered === false && posture.withheldBecause).toContain("could not be probed");
  });

  it("withholds them on a detached mount, which is history rather than a failure", () => {
    const posture = bindControlPosture(mount({ state: "detached" }));
    expect(posture.offered).toBe(false);
    expect(posture.offered === false && posture.withheldBecause).toContain("mints a new mount");
  });

  it("negative control: lifecycle is checked before health, so a detached row never reads as unreachable", () => {
    // Both axes are failing here. A posture that reported the health reason would tell
    // a reader to go and fix a path, when the row's actual state is that its life is
    // over — the exact conflation `mount-health.ts` forbids.
    const posture = bindControlPosture(
      mount({
        state: "detached",
        health: { status: "unreachable", checkedAt: "2026-01-01T00:00:00Z" },
      }),
    );
    expect(posture.offered === false && posture.withheldBecause).not.toContain(
      "could not be probed",
    );
  });
});
