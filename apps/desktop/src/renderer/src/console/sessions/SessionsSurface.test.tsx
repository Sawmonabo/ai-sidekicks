// What the all-sessions list may claim, and what it must not.
//
// The list's hardest property is a copy property: there is no enumeration verb on
// any transport, so "nothing here" means "this console holds no references", not
// "the daemon has no sessions". A surface that said the second would be asserting a
// fact it never established, which is the conflation the five kinds of nothing
// exist to prevent — and no type would catch it, so it is checked here.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SessionsSurface } from "./SessionsSurface.js";
import type { ConsoleSurfaceContext } from "../frame/surface-registry.js";

/**
 * The three fields this surface reads, and nothing else.
 *
 * Cast rather than constructed, for `legacy-surfaces.test.ts`'s reason: a real
 * context carries three stores, one of which opens a database on construction, and
 * building all of that to hand three fields to a component that reads three fields
 * would make the setup the subject.
 */
function contextWith(
  bridgeSource: "live" | "fixture",
  heldSessionIds: readonly string[] | undefined,
): ConsoleSurfaceContext {
  const partitions = Object.fromEntries(
    heldSessionIds?.map((sessionId) => [sessionId, { kind: "session", id: sessionId }]) ?? [],
  );
  return {
    route: { kind: "sessions" },
    bridge: { source: bridgeSource },
    sessionStore:
      heldSessionIds === undefined
        ? undefined
        : { snapshot: () => ({ initialised: true, partitions: { session: partitions } }) },
  } as unknown as ConsoleSurfaceContext;
}

describe("all-sessions list — what it says when it holds nothing", () => {
  it("says it holds no sessions, never that there are none", () => {
    const { container } = render(<SessionsSurface context={contextWith("fixture", undefined)} />);
    const text = container.textContent ?? "";
    expect(text).toContain("This console is not holding any sessions.");
    // The claim it must never make. `toContain` on the honest sentence would pass
    // beside this one too, which is why the refusal is asserted separately.
    expect(text).not.toMatch(/no sessions (?:exist|on this daemon)/iu);
  });

  it("says why the list is not a sweep of the daemon", () => {
    const { container } = render(<SessionsSurface context={contextWith("fixture", undefined)} />);
    expect(container.textContent ?? "").toContain("there is no verb for enumerating the rest");
  });

  it("negative control: a console holding sessions does not render the empty state", () => {
    // Without this, both cases above would pass over a surface that rendered its
    // empty state unconditionally.
    const { container } = render(
      <SessionsSurface context={contextWith("fixture", ["session-a", "session-b"])} />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toContain("This console is not holding any sessions.");
    expect(text).toContain("2 sessions are open in this console.");
  });

  it("reads one session as one rather than as a quantity", () => {
    const { container } = render(
      <SessionsSurface context={contextWith("fixture", ["session-a"])} />,
    );
    expect(container.textContent ?? "").toContain("One session is open in this console.");
  });
});

describe("all-sessions list — the create and join controls", () => {
  // Only the fixture arm is MOUNTED here. The probe reads `window.sidekicks`
  // directly, so rendering its live arm in this tier would assert something about
  // happy-dom's missing preload rather than about this surface. That arm is covered
  // where it belongs, by inspecting the element `renderAbsorbedSessionProbe`
  // returns (`frame/legacy-surfaces.test.ts`).

  it("keeps a place for them even when the console declines to ask", () => {
    const { container } = render(<SessionsSurface context={contextWith("fixture", undefined)} />);
    expect(container.querySelector(".meridian-sessions__aside")).not.toBeNull();
  });

  it("says the question was not put under the fixture", () => {
    // Under the fixture the console declines to ask on the probe's behalf rather
    // than answering from the live daemon in a window showing fixture data.
    const { container } = render(<SessionsSurface context={contextWith("fixture", undefined)} />);
    expect(container.textContent ?? "").toContain("running on the fixture");
  });

  it("negative control: the aside is not empty chrome", () => {
    // Without this, the case above would pass over an aside that rendered its
    // heading and nothing at all beneath it.
    const { container } = render(<SessionsSurface context={contextWith("fixture", undefined)} />);
    const aside = container.querySelector(".meridian-sessions__aside");
    expect(aside?.querySelector(".meridian-nothing")).not.toBeNull();
  });
});
