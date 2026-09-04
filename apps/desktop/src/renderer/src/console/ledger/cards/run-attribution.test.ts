import { describe, expect, it } from "vitest";

import { TIMELINE_RUN_ATTRIBUTION_PAYLOAD_KEYS } from "@ai-sidekicks/contracts";

import {
  attributedRunIdOf,
  RUN_ATTRIBUTION_BY_PAYLOAD_MEMBER,
  type RunAttributionRole,
  type RunNamingPayloadMember,
} from "./run-attribution.js";

const RUN_ONE = "019b793b-7b60-740e-8110-d1a4c1150111";
const RUN_TWO = "019b793b-7b60-740e-8120-d1a4c1150112";

/**
 * The compile-time control for the run-attribution table.
 *
 * The table's live effect is TOTALITY over every run-naming member of the payloads
 * the shell reads: one that grows such a member does not compile until the table
 * says which run it names. A table missing `parentRunId` is not total, and the
 * directive below asserts exactly that — loosen the table's type and the suppressed
 * error stops occurring, which makes the directive itself the error. The claim
 * cannot rot quietly in either direction.
 */
// @ts-expect-error — deliberately missing `parentRunId`; totality is the property.
const TABLE_THE_COMPILER_REJECTS: Readonly<Record<RunNamingPayloadMember, RunAttributionRole>> = {
  runId: "this-run",
  targetRunId: "this-run",
};

/** The decisions, read by a member the contract spells as a free-form string. */
const ROLE_BY_MEMBER: Readonly<Record<string, RunAttributionRole>> =
  RUN_ATTRIBUTION_BY_PAYLOAD_MEMBER;

describe("the run-attribution table — a compile gate, and a dormant runtime arm", () => {
  it("decides every key the contract lists, so the runtime filter removes nothing", () => {
    // The dormancy, checked rather than claimed. `parentRunId` is decided
    // `another-run` and the contract's list does not carry it, so the intersection
    // in `attributedRunIdOf` drops no member at today's contract; it is the
    // fail-closed arm for a list that grows a key nobody here has reviewed.
    for (const attributingKey of TIMELINE_RUN_ATTRIBUTION_PAYLOAD_KEYS) {
      expect(ROLE_BY_MEMBER[attributingKey], attributingKey).toBe("this-run");
    }
    const decidedElsewhere = Object.entries(RUN_ATTRIBUTION_BY_PAYLOAD_MEMBER)
      .filter(([, role]) => role === "another-run")
      .map(([member]) => member);
    expect(decidedElsewhere).toStrictEqual(["parentRunId"]);
    for (const member of decidedElsewhere) {
      expect(TIMELINE_RUN_ATTRIBUTION_PAYLOAD_KEYS, member).not.toContain(member);
    }
  });

  it("negative control: the table the compiler rejects is short at runtime too", () => {
    // The `@ts-expect-error` above is the real guard; this reads the same object
    // back so the suppressed line is not a comment nobody executes.
    expect(Object.keys(TABLE_THE_COMPILER_REJECTS)).not.toContain("parentRunId");
  });
});

describe("reading the run a payload names", () => {
  it("answers on either attributing spelling the contract lists", () => {
    // `runId` on every run-attributed family, `targetRunId` on interventions —
    // both decided `this-run`, so both answer.
    expect(attributedRunIdOf({ runId: RUN_ONE })).toBe(RUN_ONE);
    expect(attributedRunIdOf({ targetRunId: RUN_ONE })).toBe(RUN_ONE);
  });

  it("negative control: a member decided `another-run` names nothing here", () => {
    // A payload carrying ONLY the parent's spelling answers `undefined` rather
    // than the parent's id: filing a child's rows in its parent's chapter is the
    // defect this decision exists to refuse.
    expect(attributedRunIdOf({ parentRunId: RUN_ONE })).toBeUndefined();
    // And beside its own run, the row's own id wins.
    expect(attributedRunIdOf({ runId: RUN_TWO, parentRunId: RUN_ONE })).toBe(RUN_TWO);
  });

  it("refuses a value that is not a non-empty string, and an absent payload", () => {
    // The member is `unknown` by the store's projection contract, so the shape is
    // read rather than assumed: an empty string is not an id, and a number is not
    // one either.
    expect(attributedRunIdOf({ runId: "" })).toBeUndefined();
    expect(attributedRunIdOf({ runId: 7 })).toBeUndefined();
    expect(attributedRunIdOf(undefined)).toBeUndefined();
  });
});
