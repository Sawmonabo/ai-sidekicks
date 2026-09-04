// The four closed sets, and the one property that makes them worth closing.
//
// Each table is asserted TOTAL over its own tuple rather than against a hand-typed
// list, so widening a tuple without widening its tables fails here instead of
// rendering a nameless token in whichever deck first opened the pane. The
// classifiers are asserted fail-closed, because "this build does not know that
// value" and "that value is a member" are the two answers that must not merge.

import { describe, expect, it } from "vitest";

import {
  APPROVAL_CATEGORIES,
  APPROVAL_DECISIONS,
  APPROVAL_STATES,
  CATEGORY_PHRASE,
  INVALIDATION_TRIGGERS,
  REMEMBERED_SCOPE_KINDS,
  SCOPE_KIND_PHRASE,
  STATE_PHRASE,
  STATE_TONE,
  TRIGGER_PHRASE,
  asApprovalCategory,
  asApprovalState,
  asInvalidationTrigger,
} from "./approval-vocabulary.js";

describe("the closed sets are the sets the design fixes", () => {
  it("carries the nine canonical categories, verbatim", () => {
    expect([...APPROVAL_CATEGORIES]).toStrictEqual([
      "tool_execution",
      "file_write",
      "network_access",
      "destructive_git",
      "user_input",
      "plan_approval",
      "mcp_elicitation",
      "gate",
      "human_phase_contribution",
    ]);
  });

  it("carries five states and exactly two decisions", () => {
    expect(APPROVAL_STATES).toHaveLength(5);
    expect([...APPROVAL_DECISIONS]).toStrictEqual(["approved", "rejected"]);
    // The decision set is what makes an approve-with-amendment control
    // unrepresentable, so a third member would have to be a deliberate edit here.
    expect(APPROVAL_DECISIONS).toHaveLength(2);
  });

  it("carries two scope kinds and four invalidation triggers", () => {
    expect([...REMEMBERED_SCOPE_KINDS]).toStrictEqual(["run", "session"]);
    expect([...INVALIDATION_TRIGGERS]).toStrictEqual([
      "explicit",
      "membership_change",
      "node_trust_change",
      "session_end",
    ]);
  });
});

describe("every table is total over its own set", () => {
  it("names every category, state, tone, trigger, and scope kind", () => {
    for (const category of APPROVAL_CATEGORIES) {
      expect(CATEGORY_PHRASE[category]).not.toBe("");
    }
    for (const state of APPROVAL_STATES) {
      expect(STATE_PHRASE[state]).not.toBe("");
      expect(STATE_TONE[state]).toBeTypeOf("string");
    }
    for (const trigger of INVALIDATION_TRIGGERS) {
      expect(TRIGGER_PHRASE[trigger]).not.toBe("");
    }
    for (const kind of REMEMBERED_SCOPE_KINDS) {
      expect(SCOPE_KIND_PHRASE[kind]).not.toBe("");
    }
  });

  it("spends amber on `pending` alone, so a needed person is the only amber", () => {
    const amberStates = APPROVAL_STATES.filter((state) => STATE_TONE[state] === "attention");
    expect(amberStates).toStrictEqual(["pending"]);
  });

  it("negative control: a name outside a set has no entry", () => {
    // Without this the totality cases above would also pass over a lookup that
    // answered a phrase for every string, which is the failure they exist to catch.
    const phraseByCategory: Readonly<Record<string, string | undefined>> = CATEGORY_PHRASE;
    expect(phraseByCategory["tool_exec"]).toBeUndefined();
  });
});

describe("the classifiers fail closed", () => {
  it("answers a member for a member", () => {
    expect(asApprovalCategory("destructive_git")).toBe("destructive_git");
    expect(asApprovalState("canceled")).toBe("canceled");
    expect(asInvalidationTrigger("node_trust_change")).toBe("node_trust_change");
  });

  it("answers undefined rather than asserting an unknown value into a member", () => {
    expect(asApprovalCategory("sudo_everything")).toBeUndefined();
    expect(asApprovalState("half-approved")).toBeUndefined();
    expect(asInvalidationTrigger("vibes")).toBeUndefined();
  });

  it("negative control: prototype keys are not members", () => {
    // A lookup written as a bare property read would answer a function here and
    // classify `toString` as a category, which is exactly the silent widening a
    // fail-closed classifier exists to prevent.
    expect(asApprovalCategory("toString")).toBeUndefined();
    expect(asApprovalState("constructor")).toBeUndefined();
  });
});
