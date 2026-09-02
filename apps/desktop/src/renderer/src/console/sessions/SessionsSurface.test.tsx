// What the all-sessions destination may claim, and the act it must never perform.
//
// Two properties here are the destination's whole reason for existing and neither
// is a type:
//
//   1. **Looking at the list creates nothing.** The shipped session probe calls
//      `session.create` from its mount effect, and the route lifecycle remounts
//      this slot on every navigation — so a surface that mounted the probe with
//      itself would create a session every time somebody visited Settings and came
//      back. The probe must appear only after the start control is pressed.
//   2. **"Nothing here" means "this console holds none", never "there are none".**
//      There is no session-directory read on any transport, so the second claim is
//      one this console never established.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MemoryPersistenceAdapter } from "../persistence/memory-adapter.js";
import { UiStateStore } from "../persistence/index.js";
import { SessionStore } from "../store/index.js";
import { SessionsSurface } from "./SessionsSurface.js";
import type { ConsoleSurfaceContext } from "../frame/surface-registry.js";

/**
 * Let the destination's asynchronous arrivals land.
 *
 * Two reads settle behind this surface — the attention projection and the invites
 * fan-out — and each settles an effect that can schedule the next, so the count is
 * the depth of that chain rather than a number picked to make a test pass.
 */
async function settle(): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** A store holding the sessions a test names, established the way a read would. */
function storeHolding(sessionIds: readonly string[]): SessionStore {
  const store = new SessionStore({ sessionId: sessionIds[0] ?? "session-none" });
  store.initialise({
    cursor: 0,
    entities: sessionIds.map((sessionId) => ({
      kind: "session" as const,
      id: sessionId,
      state: "active",
      touchedAt: "2026-01-01T10:00:00.000Z",
    })),
    participantJoinLog: [],
  });
  return store;
}

/**
 * The fields this surface reads, and nothing else.
 *
 * Cast rather than fully constructed, for `legacy-surfaces.test.ts`'s reason: a
 * real context carries three stores, one of which opens a database on
 * construction, and building all of that to hand five fields to a component that
 * reads five would make the setup the subject. The two stores that ARE real here
 * are the two whose behaviour is under test.
 */
function contextWith(options: {
  readonly sessionStore?: SessionStore;
  readonly bridgeSource?: "live" | "fixture";
}): ConsoleSurfaceContext {
  return {
    route: { kind: "sessions" },
    bridge: {
      source: options.bridgeSource ?? "fixture",
      growth: {
        invitesList: () =>
          Promise.resolve({
            status: "unavailable",
            code: "wire-unregistered",
            origin: "growth-port",
            detail: "Not checked — the invites list read is not registered yet.",
            operationId: "invitesList",
            slateRow: "invites-list",
            owningDocument: "Spec-002",
          }),
      },
    },
    frameStore: { activeSessionId: undefined, navigate: () => undefined },
    sessionStore: options.sessionStore,
    uiStateStore: new UiStateStore({ adapter: new MemoryPersistenceAdapter() }),
    draftStore: undefined,
  } as unknown as ConsoleSurfaceContext;
}

describe("what the destination says when it holds nothing", () => {
  it("says it holds no sessions, never that there are none", () => {
    const { container } = render(<SessionsSurface context={contextWith({})} />);
    const text = container.textContent ?? "";
    expect(text).toContain("This console is not holding any sessions.");
    // The claim it must never make. `toContain` on the honest sentence would pass
    // beside this one too, which is why the refusal is asserted separately.
    expect(text).not.toMatch(/no sessions (?:exist|on this daemon)/iu);
  });

  it("says why the list is not a sweep of the daemon", () => {
    const { container } = render(<SessionsSurface context={contextWith({})} />);
    expect(container.textContent ?? "").toContain("there is no verb for enumerating the rest");
  });

  it("renders the absence as 'nobody asked' rather than as 'the read came back empty'", () => {
    const { container } = render(<SessionsSurface context={contextWith({})} />);
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });

  it("negative control: a console holding sessions does not render the empty state", () => {
    const { container } = render(
      <SessionsSurface
        context={contextWith({ sessionStore: storeHolding(["session-a", "session-b"]) })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toContain("This console is not holding any sessions.");
    expect(text).toContain("2 sessions are open in this console.");
  });

  it("reads one session as one rather than as a quantity", () => {
    const { container } = render(
      <SessionsSurface context={contextWith({ sessionStore: storeHolding(["session-a"]) })} />,
    );
    expect(container.textContent ?? "").toContain("One session is open in this console.");
  });
});

describe("starting a session is an act", () => {
  it("mounts nothing that could create a session until the control is pressed", () => {
    const { container } = render(<SessionsSurface context={contextWith({})} />);
    expect(container.querySelector(".meridian-sessions__started")).toBeNull();
  });

  it("offers exactly one start control, and it is reachable", () => {
    const { container } = render(<SessionsSurface context={contextWith({})} />);
    const controls = container.querySelectorAll(".meridian-sessions__start");
    expect(controls).toHaveLength(1);
    expect(controls[0]?.tagName).toBe("BUTTON");
  });

  it("mounts the probe on the press, and remounts it on the next one", () => {
    const { container } = render(<SessionsSurface context={contextWith({})} />);
    const start = container.querySelector<HTMLButtonElement>(".meridian-sessions__start");
    act(() => {
      start?.click();
    });
    const started = container.querySelector(".meridian-sessions__started");
    expect(started).not.toBeNull();
    // The press count keys the mount, so a second press starts a second session
    // rather than leaving the first mount in place and going silently inert.
    const firstChild = started?.firstElementChild;
    act(() => {
      start?.click();
    });
    expect(container.querySelector(".meridian-sessions__started")?.firstElementChild).not.toBe(
      firstChild,
    );
  });

  it("declines to ask on the probe's behalf while the console runs on the fixture", () => {
    const { container } = render(<SessionsSurface context={contextWith({})} />);
    act(() => {
      container.querySelector<HTMLButtonElement>(".meridian-sessions__start")?.click();
    });
    expect(container.textContent ?? "").toContain("running on the fixture");
  });
});

describe("what the destination puts beside the list", () => {
  it("mounts the invitations shelf and the attention panel", () => {
    const { container } = render(<SessionsSurface context={contextWith({})} />);
    expect(container.querySelector(".meridian-invite-shelf")).not.toBeNull();
    expect(container.querySelector(".meridian-attention")).not.toBeNull();
  });

  it("says the attention projection was not read, rather than that nothing needs anybody", async () => {
    const { container } = render(<SessionsSurface context={contextWith({})} />);
    await settle();
    const text = container.textContent ?? "";
    expect(text).toContain("The attention projection has not been read.");
    expect(text).not.toContain("Nothing needs you.");
  });
});
