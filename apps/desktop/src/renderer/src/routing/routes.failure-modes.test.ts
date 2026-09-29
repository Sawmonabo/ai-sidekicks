// Failure modes of route parsing.
//
// The class: a hash the console did not write. A URL fragment is the one input a user,
// a stale bookmark, or a restored session can hand the console directly — so every
// malformed shape has to land somewhere legible instead of rendering blank. A
// malformed percent-escape, an empty path segment, an empty hash: each has a specific
// answer, and the empty hash is NOT an error.
//
// The last two rows are the ones a parser gets wrong QUIETLY. A malformed escape
// throws out of a function whose contract is that every input produces a route, and
// an empty segment dropped before the grammar reads it turns a malformed link into a
// well-formed one — `#/session//foo` opening session `foo`, which is a different
// session than the link names.
//
// They live in `routing/` because a route is a value parsed from a string and
// rendered back to one — this family holds no state, reads no DOM, and knows no
// store exists, so the whole failure surface is the parse. The window that mounts
// the result and the store that keys off it fail in their own ways, in their own
// families.

import { describe, expect, it } from "vitest";

import { parseRoute } from "./routes.js";

describe("failure matrix — the router is handed an empty hash", () => {
  it("lands an empty hash on the default route", () => {
    expect(parseRoute("")).toStrictEqual({ kind: "sessions" });
    expect(parseRoute("#")).toStrictEqual({ kind: "sessions" });
    expect(parseRoute("#/")).toStrictEqual({ kind: "sessions" });
  });
});

describe("failure matrix — the router is handed a malformed percent-escape", () => {
  it("resolves a malformed session id to not-found rather than throwing", () => {
    // `decodeURIComponent("%zz")` raises `URIError`. Thrown from here it escapes
    // `WindowStore.adoptHash` and the routing effect that calls it, so the window
    // that was asked to render a bad link renders nothing and says nothing.
    expect(() => parseRoute("#/session/%zz")).not.toThrow();
    expect(parseRoute("#/session/%zz")).toStrictEqual({
      kind: "not-found",
      attempted: "#/session/%zz",
    });
  });

  it("resolves a malformed settings page to not-found rather than throwing", () => {
    // The second decode site in the module, and the reason the guard is one shared
    // helper: a per-site `try` is what leaves the next arm to grow a segment bare.
    expect(() => parseRoute("#/settings/%zz")).not.toThrow();
    expect(parseRoute("#/settings/%zz")).toStrictEqual({
      kind: "not-found",
      attempted: "#/settings/%zz",
    });
  });

  it("negative control: a well-formed escape on each arm still decodes", () => {
    // Without this, a parser that answered not-found for every escaped segment
    // would satisfy the two refusals above and break every id that needs escaping.
    expect(parseRoute("#/session/session%2Fone")).toStrictEqual({
      kind: "session",
      sessionId: "session/one",
    });
    expect(parseRoute("#/settings/provider%20accounts")).toStrictEqual({
      kind: "settings",
      page: "provider accounts",
    });
  });
});

describe("failure matrix — the router is handed an empty path segment", () => {
  it("refuses a doubled slash rather than selecting a different session", () => {
    // The consequence that makes this a defect rather than an untidiness: dropping
    // the empty segment resolves this hash to the session screen for session `foo`.
    expect(parseRoute("#/session//foo")).toStrictEqual({
      kind: "not-found",
      attempted: "#/session//foo",
    });
  });

  it("refuses a trailing slash on every main-window arm", () => {
    expect(parseRoute("#/sessions/").kind).toBe("not-found");
    expect(parseRoute("#/session/").kind).toBe("not-found");
    expect(parseRoute("#/settings/").kind).toBe("not-found");
  });

  it("negative control: the same routes without the empty segment still parse", () => {
    // Without this, refusing every hash would pass both refusals above.
    expect(parseRoute("#/sessions").kind).toBe("sessions");
    expect(parseRoute("#/session/foo")).toStrictEqual({ kind: "session", sessionId: "foo" });
    expect(parseRoute("#/settings")).toStrictEqual({ kind: "settings", page: undefined });
  });

  it("negative control: a hash that is only separators is still the default route", () => {
    // The leading slash is the one optional separator, so refusing empty segments
    // must not reclassify the empty path a window with no hash lands on.
    expect(parseRoute("#/")).toStrictEqual({ kind: "sessions" });
  });
});
