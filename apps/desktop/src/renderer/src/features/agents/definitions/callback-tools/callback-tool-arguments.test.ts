// A registered tool's input schema arrives from the daemon; a member that is not the shape JSON
// Schema names yields no argument rather than a throw or a keyword listed as one.

import { describe, expect, it } from "vitest";

import { callbackToolArguments } from "./callback-tool-arguments.js";

describe("the arguments a registered tool takes", () => {
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
});
