// Which members one object schema's own constraints can require, asked of the walk directly.
//
// SEPARATE FROM THE MAPPER'S SUITE because the two claims differ. The mapper's cases are
// about which ARM a schema resolves to; these are about what the walk finds, which is the
// half that decides whether a real schema is drawn at all — an arm this walk never
// descends into is a member the form silently fails to offer, and no plan-level case
// distinguishes that from a schema that named nothing.

import { describe, expect, it } from "vitest";

import { membersConstraintsCanRequire } from "./schema-constraints.js";

/** What the walk found, ordered so a case can also pin which name is met first. */
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
    // Both halves matter. `then` states the requirement outright, and an `if` naming a
    // member no control draws decides its own branch before anybody can touch the form.
    expect(
      requirable({
        if: { required: ["urgent"] },
        then: { required: ["justification"] },
        else: { required: ["scheduledFor"] },
      }),
    ).toEqual(["urgent", "justification", "scheduledFor"]);
  });

  it("finds what a dependency requires and not the member that triggers it", () => {
    // The trigger's presence is what fires the dependency, so a trigger nothing draws can
    // never be present and the dependency is inert; what it would then require is not.
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
    // A `required` under `not` names a member that must NOT be there, so no control is
    // owed for it and collecting the name would send a schema to the raw editor for
    // asking that something be left out.
    expect(requirable({ not: { required: ["banned"] } })).toEqual([]);
  });

  it("does not descend into a nested object's own members", () => {
    // What a group requires of its members is answered where that group is planned, by
    // this same walk called on that group; descending here would collect a child's names
    // into a parent whose controls never draw them.
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
    // The walk descends through arms a wire value supplied, so a value that reaches
    // itself is a probe that would otherwise never return.
    const selfReaching: Record<string, unknown> = { required: ["approver"] };
    selfReaching["allOf"] = [selfReaching];

    expect(requirable(selfReaching)).toEqual(["approver"]);
  });
});
