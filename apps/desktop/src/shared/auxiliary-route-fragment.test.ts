// The fragment grammar's window handle: the segment that tells a window which
// window it is.
//
// The rest of the grammar is exercised where it is consumed — the window factory's
// URL assertions in `../main/auxiliary-window.test.ts` and the console's own route
// table. What is asserted HERE is the property neither of those can see: that the
// producer and the consumer agree about a segment that is optional, that rides only
// the context-bearing arms, and that is the last one — so a route admits three
// segment counts rather than two and no count within one route means two things.
//
// Every case drives both halves of the seam. A handle written by
// `formatAuxiliaryFragment` and read back by `parseAuxiliaryFragment` is the whole
// claim; asserting one half against a hand-written string would let the two agree
// with a typo.

import { describe, expect, it } from "vitest";

import {
  auxiliaryWindowIdOf,
  formatAuxiliaryFragment,
  InvalidAuxiliaryRouteTargetError,
  parseAuxiliaryFragment,
  type AuxiliaryRouteTarget,
} from "./auxiliary-route-fragment.js";

const SESSION_ID = "0f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
const AGENT_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const WINDOW_ID = "aux-window-7";

describe("the auxiliary fragment's window handle", () => {
  const HANDLE_BEARING_TARGETS: readonly AuxiliaryRouteTarget[] = [
    { route: "timeline", sessionId: SESSION_ID, windowId: WINDOW_ID },
    { route: "agent-console", sessionId: SESSION_ID, agentId: AGENT_ID, windowId: WINDOW_ID },
  ];

  for (const target of HANDLE_BEARING_TARGETS) {
    it(`round-trips a ${target.route} address that carries one`, () => {
      const fragment = formatAuxiliaryFragment(target);

      // The handle is the LAST segment, which is the property the three admitted
      // counts rest on. Asserted on the rendered string as well as on the parse,
      // because a producer that put it anywhere else would still round-trip
      // through a consumer that made the same mistake.
      expect(fragment.endsWith(`/${WINDOW_ID}`)).toBe(true);
      expect(parseAuxiliaryFragment(fragment)).toStrictEqual(target);
      expect(auxiliaryWindowIdOf(target)).toBe(WINDOW_ID);
    });
  }

  it("negative control: an address with no handle round-trips and reports none", () => {
    // Without this, every case above would pass over a grammar that appended a
    // handle to everything — and a window opened from the menu bar would offer to
    // return a pane to a deck slot that does not exist.
    const target: AuxiliaryRouteTarget = { route: "timeline", sessionId: SESSION_ID };

    const fragment = formatAuxiliaryFragment(target);

    expect(fragment).toBe(`#/window/timeline/${SESSION_ID}`);
    expect(parseAuxiliaryFragment(fragment)).toStrictEqual(target);
    expect(auxiliaryWindowIdOf(target)).toBeUndefined();
  });

  it("escapes a handle carrying a separator, so it stays one segment", () => {
    // The handle is opaque to everything downstream, so nothing above this
    // guarantees its bytes. Unescaped, a `/` in one would re-shape the route —
    // which is the whole reason every segment goes through `encodeURIComponent`.
    const target: AuxiliaryRouteTarget = {
      route: "timeline",
      sessionId: SESSION_ID,
      windowId: "aux/window#7",
    };

    const fragment = formatAuxiliaryFragment(target);

    expect(fragment).toBe(`#/window/timeline/${SESSION_ID}/aux%2Fwindow%237`);
    expect(parseAuxiliaryFragment(fragment)).toStrictEqual(target);
  });

  it("refuses a handle on a route carrying no context, in the producer", () => {
    // A window the shell opened for a deck is a window opened on one of that
    // deck's panes, and a pane belongs to a session — so a handle with nothing to
    // show names a deck slot for a pane the target does not identify. It is also
    // what keeps the segment counts unambiguous: a bare route carrying a handle
    // would be one segment long and indistinguishable from one carrying a session.
    const target = { route: "timeline", windowId: WINDOW_ID } as unknown as AuxiliaryRouteTarget;

    expect(() => formatAuxiliaryFragment(target)).toThrow(InvalidAuxiliaryRouteTargetError);
    expect(() => formatAuxiliaryFragment(target)).toThrow(
      "carries a window handle only with its full context",
    );
  });

  it("refuses an empty handle rather than encoding it as an empty segment", () => {
    const target = {
      route: "timeline",
      sessionId: SESSION_ID,
      windowId: "",
    } as unknown as AuxiliaryRouteTarget;

    expect(() => formatAuxiliaryFragment(target)).toThrow("takes no empty window handle");
  });

  it("refuses more segments than a route's context plus one handle", () => {
    // The consumer's half of the same rule. `timeline` admits 0, 1 and 2 trailing
    // segments and `agent-console` 0, 2 and 3; anything past that is not a longer
    // address, it is a different one.
    expect(parseAuxiliaryFragment(`#/window/timeline/${SESSION_ID}/${WINDOW_ID}/extra`)).toBeNull();
    expect(
      parseAuxiliaryFragment(`#/window/agent-console/${SESSION_ID}/${AGENT_ID}/${WINDOW_ID}/extra`),
    ).toBeNull();
  });

  it("reads a lone extra segment on agent-console as an incomplete context, not a handle", () => {
    // `agent-console` takes two context keys, so one trailing segment is neither a
    // full context nor a context-plus-handle. Read as a handle it would have made
    // `#/window/agent-console/<something>` a window claiming a deck slot while
    // naming nothing to show in it.
    expect(parseAuxiliaryFragment(`#/window/agent-console/${SESSION_ID}`)).toBeNull();
  });
});
