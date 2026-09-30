// The negative case is the point: the schema reader throws, and the wrapper must answer with a
// reason instead. The positive cases show the verdict is real, so a wrapper that swallowed
// everything would not pass. The path encoding itself is tested in `schema-member-path.test.ts`.

import { describe, expect, it } from "vitest";

import { compileSchemaValidator } from "./json-schema-validator.js";
import { encodeMemberPointer } from "./schema-member-path.js";

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
    expect(report.issues.map((issue) => encodeMemberPointer(issue.memberPath)).sort()).toEqual([
      "/count",
      "/title",
    ]);
    expect(report.issues.every((issue) => issue.message.length > 0)).toBe(true);
  });

  it("reports a nested finding with the segment path the mapper addresses controls by", () => {
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

    expect(validator.check({ release: {} }).issues[0]?.memberPath).toEqual(["release", "tag"]);
  });

  it("keeps a dotted property name and an array position apart, which one string cannot", () => {
    // Joined with a dot, the property `items.0` and the first entry of `items` are one string, so
    // a control keyed on it would draw one member's finding under the other's control.
    const validator = compileSchemaValidator({
      type: "object",
      properties: {
        "items.0": { type: "number" },
        items: { type: "array", items: { type: "number" } },
      },
    });
    if (validator.status !== "compiled") {
      throw new Error("expected the schema to compile");
    }

    const report = validator.check({ "items.0": "no", items: ["no"] });

    expect(report.issues.map((issue) => encodeMemberPointer(issue.memberPath)).sort()).toEqual([
      "/items.0",
      "/items/0",
    ]);
    expect(report.issues.map((issue) => issue.memberPath).sort()).toEqual([
      ["items", 0],
      ["items.0"],
    ]);
  });

  it("carries the value the schema accepted, which is not the value it was handed", () => {
    // The reader supplies a member that declares a default, so `{}` is valid as something else;
    // a report saying only "valid" would describe a value its caller cannot send.
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
    // Without this, the case above would hold over a wrapper that always returned the defaults.
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
    // The reason travels so an author has something to change.
    expect(validator.detail).toContain("only the JSON itself is checked");
    expect(validator.detail.length).toBeGreaterThan("only the JSON itself is checked".length);
  });

  it("does not throw for any of the values a definition could carry in place of a schema", () => {
    for (const unreadable of [undefined, null, 7, "text", [], { type: "nonsense" }]) {
      expect(() => compileSchemaValidator(unreadable)).not.toThrow();
    }
  });
});

// The library words an unanswered required member as a wrong value ("Invalid option", "received
// undefined"). The wrapper says what the form needs instead, and only for a member the answer does
// not hold: a present, wrong member keeps the library's sentence.
describe("a required member nobody answered", () => {
  const DECISION_SCHEMA = {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["approve", "send-back"] },
      notes: { type: "string" },
    },
    required: ["decision", "notes"],
  } as const;

  function compiled(schema: unknown) {
    const validator = compileSchemaValidator(schema);
    if (validator.status !== "compiled") {
      throw new Error("expected the schema to compile");
    }
    return validator;
  }

  function messageAt(schema: unknown, answer: unknown, pointer: string): string {
    const report = compiled(schema).check(answer);
    const issue = report.issues.find((found) => encodeMemberPointer(found.memberPath) === pointer);
    if (issue === undefined) {
      throw new Error(`expected a finding at ${pointer}`);
    }
    return issue.message;
  }

  it("names the choice an unanswered enumeration requires, not an invalid option", () => {
    expect(messageAt(DECISION_SCHEMA, { notes: "ship it" }, "/decision")).toBe(
      'Not answered — one of "approve" or "send-back" is required.',
    );
  });

  it("says an unanswered scalar is required rather than received as undefined", () => {
    expect(messageAt(DECISION_SCHEMA, { decision: "approve" }, "/notes")).toBe(
      "Not answered — required.",
    );
  });

  it("lists three or more members with the last one joined by 'or'", () => {
    const schema = {
      type: "object",
      properties: { size: { type: "string", enum: ["small", "medium", "large"] } },
      required: ["size"],
    } as const;
    expect(messageAt(schema, {}, "/size")).toBe(
      'Not answered — one of "small", "medium" or "large" is required.',
    );
  });

  it("negative control: a member that is present and wrong keeps the library's sentence", () => {
    const message = messageAt(DECISION_SCHEMA, { decision: "maybe", notes: "" }, "/decision");
    expect(message).not.toMatch(/^Not answered/);
    expect(message).toContain("approve");
  });

  it("negative control: a finding about the whole answer is never rephrased as unanswered", () => {
    const report = compiled(DECISION_SCHEMA).check("not an object");
    expect(report.status).toBe("invalid");
    expect(report.issues.map((issue) => encodeMemberPointer(issue.memberPath))).toEqual([""]);
    expect(report.issues[0]?.message).not.toMatch(/^Not answered/);
  });
});
