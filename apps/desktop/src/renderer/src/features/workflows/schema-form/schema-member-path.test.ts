// Addressing, on its own, because it is read on its own.
//
// The validator's suite next door checks that a finding CARRIES a member path; this one
// checks what that representation guarantees, which is what six modules of the schema form
// seat rely on before any schema has been compiled: that a path becomes a string
// reversibly, and that two paths are the same member only when every segment matches by
// identity.
//
// BOTH PROPERTIES ARE ABOUT ONE FAILURE. A dotted join is not injective — a property named
// `items.0` and the first entry of an array named `items` collapse onto one string — so a
// surface keyed on the join draws one member's verdict under another member's control. The
// pointer encoding escapes rather than collapses; the comparison keeps a numeric position
// apart from a property whose name reads like one.

import { describe, expect, it } from "vitest";

import { encodeMemberPointer, isSameMemberPath } from "./schema-member-path.js";

describe("encoding a member path as a JSON Pointer", () => {
  it("escapes the two characters an RFC 6901 reference token cannot carry literally", () => {
    // Order is what this pins: escaping the separator first would re-escape the tilde this
    // step just wrote and turn `a/b` into `a~01b`, a token decoding to something nobody
    // wrote. The empty path is the pointer grammar's own name for the whole document.
    expect(encodeMemberPointer(["a/b", "c~d", 0])).toBe("/a~1b/c~0d/0");
    expect(encodeMemberPointer([])).toBe("");
  });

  it("spells a dotted property name and an array position as two different pointers", () => {
    // The reason the segments travel whole. Both of these join to `items.0` under a dot,
    // and the encoding is what keeps them apart everywhere a path has to become a string.
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
    // By identity and not by value, which is the whole reason a position stays a number:
    // `["items", 0]` addresses the first entry and `["items", "0"]` addresses a property
    // literally named `0`, and a schema may declare both.
    expect(isSameMemberPath(["items", 0], ["items", "0"])).toBe(false);
  });

  it("matches exactly that member and never the subtree under it", () => {
    // What lets a group's fieldset ask about its own path and receive only what the schema
    // said about the group. A prefix reading would draw every child's finding there too.
    expect(isSameMemberPath(["scope"], ["scope", "note"])).toBe(false);
    expect(isSameMemberPath(["scope", "note"], ["scope"])).toBe(false);
  });

  it("negative control: a path that differs only in one segment does not match", () => {
    // Without this, every case above would hold over a comparison that answered `true` for
    // any two paths of the same length.
    expect(isSameMemberPath(["release", "tag"], ["release", "note"])).toBe(false);
  });
});
