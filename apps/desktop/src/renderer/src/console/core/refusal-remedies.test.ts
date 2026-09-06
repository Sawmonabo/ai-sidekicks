// The remedy table: what it answers for, and what it refuses to answer for.
//
// Two claims. Every entry is keyed on a code the corpus registers verbatim, which is
// the half that goes wrong silently — a table keyed on a code that reaches no wire
// answers `undefined` forever and nothing reports it. And an unlisted code answers
// `undefined` rather than a nearest neighbour, which is the half that goes wrong
// loudly, by telling a person to do something about a refusal it does not understand.

import { describe, expect, it } from "vitest";

import {
  REMEDIED_REFUSAL_CODES,
  refusalRemedyFor,
  type RefusalRendering,
} from "./refusal-remedies.js";

/**
 * The registered codes this table answers for.
 *
 * Hand-listed against the table, so a code added or removed is a deliberate edit
 * rather than a silent change to what a surface offers a person.
 */
const EXPECTED_CODES = [
  "approval.already_resolved",
  "intervention.idempotency_conflict",
  "run.not_found",
  "run.version_conflict",
  "session.goal_delivery_failed",
  "session.not_found",
];

describe("the remedy table is a closed set of registered wire codes", () => {
  it("answers for exactly the codes it declares", () => {
    expect([...REMEDIED_REFUSAL_CODES].sort()).toStrictEqual(EXPECTED_CODES);
  });

  it("keys every entry on a dotted wire code and never on console prose", () => {
    // The key is what a daemon sends. A key that is not shaped like a wire code is
    // a key nothing will ever match.
    for (const code of REMEDIED_REFUSAL_CODES) {
      expect(code).toMatch(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/);
    }
  });

  it("gives every entry a next move that names an act rather than restating the code", () => {
    for (const code of REMEDIED_REFUSAL_CODES) {
      const remedy = refusalRemedyFor(code);
      expect(remedy?.nextMove.length ?? 0).toBeGreaterThan(20);
      // Rule 9's asymmetry: the daemon says what happened and the console says what
      // to do, so the console's sentence never quotes the wire string back.
      expect(remedy?.nextMove).not.toContain(code);
    }
  });

  it("declares one of the three renderings for every entry", () => {
    const renderings: readonly RefusalRendering[] = ["inline", "card", "banner"];
    for (const code of REMEDIED_REFUSAL_CODES) {
      expect(renderings).toContain(refusalRemedyFor(code)?.rendering);
    }
  });
});

describe("what the table says about each answered code", () => {
  it("sends a vanished session to the banner, because it is not one control's news", () => {
    expect(refusalRemedyFor("session.not_found")?.rendering).toBe("banner");
  });

  it("settles the three whose act cannot be retried, and leaves the two that can", () => {
    // `settled` is what withdraws a control. A surface reading it wrongly either
    // leaves a button that can only be refused again, or takes away one that works.
    expect(refusalRemedyFor("intervention.idempotency_conflict")?.settled).toBe(true);
    expect(refusalRemedyFor("approval.already_resolved")?.settled).toBe(true);
    expect(refusalRemedyFor("run.not_found")?.settled).toBe(true);
    expect(refusalRemedyFor("run.version_conflict")?.settled).toBe(false);
    expect(refusalRemedyFor("session.goal_delivery_failed")?.settled).toBe(false);
  });

  it("names sending again for a stale comparand, since the answer carried a fresh one", () => {
    expect(refusalRemedyFor("run.version_conflict")?.nextMove).toContain("again");
  });
});

describe("an unlisted code gets no invented move", () => {
  it.each([
    ["a registered code with no console act", "driver.capability_unsupported"],
    ["a code from a namespace the table names", "session.archived"],
    ["a near miss on a code it does answer", "run.not_found "],
    ["the empty string", ""],
  ])("answers nothing for %s", (_name, code) => {
    expect(refusalRemedyFor(code)).toBeUndefined();
  });

  it("answers nothing for a name inherited from Object.prototype", () => {
    // The lookup is `Object.hasOwn`, not `in`. A `constructor` key reaching a
    // renderer as a remedy would render a function.
    expect(refusalRemedyFor("constructor")).toBeUndefined();
    expect(refusalRemedyFor("toString")).toBeUndefined();
  });
});
