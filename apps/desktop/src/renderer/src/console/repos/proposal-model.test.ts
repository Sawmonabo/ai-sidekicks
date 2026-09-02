// What the proposal model decides, held against the rules it was written from.
//
// The cases drive the real functions and the real tables rather than stand-ins, and
// each clean assertion is paired with the case that would pass if the model stopped
// doing the thing — a totality claim is only meaningful beside the key that must not
// be in the table, and "inert display data" is only meaningful beside the value that
// would have arrived as something other than a string.

import { describe, expect, it } from "vitest";

import {
  CHANGE_REQUEST_STATES,
  CHANGE_REQUEST_STATE_PRESENTATION,
  CHECK_STATUSES,
  CHECK_STATUS_PRESENTATION,
  MERGEABILITY_PRESENTATION,
  MERGEABILITY_READINGS,
  PROPOSAL_ACTIONS,
  PROPOSAL_ACTION_PRESENTATION,
  PROPOSAL_BLOB_UNRENDERABLE,
  PROPOSAL_STATES,
  REVIEW_DECISIONS,
  REVIEW_DECISION_PRESENTATION,
  checkRollup,
  proposalBlobRows,
  type ProposalCheck,
} from "./proposal-model.js";

describe("the closed vocabularies — declared once, and closed where the design closes them", () => {
  it("keeps every trichotomy at exactly three members", () => {
    expect(CHANGE_REQUEST_STATES).toHaveLength(3);
    expect(MERGEABILITY_READINGS).toHaveLength(3);
    expect(CHECK_STATUSES).toHaveLength(3);
    expect(REVIEW_DECISIONS).toHaveLength(3);
  });

  it("offers three modelled actions and no fourth", () => {
    expect(PROPOSAL_ACTIONS).toStrictEqual(["commit", "push", "prepare-proposal"]);
  });

  it("negative control: no vocabulary carries a member the design did not name", () => {
    // The counterpart to the counts above. A tuple can hold three of the wrong
    // members, so the members themselves are asserted.
    expect([...MERGEABILITY_READINGS]).toContain("unknown");
    expect([...CHECK_STATUSES]).not.toContain("unknown");
    expect([...CHANGE_REQUEST_STATES]).not.toContain("draft");
    expect([...PROPOSAL_STATES]).toStrictEqual(["draft", "ready"]);
  });

  it("gives every member of every vocabulary a presentation, and no key beyond them", () => {
    expect(Object.keys(CHANGE_REQUEST_STATE_PRESENTATION).sort()).toStrictEqual(
      [...CHANGE_REQUEST_STATES].sort(),
    );
    expect(Object.keys(MERGEABILITY_PRESENTATION).sort()).toStrictEqual(
      [...MERGEABILITY_READINGS].sort(),
    );
    expect(Object.keys(CHECK_STATUS_PRESENTATION).sort()).toStrictEqual([...CHECK_STATUSES].sort());
    expect(Object.keys(REVIEW_DECISION_PRESENTATION).sort()).toStrictEqual(
      [...REVIEW_DECISIONS].sort(),
    );
    expect(Object.keys(PROPOSAL_ACTION_PRESENTATION).sort()).toStrictEqual(
      [...PROPOSAL_ACTIONS].sort(),
    );
  });

  it("negative control: no review presentation stands in for the absence of a decision", () => {
    // Absence is an absence, never a fourth value. A table key for it would let the
    // console assert a verdict the host never gave.
    expect(Object.keys(REVIEW_DECISION_PRESENTATION)).not.toContain("none");
    expect(Object.keys(REVIEW_DECISION_PRESENTATION)).not.toContain("pending");
  });
});

describe("the `unknown` mergeability reading — a computation, never an error", () => {
  it("reads neutral and says the host is still computing", () => {
    const presentation = MERGEABILITY_PRESENTATION.unknown;
    expect(presentation.tone).toBe("neutral");
    expect(presentation.meaning).toContain("still computing");
    expect(presentation.meaning).toContain("not an error");
  });

  it("negative control: the conflicting reading is the one that asks for a person", () => {
    // Without this, `unknown`'s neutral tone could be the whole table being neutral.
    expect(MERGEABILITY_PRESENTATION.conflicting.tone).toBe("attention");
  });
});

describe("checkRollup — worst-first, and pending needs nobody", () => {
  const checks: readonly ProposalCheck[] = [
    { name: "lint", status: "success" },
    { name: "typecheck", status: "success" },
    { name: "test", status: "pending" },
  ];

  it("counts each status and totals the list", () => {
    const rollup = checkRollup(checks);
    expect(rollup.countByStatus).toStrictEqual({ pending: 1, success: 2, failure: 0 });
    expect(rollup.total).toBe(3);
  });

  it("stays neutral while a check is merely still running", () => {
    expect(checkRollup(checks).tone).toBe("neutral");
  });

  it("goes red on one failure among many passes", () => {
    const rollup = checkRollup([...checks, { name: "e2e", status: "failure" }]);
    expect(rollup.tone).toBe("failure");
    expect(rollup.countByStatus.failure).toBe(1);
  });

  it("negative control: an empty list is neutral and totals zero, never red", () => {
    // Without this, a rollup that defaulted to `failure` would look correct on every
    // failing case above and be wrong on every proposal with no checks configured.
    const rollup = checkRollup([]);
    expect(rollup.tone).toBe("neutral");
    expect(rollup.total).toBe(0);
    expect(rollup.countByStatus).toStrictEqual({ pending: 0, success: 0, failure: 0 });
  });
});

describe("proposalBlobRows — inert display data, never instructions", () => {
  it("renders every value as a string, whatever the producer sent", () => {
    const rows = proposalBlobRows({
      draft: false,
      labels: ["needs-review"],
      reviewers: { requested: 2 },
      title: "Wire the rate limiter",
    });
    for (const row of rows) {
      expect(typeof row.text).toBe("string");
    }
    expect(rows.map((row) => row.key)).toStrictEqual(["draft", "labels", "reviewers", "title"]);
  });

  it("passes a string value through verbatim rather than re-encoding it", () => {
    const rows = proposalBlobRows({ title: "Wire the rate limiter" });
    expect(rows[0]?.text).toBe("Wire the rate limiter");
  });

  it("sorts keys so two reads of one proposal draw the same rows", () => {
    const forward = proposalBlobRows({ alpha: 1, beta: 2 });
    const reversed = proposalBlobRows({ beta: 2, alpha: 1 });
    expect(forward).toStrictEqual(reversed);
  });

  it("states the fallback for a value that will not stringify", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(proposalBlobRows({ handler: () => undefined, ...cyclic })).toStrictEqual([
      { key: "handler", text: PROPOSAL_BLOB_UNRENDERABLE },
      { key: "self", text: PROPOSAL_BLOB_UNRENDERABLE },
    ]);
  });

  it("negative control: a key the console might act on arrives as text like every other", () => {
    // The whole point of the stringification. A caller cannot branch on a blob's
    // shape, so a key named for an act reaches the screen as the text of its value.
    const rows = proposalBlobRows({ action: { merge: true }, __html: "<script>" });
    expect(rows).toStrictEqual([
      { key: "__html", text: "<script>" },
      { key: "action", text: '{"merge":true}' },
    ]);
    for (const row of rows) {
      expect(typeof row.text).toBe("string");
    }
  });

  it("negative control: an absent blob is no rows rather than a row saying so", () => {
    expect(proposalBlobRows(undefined)).toStrictEqual([]);
  });
});
