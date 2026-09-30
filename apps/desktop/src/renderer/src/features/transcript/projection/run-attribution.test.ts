import { describe, expect, it } from "vitest";

import { TIMELINE_RUN_ATTRIBUTION_PAYLOAD_KEYS } from "@ai-sidekicks/contracts";

import {
  attributedRunIdOf,
  RUN_ATTRIBUTION_BY_PAYLOAD_KEY,
  type RunAttributionRole,
} from "./run-attribution.js";

const RUN_ONE = "019b793b-7b60-740e-8110-d1a4c1150111";
const RUN_TWO = "019b793b-7b60-740e-8120-d1a4c1150112";

/** The decisions, read by a member the contract spells as a free-form string. */
const ROLE_BY_MEMBER: Readonly<Record<string, RunAttributionRole>> = RUN_ATTRIBUTION_BY_PAYLOAD_KEY;

describe("the run-attribution table", () => {
  it("decides every key the contract lists, so the runtime filter removes nothing", () => {
    // Checked, not claimed: every member decided `another-run` is absent from the contract's
    // list, so the filter drops nothing today; it fails closed for a key nobody here reviewed.
    for (const attributingKey of TIMELINE_RUN_ATTRIBUTION_PAYLOAD_KEYS) {
      expect(ROLE_BY_MEMBER[attributingKey], attributingKey).toBe("this-run");
    }
    const decidedElsewhere = Object.entries(RUN_ATTRIBUTION_BY_PAYLOAD_KEY)
      .filter(([, role]) => role === "another-run")
      .map(([member]) => member);
    for (const member of decidedElsewhere) {
      expect(TIMELINE_RUN_ATTRIBUTION_PAYLOAD_KEYS, member).not.toContain(member);
    }
  });
});

describe("reading the run a payload names", () => {
  it("answers on either attributing spelling the contract lists", () => {
    // `runId` on every run-attributed event kind, `targetRunId` on interventions —
    // both decided `this-run`, so both answer.
    expect(attributedRunIdOf({ runId: RUN_ONE })).toBe(RUN_ONE);
    expect(attributedRunIdOf({ targetRunId: RUN_ONE })).toBe(RUN_ONE);
  });

  it("a member decided `another-run` names nothing here", () => {
    // A payload carrying ONLY the parent's spelling answers `undefined` rather
    // than the parent's id: filing a child's rows in its parent's run group is the
    // defect this decision exists to refuse.
    expect(attributedRunIdOf({ parentRunId: RUN_ONE })).toBeUndefined();
    // And beside its own run, the row's own id wins.
    expect(attributedRunIdOf({ runId: RUN_TWO, parentRunId: RUN_ONE })).toBe(RUN_TWO);
  });

  it("refuses a value that is not a non-empty string, and an absent payload", () => {
    // The member is `unknown`, so the shape is read: an empty string and a number are not ids.
    expect(attributedRunIdOf({ runId: "" })).toBeUndefined();
    expect(attributedRunIdOf({ runId: 7 })).toBeUndefined();
    expect(attributedRunIdOf(undefined)).toBeUndefined();
  });
});
