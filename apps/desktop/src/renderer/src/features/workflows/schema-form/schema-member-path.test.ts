// The path representation on its own, before any schema is compiled: a path becomes a string
// reversibly, and two paths are the same member only when every segment matches by identity.

import { describe, expect, it } from "vitest";

import { encodeMemberPointer, isSameMemberPath } from "./schema-member-path.js";

describe("encoding a member path as a JSON Pointer", () => {
  it("escapes the two characters an RFC 6901 reference token cannot carry literally", () => {
    // Escaping the separator first would re-escape the tilde it just wrote (`a/b` -> `a~01b`).
    expect(encodeMemberPointer(["a/b", "c~d", 0])).toBe("/a~1b/c~0d/0");
    expect(encodeMemberPointer([])).toBe("");
  });

  it("spells a dotted property name and an array position as two different pointers", () => {
    // Both join to `items.0` under a dot; the encoding keeps them apart.
    expect(encodeMemberPointer(["items.0"])).toBe("/items.0");
    expect(encodeMemberPointer(["items", 0])).toBe("/items/0");
  });
});

describe("comparing two member paths", () => {
  it("matches a path against itself segment by segment", () => {
    expect(isSameMemberPath(["release", "tag"], ["release", "tag"])).toBe(true);
    expect(isSameMemberPath([], [])).toBe(true);
  });

  it("keeps an array position apart from a property whose name is that digit", () => {
    // `["items", 0]` is the first entry and `["items", "0"]` a property named `0`; a schema may
    // declare both.
    expect(isSameMemberPath(["items", 0], ["items", "0"])).toBe(false);
  });

  it("matches exactly that member and never the subtree under it", () => {
    // A group's fieldset asks about its own path and must not receive its children's findings.
    expect(isSameMemberPath(["scope"], ["scope", "note"])).toBe(false);
    expect(isSameMemberPath(["scope", "note"], ["scope"])).toBe(false);
  });

  it("negative control: a path that differs only in one segment does not match", () => {
    // Without this, the cases above would hold over a comparison that always answered true.
    expect(isSameMemberPath(["release", "tag"], ["release", "note"])).toBe(false);
  });
});
