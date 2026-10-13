import { describe, expect, it } from "vitest";

import { mayDefineFootnote, mayDefineLink } from "./settled-block.js";

describe("definition lines", () => {
  it.each([
    ["a label on one line", "[a]: /url", true],
    ["a label running over a line ending", "text\n[a\nb]: /url", true],
    ["a label a blank line cuts", "[a\n \nb]: /url", false],
    ["an escaped bracket inside the label", "[a\\]b]: /url", true],
    ["a label whose only bracket is escaped", "[a\\]: /url", false],
    ["a backslash before a line ending", "[a\\\nb]: /url", false],
    ["a label behind quote and list markers", "> - 1. [a]: /url", true],
    ["a list marker with no space after it", "-[a]: /url", false],
    ["a list number of ten digits", "1234567890. [a]: /url", false],
    ["a label after a carriage return", "text\r[a]: /url", true],
    ["a later line after a label that closed early", "[a\n[b]\n[c]: /url", true],
    ["lines opening on brackets that never close", "[a\n[b\n[c", false],
  ])("finds a link definition line in %s", (_case, text, isFound) => {
    expect(mayDefineLink(text)).toBe(isFound);
  });

  it.each([
    ["a footnote's label", "[^1]: note", true],
    ["a footnote's label running over a line ending", "[^1\n2]: note", false],
    ["a link's label", "[a]: /url", false],
  ])("finds a footnote definition line in %s", (_case, text, isFound) => {
    expect(mayDefineFootnote(text)).toBe(isFound);
  });
});
