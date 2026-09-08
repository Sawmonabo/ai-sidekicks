// The wrapper earns its name on one case: the schema reader THROWS, and a form that let
// it would take the pane down over a definition somebody authored.
//
// So the negative case is the point of this file. The positive ones establish that the
// verdict is real — that an answer is checked, that the issues carry the console's own
// dotted member path, and that a valid answer comes back clean — because a wrapper that
// swallowed everything would pass the throwing case and be useless.
//
// AND ONE PAIR IS ABOUT WHAT A CLEAN VERDICT IS ABOUT. Checking reads an answer rather
// than inspecting it, so a schema with a `default` accepts `{}` and accepts it as
// something else; the clean arm therefore carries the value it accepted, and the pair
// below pins both halves — that a supplied member arrives, and that an answered one is
// not overwritten by the schema's own value for it.

import { describe, expect, it } from "vitest";

import { compileSchemaValidator } from "./json-schema-check.js";

/** A schema over one required string and one optional number. */
const TWO_MEMBER_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" }, count: { type: "number" } },
  required: ["title"],
} as const;

describe("the schema validator wrapper", () => {
  it("compiles an ordinary object schema and passes an answer that satisfies it", () => {
    const validator = compileSchemaValidator(TWO_MEMBER_SCHEMA);

    expect(validator.status).toBe("compiled");
    if (validator.status !== "compiled") {
      return;
    }
    expect(validator.check({ title: "Ship it", count: 2 })).toEqual({
      status: "valid",
      issues: [],
      acceptedValue: { title: "Ship it", count: 2 },
    });
  });

  it("reports each finding against the member path the form addresses controls by", () => {
    const validator = compileSchemaValidator(TWO_MEMBER_SCHEMA);
    if (validator.status !== "compiled") {
      throw new Error("expected the schema to compile");
    }

    const report = validator.check({ count: "not a number" });

    expect(report.status).toBe("invalid");
    expect(report.issues.map((issue) => issue.memberPath).sort()).toEqual(["count", "title"]);
    // The library's own sentence, carried rather than paraphrased.
    expect(report.issues.every((issue) => issue.message.length > 0)).toBe(true);
  });

  it("reports a nested finding with the dotted path the mapper composes", () => {
    const validator = compileSchemaValidator({
      type: "object",
      properties: {
        release: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] },
      },
      required: ["release"],
    });
    if (validator.status !== "compiled") {
      throw new Error("expected the schema to compile");
    }

    expect(validator.check({ release: {} }).issues[0]?.memberPath).toBe("release.tag");
  });

  it("carries the value the schema accepted, which is not the value it was handed", () => {
    // The whole reason the clean arm carries a value: the reader SUPPLIES a member that
    // declares a default, so `{}` is valid and is valid as something else. A report that
    // said only "valid" would be a verdict on a value its caller had no way to send.
    const validator = compileSchemaValidator({
      type: "object",
      properties: { approver: { type: "string", default: "ada" }, note: { type: "string" } },
      required: ["approver"],
    });
    if (validator.status !== "compiled") {
      throw new Error("expected the schema to compile");
    }

    const report = validator.check({});

    expect(report.status).toBe("valid");
    if (report.status !== "valid") {
      return;
    }
    expect(report.acceptedValue).toEqual({ approver: "ada" });
  });

  it("negative control: an answer the schema changes nothing about comes back unchanged", () => {
    // Without this, the case above would hold over a wrapper that returned the schema's
    // defaults for every answer, ignoring what it was given.
    const validator = compileSchemaValidator({
      type: "object",
      properties: { approver: { type: "string", default: "ada" } },
      required: ["approver"],
    });
    if (validator.status !== "compiled") {
      throw new Error("expected the schema to compile");
    }

    const report = validator.check({ approver: "bela" });

    expect(report.status === "valid" ? report.acceptedValue : undefined).toEqual({
      approver: "bela",
    });
  });

  it("answers with a reason instead of throwing when the reader cannot read the schema", () => {
    const validator = compileSchemaValidator({
      type: "object",
      properties: { linked: { $ref: "#/definitions/missing" } },
    });

    expect(validator.status).toBe("uncompilable");
    if (validator.status !== "uncompilable") {
      return;
    }
    // The reason travels, because a surface that said only "could not check" leaves an
    // author with nothing to change.
    expect(validator.detail).toContain("only the JSON itself is checked");
    expect(validator.detail.length).toBeGreaterThan("only the JSON itself is checked".length);
  });

  it("does not throw for any of the values a definition could carry in place of a schema", () => {
    for (const unreadable of [undefined, null, 7, "text", [], { type: "nonsense" }]) {
      expect(() => compileSchemaValidator(unreadable)).not.toThrow();
    }
  });
});
