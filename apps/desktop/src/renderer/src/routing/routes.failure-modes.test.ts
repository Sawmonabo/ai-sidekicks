// Failure modes of route parsing: a hash the console did not write (a user, a stale bookmark, a
// restored session). Every malformed shape must land somewhere legible, and the empty hash is not
// an error. A malformed escape must not throw, and an empty segment must not be dropped, or
// `#/session//foo` would open session `foo`.

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
    // `decodeURIComponent("%zz")` raises `URIError`; thrown here it would escape
    // `WindowStore.adoptHash` and leave the window rendering nothing.
    expect(() => parseRoute("#/session/%zz")).not.toThrow();
    expect(parseRoute("#/session/%zz")).toStrictEqual({
      kind: "not-found",
      attempted: "#/session/%zz",
    });
  });

  it("resolves a malformed settings page to not-found rather than throwing", () => {
    // A second decode site, which is why the guard is one shared helper.
    expect(() => parseRoute("#/settings/%zz")).not.toThrow();
    expect(parseRoute("#/settings/%zz")).toStrictEqual({
      kind: "not-found",
      attempted: "#/settings/%zz",
    });
  });

  it("negative control: a well-formed escape on each arm still decodes", () => {
    // A parser that refused every escaped segment would otherwise satisfy the two refusals.
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
    // Dropping the empty segment would resolve this hash to session `foo`.
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
    // Refusing every hash would otherwise pass both refusals above.
    expect(parseRoute("#/sessions").kind).toBe("sessions");
    expect(parseRoute("#/session/foo")).toStrictEqual({ kind: "session", sessionId: "foo" });
    expect(parseRoute("#/settings")).toStrictEqual({ kind: "settings", page: undefined });
  });

  it("negative control: a hash that is only separators is still the default route", () => {
    // The leading slash is the one optional separator.
    expect(parseRoute("#/")).toStrictEqual({ kind: "sessions" });
  });
});
