// What the disclosure panel is allowed to call an argument.
//
// The defect this reader exists for is one line: the panel listed
// `Object.keys(inputSchema)`, which for a JSON Schema is `type`, `properties`,
// `required`, `additionalProperties` — the schema's own KEYWORDS. So the shipped
// `workflow_start` entry named neither `definitionName` nor `scope`, and the panel
// answered "what does this tool take" with a list of words that are not arguments at
// all. The first case below is that entry, read through this module rather than
// restated: the registry's shape is the thing being asserted about.

import { describe, expect, it } from "vitest";

import { callbackToolArguments } from "./callback-tool-arguments.js";

/** The shipped registry's one entry, in the shape `api-payload-contracts.md` fixes. */
const WORKFLOW_START_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    definitionName: { type: "string" },
    scope: { enum: ["session", "project", "shared"] },
  },
  required: ["definitionName"],
  additionalProperties: false,
};

describe("the arguments a registered tool takes", () => {
  it("names the schema's properties and never its keywords", () => {
    expect(callbackToolArguments(WORKFLOW_START_INPUT_SCHEMA)).toStrictEqual([
      { name: "definitionName", isRequired: true },
      { name: "scope", isRequired: false },
    ]);
  });

  it("negative control: no keyword of the schema is offered as an argument", () => {
    // Without this the case above would pass over a reader that listed the keywords
    // AND the properties, which is the defect plus a superset.
    const names = callbackToolArguments(WORKFLOW_START_INPUT_SCHEMA).map(
      (argument) => argument.name,
    );
    expect(names).not.toContain("properties");
    expect(names).not.toContain("required");
    expect(names).not.toContain("additionalProperties");
    expect(names).not.toContain("type");
  });

  it("puts the required arguments first, in the schema's own declaration order", () => {
    const arguments_ = callbackToolArguments({
      type: "object",
      properties: {
        optionalFirst: { type: "string" },
        requiredSecond: { type: "string" },
        requiredThird: { type: "string" },
      },
      required: ["requiredThird", "requiredSecond"],
    });
    expect(arguments_).toStrictEqual([
      { name: "requiredSecond", isRequired: true },
      { name: "requiredThird", isRequired: true },
      { name: "optionalFirst", isRequired: false },
    ]);
  });

  it("names an argument the schema requires but does not describe", () => {
    // JSON Schema admits it, and dropping the row would report a tool as taking
    // fewer arguments than it does.
    expect(
      callbackToolArguments({ type: "object", properties: {}, required: ["undescribed"] }),
    ).toStrictEqual([{ name: "undescribed", isRequired: true }]);
  });

  it("answers with nothing where the schema describes no properties at all", () => {
    expect(callbackToolArguments({ type: "object" })).toStrictEqual([]);
  });

  it("answers with nothing where the members are not the shapes JSON Schema names", () => {
    // The schema is daemon-constructed, but this reader is still the boundary: a
    // `properties` that is an array, a null, or a string names no argument, and a
    // `required` that is not a list of strings marks none.
    expect(callbackToolArguments({ properties: ["definitionName"] })).toStrictEqual([]);
    expect(callbackToolArguments({ properties: null })).toStrictEqual([]);
    expect(
      callbackToolArguments({ properties: { definitionName: {} }, required: "definitionName" }),
    ).toStrictEqual([{ name: "definitionName", isRequired: false }]);
    expect(
      callbackToolArguments({ properties: { definitionName: {} }, required: [7] }),
    ).toStrictEqual([{ name: "definitionName", isRequired: false }]);
  });

  it("reads only the schema's own members, never an inherited one", () => {
    // `properties` is untrusted at the type level and reached by key, so a member
    // arriving through the prototype chain would otherwise be listed as an argument.
    const inherited: Record<string, unknown> = Object.create({ properties: { ghost: {} } });
    expect(callbackToolArguments(inherited)).toStrictEqual([]);
  });
});
