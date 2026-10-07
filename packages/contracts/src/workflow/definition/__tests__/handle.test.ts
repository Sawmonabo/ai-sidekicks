// A stored edge names its handles by string, and a document must always open: the parse never
// throws, and it keeps whether the string named a declared type so the save can refuse it.
import { describe, expect, it } from "vitest";

import { parseWorkflowHandle } from "../handle.js";

describe("parseWorkflowHandle", () => {
  it("reads the side, type and index of a declared handle", () => {
    expect(parseWorkflowHandle("inputs/tool/0")).toEqual({
      mode: "inputs",
      type: "tool",
      index: 0,
      isTypeKnown: true,
    });
    expect(parseWorkflowHandle("outputs/main/12")).toEqual({
      mode: "outputs",
      type: "main",
      index: 12,
      isTypeKnown: true,
    });
  });

  it("reads an unknown type as main on its own side and index, marked unknown", () => {
    expect(parseWorkflowHandle("inputs/error/2")).toEqual({
      mode: "inputs",
      type: "main",
      index: 2,
      isTypeKnown: false,
    });
  });

  it("falls back to the first main output for a string with no handle shape", () => {
    for (const id of [
      "",
      "outputs/main",
      "outputs/main/0/1",
      "sideways/main/0",
      "outputs/main/-1",
      "outputs/main/1.5",
      "outputs/main/01",
      "outputs/main/99999999999999999999",
      "outputs//0",
    ]) {
      expect(parseWorkflowHandle(id), id).toEqual({
        mode: "outputs",
        type: "main",
        index: 0,
        isTypeKnown: false,
      });
    }
  });
});
