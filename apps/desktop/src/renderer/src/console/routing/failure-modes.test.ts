// Failure modes of route parsing.
//
// The class: a hash the console did not write. An auxiliary window is addressed by a
// URL fragment, and a fragment is the one input a user, a stale bookmark, or a
// restored session can hand the console directly — so every malformed shape has to
// land somewhere legible instead of rendering blank. An unknown window name, a
// segment too many, a subject with a `/` in it that would split wrong, an empty
// hash: each has a specific answer, and three of the four are NOT errors.
//
// They live in `routing/` because a route is a value parsed from a string and
// rendered back to one — this family holds no state, reads no DOM, and knows no
// store exists, so the whole failure surface is the parse. The window that mounts
// the result and the store that keys off it fail in their own ways, in their own
// families.
//
// The case worth pinning is the bare auxiliary route, which looks malformed and is
// not: the Window menu opens `#/window/timeline` before a subject is chosen, so
// treating a missing subject as not-found would break the ordinary path while
// "handling" a failure that never happens.

import { describe, expect, it } from "vitest";

import { parseRoute } from "./routes.js";

describe("failure matrix — the router is handed a malformed auxiliary context", () => {
  it("treats an unknown window route as not-found rather than rendering blank", () => {
    expect(parseRoute("#/window/nonsense")).toStrictEqual({
      kind: "not-found",
      attempted: "#/window/nonsense",
    });
  });

  it("treats too many trailing segments as not-found", () => {
    expect(parseRoute("#/window/timeline/session-1/agent-1/extra").kind).toBe("not-found");
  });

  it("treats a BARE auxiliary route as a working window awaiting a subject", () => {
    // Not an error: the Window menu opens this window before anything is chosen.
    expect(parseRoute("#/window/timeline")).toStrictEqual({
      kind: "auxiliary",
      route: "timeline",
      sessionId: undefined,
      agentId: undefined,
    });
  });

  it("decodes a session id that needed escaping rather than splitting on it", () => {
    const route = parseRoute("#/window/agent-console/session%2Fwith%2Fslashes");
    expect(route).toStrictEqual({
      kind: "auxiliary",
      route: "agent-console",
      sessionId: "session/with/slashes",
      agentId: undefined,
    });
  });

  it("lands an empty hash on the default route", () => {
    expect(parseRoute("")).toStrictEqual({ kind: "sessions" });
    expect(parseRoute("#")).toStrictEqual({ kind: "sessions" });
    expect(parseRoute("#/")).toStrictEqual({ kind: "sessions" });
  });
});
