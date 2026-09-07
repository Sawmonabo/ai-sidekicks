// The five conjuncts, and the case they exist for.
//
// The rule is easy to state and easy to get exactly backwards on one arm: an origin
// marker the wire does not carry is NOT evidence that the session has an ordinary
// origin. Written with a boolean default, the absent case reads as "not a workflow
// session" and every workflow-started session lands on the front tier — the one place
// a person put the work they chose. So the absent case has a case of its own here,
// per exclusion, and the negative control is the boolean reading failing.

import { describe, expect, it } from "vitest";

import { autoPinDecision, type SessionOriginEvidence } from "./auto-pin.js";

/** A session this window started: every marker known, none of them an exclusion. */
const ORDINARY_ORIGIN: SessionOriginEvidence = {
  isDraftPlaceholder: true,
  arrivedByImport: false,
  openedForChildWork: false,
  startedByWorkflow: false,
};

describe("whether a first send pins the session", () => {
  it("pins when the setting is on and every conjunct holds", () => {
    expect(autoPinDecision({ isSettingEnabled: true, origin: ORDINARY_ORIGIN })).toStrictEqual({
      pins: true,
    });
  });

  it("does not pin while the setting is off, and says the setting is why", () => {
    expect(autoPinDecision({ isSettingEnabled: false, origin: ORDINARY_ORIGIN })).toStrictEqual({
      pins: false,
      because: "setting-off",
    });
  });

  it("does not pin a session that is past being a draft", () => {
    expect(
      autoPinDecision({
        isSettingEnabled: true,
        origin: { ...ORDINARY_ORIGIN, isDraftPlaceholder: false },
      }),
    ).toStrictEqual({ pins: false, because: "not-a-draft-placeholder" });
  });

  it("names each exclusion that fires", () => {
    const exclusions = [
      ["arrivedByImport", "arrived-by-import"],
      ["openedForChildWork", "opened-for-child-work"],
      ["startedByWorkflow", "started-by-workflow"],
    ] as const;

    for (const [marker, reason] of exclusions) {
      expect(
        autoPinDecision({
          isSettingEnabled: true,
          origin: { ...ORDINARY_ORIGIN, [marker]: true },
        }),
      ).toStrictEqual({ pins: false, because: reason });
    }
  });

  it("refuses to guess where a marker is absent — one case per marker", () => {
    // The whole reason the evidence is three-valued. Each marker is REMOVED rather
    // than set false, which is what a projection carrying no origin actually hands in.
    const markers = [
      "isDraftPlaceholder",
      "arrivedByImport",
      "openedForChildWork",
      "startedByWorkflow",
    ] as const;

    for (const marker of markers) {
      const origin: SessionOriginEvidence = { ...ORDINARY_ORIGIN };
      delete (origin as Record<string, unknown>)[marker];

      expect(autoPinDecision({ isSettingEnabled: true, origin })).toStrictEqual({
        pins: false,
        because: "origin-unreported",
      });
    }
  });

  it("would notice a rule that read an absent marker as false", () => {
    // The negative control for the case above, and the exact defect it exists to
    // catch: a projection that carries no origin at all is the common case, and a
    // rule defaulting to `false` pins every one of those sessions.
    expect(autoPinDecision({ isSettingEnabled: true, origin: {} }).pins).toBe(false);
  });
});
