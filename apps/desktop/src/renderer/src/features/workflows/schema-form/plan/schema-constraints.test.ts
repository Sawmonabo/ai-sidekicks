// The constraint walk asked directly: an arm it never descends into is a member the form silently
// fails to offer, which no plan-level case distinguishes from a schema that named nothing.

import { describe, expect, it } from "vitest";

import { membersConstraintsCanRequire } from "./schema-constraints.js";

function requirable(schema: Readonly<Record<string, unknown>>): readonly string[] {
  return membersConstraintsCanRequire(schema);
}

describe("the members one schema's own constraints can require", () => {
  it("finds the schema's own required members", () => {
    expect(requirable({ type: "object", required: ["approver", "scope"] })).toEqual([
      "approver",
      "scope",
    ]);
  });

  it("finds a member required by any arm of a branching combinator", () => {
    for (const keyword of ["oneOf", "anyOf", "allOf"]) {
      expect(requirable({ [keyword]: [{ required: ["email"] }, { required: ["phone"] }] })).toEqual(
        ["email", "phone"],
      );
    }
  });

  it("finds a member required through a nested combinator", () => {
    expect(
      requirable({
        anyOf: [{ allOf: [{ oneOf: [{ required: ["deep"] }] }] }],
      }),
    ).toEqual(["deep"]);
  });

  it("finds a member required by a conditional branch and by the condition itself", () => {
    // `then` states a requirement outright; an `if` naming an undrawn member decides its branch.
    expect(
      requirable({
        if: { required: ["urgent"] },
        then: { required: ["justification"] },
        else: { required: ["scheduledFor"] },
      }),
    ).toEqual(["urgent", "justification", "scheduledFor"]);
  });

  it("finds what a dependency requires and not the member that triggers it", () => {
    // A trigger nothing draws can never be present, so the dependency is inert.
    expect(requirable({ dependentRequired: { card: ["billingAddress"] } })).toEqual([
      "billingAddress",
    ]);
  });

  it("walks a dependent subschema the same way it walks a combinator arm", () => {
    expect(requirable({ dependentSchemas: { card: { required: ["billingAddress"] } } })).toEqual([
      "billingAddress",
    ]);
  });

  it("does not collect a member a negation asks to be absent", () => {
    // A `required` under `not` names a member that must be absent, so no control is owed.
    expect(requirable({ not: { required: ["banned"] } })).toEqual([]);
  });

  it("does not descend into a nested object's own members", () => {
    // Each group is asked by this same walk where it is planned; descending would collect names
    // the parent never draws.
    expect(requirable({ properties: { release: { required: ["tag"] } } })).toEqual([]);
  });

  it("reads nothing out of members that are not the shape they claim", () => {
    expect(
      requirable({
        required: "approver",
        oneOf: { required: ["email"] },
        dependentRequired: { card: "billingAddress" },
        then: "not a schema",
      }),
    ).toEqual([]);
  });

  it("names each member once however many arms require it", () => {
    expect(
      requirable({
        required: ["approver"],
        anyOf: [{ required: ["approver"] }, { required: ["approver", "deputy"] }],
      }),
    ).toEqual(["approver", "deputy"]);
  });

  it("terminates over a schema that reaches itself", () => {
    // The walk descends through wire-supplied arms, so a self-reaching value would never return.
    const selfReaching: Record<string, unknown> = { required: ["approver"] };
    selfReaching["allOf"] = [selfReaching];

    expect(requirable(selfReaching)).toEqual(["approver"]);
  });
});
