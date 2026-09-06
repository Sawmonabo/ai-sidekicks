// What the two untyped readers answer for every shape a caller can hand them.
//
// The module exists because the fixture holds values the type system never saw — a
// scenario's `result` and the request a computed reply is given — so the arms that
// matter are the ones no caller writes on purpose: an array, a `null`, a primitive, a
// member that is present but is not a string. Each of those has to answer `undefined`
// rather than throw or leak, because every reader has exactly one arm for "it asked
// for an identifier and did not get one".
//
// THE ARRAY CASE IS A CONTROL AND NOT A CURIOSITY. The container check was a private
// `typeof value === "object" && value !== null` in each caller before the hoist onto
// `core`'s `isWireRecord`, and that predicate is TRUE for an array — so an array used
// to answer through the index for the names an array carries. The pair below drives
// the narrowing on exactly those names, which is the only place the two readings can
// be told apart at all.

import { describe, expect, it } from "vitest";

import { readUnknownMember, readUnknownStringMember } from "./unknown-member.js";

describe("readUnknownMember — one member off a value nothing typed", () => {
  it("reads the member when the value is a record", () => {
    expect(readUnknownMember({ session: { state: "live" } }, "session")).toStrictEqual({
      state: "live",
    });
  });

  it("answers undefined for a member the record does not carry", () => {
    expect(readUnknownMember({ session: {} }, "workflowRunId")).toBeUndefined();
  });

  it("answers undefined for an array, on every name an array does carry", () => {
    // The superseded container check answered `2` and `"first"` here. Both are read
    // through an index rather than off a record, which is the reading the shared
    // predicate refuses — so the narrowing is visible on these two names alone.
    expect(readUnknownMember(["first", "second"], "length")).toBeUndefined();
    expect(readUnknownMember(["first", "second"], "0")).toBeUndefined();
  });

  it("answers undefined for null, which is an object to `typeof` and not a record", () => {
    expect(readUnknownMember(null, "session")).toBeUndefined();
  });

  it("answers undefined for a primitive and for an absent value", () => {
    expect(readUnknownMember("session-a", "length")).toBeUndefined();
    expect(readUnknownMember(7, "toFixed")).toBeUndefined();
    expect(readUnknownMember(undefined, "session")).toBeUndefined();
  });
});

describe("readUnknownStringMember — the same reading, narrowed to a string", () => {
  it("reads a string member", () => {
    expect(readUnknownStringMember({ workflowRunId: "run-a" }, "workflowRunId")).toBe("run-a");
  });

  it("answers undefined for a member that is present and is not a string", () => {
    // "not an object" and "that member is not a string" collapse deliberately: the
    // caller asked for an identifier and did not get one, and a second discriminator
    // would be the same question asked twice.
    expect(readUnknownStringMember({ workflowRunId: 7 }, "workflowRunId")).toBeUndefined();
    expect(readUnknownStringMember({ workflowRunId: null }, "workflowRunId")).toBeUndefined();
    expect(readUnknownStringMember({ workflowRunId: ["run-a"] }, "workflowRunId")).toBeUndefined();
  });

  it("answers undefined for every container the member read already refused", () => {
    expect(readUnknownStringMember(["run-a"], "0")).toBeUndefined();
    expect(readUnknownStringMember(null, "workflowRunId")).toBeUndefined();
    expect(readUnknownStringMember("run-a", "workflowRunId")).toBeUndefined();
  });
});
