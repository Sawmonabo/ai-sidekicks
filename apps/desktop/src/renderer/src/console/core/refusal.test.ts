// The refusal shape, driven rather than described.
//
// `ConsoleRefusal` exists so that five producers stop minting five vocabularies for
// three renderers, and the whole value of that is structural: the shape has to be
// recognisable from OUTSIDE the module that built it, because a refusal crossing a
// family boundary arrives as an `unknown` result or a caught error. So the cases
// below are about recognition and about what survives the trip — the guard, the
// message an error carries, and the refusal an error still holds after the throw.

import { describe, expect, it } from "vitest";
import { ConsoleRefusalError, isConsoleRefusal, refuse } from "./refusal.js";

describe("refuse — one builder, one field order", () => {
  it("carries the three fields the renderers read", () => {
    const refusal = refuse("persistence", "value-too-large", "The layout snapshot is too big.");
    expect(refusal).toStrictEqual({
      code: "value-too-large",
      detail: "The layout snapshot is too big.",
      origin: "persistence",
    });
  });

  it("names the origin from the argument rather than defaulting one", () => {
    // The whole point of `origin` is that a refusal surfacing three layers up still
    // names its author; a builder that filled in a default would make every refusal
    // claim the same one.
    expect(refuse("keybindings", "unparseable", "detail").origin).toBe("keybindings");
    expect(refuse("growth-port", "unparseable", "detail").origin).toBe("growth-port");
  });
});

describe("ConsoleRefusalError — a refusal that had to travel as an exception", () => {
  const refusal = refuse("growth-port", "not-registered", "No wire serves this operation yet.");

  it("is an Error, so a boundary that catches Errors catches it", () => {
    expect(new ConsoleRefusalError(refusal)).toBeInstanceOf(Error);
  });

  it("keeps the refusal intact for the catch site to render", () => {
    const error = new ConsoleRefusalError(refusal);
    expect(error.refusal).toStrictEqual(refusal);
    expect(isConsoleRefusal(error.refusal)).toBe(true);
  });

  it("puts origin, code, and detail in the message, in that order", () => {
    // A stack trace is where an error is read when nothing rendered it, so the
    // message has to carry the same three facts the card would have shown.
    expect(new ConsoleRefusalError(refusal).message).toBe(
      "growth-port: not-registered: No wire serves this operation yet.",
    );
  });

  it("names itself, so a test asserts on the class rather than on message text", () => {
    expect(new ConsoleRefusalError(refusal).name).toBe("ConsoleRefusalError");
  });

  it("passes a cause through to the platform error", () => {
    const underlying = new TypeError("indexedDB is not defined");
    expect(new ConsoleRefusalError(refusal, { cause: underlying }).cause).toBe(underlying);
  });
});

describe("isConsoleRefusal — recognition across a family boundary", () => {
  it("accepts what refuse built", () => {
    expect(isConsoleRefusal(refuse("persistence", "quota-exhausted", "detail"))).toBe(true);
  });

  it("accepts a structurally identical literal, because the shape is the contract", () => {
    // Deliberate: a producer that widens its own closed union into this shape at its
    // boundary has not called `refuse`, and its result is still a refusal.
    expect(isConsoleRefusal({ code: "c", detail: "d", origin: "o" })).toBe(true);
  });

  it("negative control: rejects the values a constant-true guard would accept", () => {
    // Without these, a guard whose body was `return true` would pass every case
    // above and the two positive assertions would prove nothing.
    expect(isConsoleRefusal(null)).toBe(false);
    expect(isConsoleRefusal(undefined)).toBe(false);
    expect(isConsoleRefusal("growth-port: not-registered: detail")).toBe(false);
    expect(isConsoleRefusal(42)).toBe(false);
    expect(isConsoleRefusal({})).toBe(false);
    expect(isConsoleRefusal([])).toBe(false);
  });

  it("rejects a partial refusal rather than rendering a card with a blank author", () => {
    expect(isConsoleRefusal({ code: "c", detail: "d" })).toBe(false);
    expect(isConsoleRefusal({ code: "c", origin: "o" })).toBe(false);
    expect(isConsoleRefusal({ detail: "d", origin: "o" })).toBe(false);
  });

  it("rejects a refusal whose fields are the right names and the wrong types", () => {
    // The renderers put `code` in mono verbatim; a number there would render, and a
    // nested object would render as "[object Object]" in the one field a person is
    // meant to be able to paste into an issue.
    expect(isConsoleRefusal({ code: 7, detail: "d", origin: "o" })).toBe(false);
    expect(isConsoleRefusal({ code: "c", detail: { text: "d" }, origin: "o" })).toBe(false);
    expect(isConsoleRefusal({ code: "c", detail: "d", origin: null })).toBe(false);
  });
});
