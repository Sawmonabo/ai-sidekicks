// What the disclosure panel may call an argument: the schema's properties, never its keywords
// (`Object.keys(inputSchema)` would list `type`, `properties`, `required` and
// `additionalProperties`). The first case reads the shipped `workflow_run` entry.

import { describe, expect, it } from "vitest";

import { callbackToolArguments } from "./callback-tool-arguments.js";

/** The shipped `workflow_run` input schema. */
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
    // Otherwise the case above would pass for a reader that listed the keywords as well as the
    // properties.
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
    // JSON Schema admits it, and dropping the row would report the tool as taking fewer
    // arguments than it does.
    expect(
      callbackToolArguments({ type: "object", properties: {}, required: ["undescribed"] }),
    ).toStrictEqual([{ name: "undescribed", isRequired: true }]);
  });

  it("answers with nothing where the schema describes no properties at all", () => {
    expect(callbackToolArguments({ type: "object" })).toStrictEqual([]);
  });

  it("answers with nothing where the members are not the shapes JSON Schema names", () => {
    // The schema is daemon-constructed, but this reader is still the boundary: a non-object
    // `properties` names no argument and a `required` that is not a list of strings marks none.
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
    // `properties` is reached by key, so a member arriving through the prototype chain would
    // otherwise be listed.
    const inherited: Record<string, unknown> = Object.create({ properties: { ghost: {} } });
    expect(callbackToolArguments(inherited)).toStrictEqual([]);
  });
});
