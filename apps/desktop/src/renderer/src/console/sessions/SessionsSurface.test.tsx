// What the all-sessions destination may claim, and the act it must never perform.
//
// Four properties here are the destination's whole reason for existing and none of
// them is a type:
//
//   1. **Looking at the list creates nothing.** The shipped session probe calls
//      `session.create` from its mount effect, and the route lifecycle remounts
//      this slot on every navigation — so a surface that mounted the probe with
//      itself would create a session every time somebody visited Settings and came
//      back. The probe must appear only after the start control is pressed.
//   2. **An empty list is three different facts.** A refused directory is "nobody
//      asked", a served-and-empty directory is "the node has none", and a read in
//      flight is neither. Each is asserted with the other two as its negative
//      control, because a surface that renders one kind for all three reads as
//      correct until the day the difference matters.
//   3. **A window holding nothing is not a node holding nothing.** The directory is
//      a node read, so it answers on an address that names no session — which is
//      exactly the state a person is in when they open the console.
//   4. **Both session-scoped reads ask about every session, not the route's.** The
//      attention projection and the invitations list are each scoped to one session
//      on the wire, and every address that mounts this surface is `kind: "sessions"`
//      and names none — so a read keyed on the route asks about nothing at all and
//      reports every session's answer as unasked.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { REFRESH_DEBOUNCE_MS } from "../core/index.js";
import { MemoryPersistenceAdapter } from "../persistence/memory-adapter.js";
import { UiStateStore } from "../persistence/index.js";
import { SessionStore } from "../store/index.js";
import { SessionsSurface } from "./SessionsSurface.js";
import type { ConsoleSurfaceContext } from "../frame/surface-registry.js";

/**
 * Let the destination's asynchronous arrivals land.
 *
 * Three reads settle behind this surface — the attention projection, the invites
 * fan-out, and the node's session directory — and each settles an effect that can
 * schedule the next, so the count is the depth of that chain rather than a number
 * picked to make a test pass.
 *
 * The attention read is the one that also costs TIME. It goes through the console's
 * one refresh scheduler, so its first read lands a debounce interval after the
 * subscribe rather than on the next microtask — and the bridge this file builds
 * carries no scenario engine, so that interval is measured on the wall clock. A
 * surface driven against the real fixture advances the frozen clock instead.
 */
async function settle(): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  await act(async () => {
    await new Promise((resolveAfterDebounce) => {
      setTimeout(resolveAfterDebounce, REFRESH_DEBOUNCE_MS * 2);
    });
  });
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
 * The absence the LIST is rendering, as its kind classes.
 *
 * Scoped to the list region deliberately. The aside beside it holds two other
 * reads — the invitations shelf and the attention panel — and each renders its own
 * honest absence, so an unscoped query would answer with whichever of the three
 * came first in the document and would pass or fail for reasons that have nothing
 * to do with the directory.
 */
function listAbsenceKinds(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-sessions__list .meridian-nothing")].flatMap(
    (element) => [...element.classList].filter((name) => name.startsWith("meridian-nothing--")),
  );
}

/** The refusal the growth port answers with while no wire serves a read. */
function refusedRead(operationId: string, slateRow: string): unknown {
  return {
    status: "unavailable",
    code: "wire-unregistered",
    origin: "growth-port",
    detail: `Not checked — the ${operationId} read is not registered yet.`,
    operationId,
    slateRow,
    owningDocument: "Spec-002",
  };
}

/**
 * The fields this surface reads, and nothing else.
 *
 * Cast rather than fully constructed, for `legacy-surfaces.test.ts`'s reason: a
 * real context carries three stores, one of which opens a database on
 * construction, and building all of that to hand six fields to a component that
 * reads six would make the setup the subject. The two stores that ARE real here
 * are the two whose behaviour is under test.
 */
function contextWith(options: {
  readonly sessionStore?: SessionStore;
  readonly bridgeSource?: "live" | "fixture";
  /** What the node's directory read answers. Refused unless a test names rows. */
  readonly directorySessionIds?: readonly string[];
  /** What this window holds a store for, as the registry would report it. */
  readonly windowSessionIds?: readonly string[];
  /** Attention items the projection serves, per session. Refused unless named. */
  readonly attentionBySessionId?: Readonly<Record<string, readonly unknown[]>>;
  /** Invitations the port serves, per session. Refused unless a test names them. */
  readonly invitesBySessionId?: Readonly<Record<string, readonly unknown[]>>;
  /** The session each `invitesList` call named, appended in call order. */
  readonly invitesListCalls?: string[];
}): ConsoleSurfaceContext {
  const directorySessionIds = options.directorySessionIds;
  return {
    route: { kind: "sessions" },
    bridge: {
      source: options.bridgeSource ?? "fixture",
      growth: {
        invitesList: ({ sessionId }: { readonly sessionId: string }) => {
          options.invitesListCalls?.push(sessionId);
          const invites = options.invitesBySessionId?.[sessionId];
          return Promise.resolve(
            invites === undefined
              ? refusedRead("invitesList", "invites-list")
              : { status: "served", value: invites },
          );
        },
        attentionProjectionRead: ({ sessionId }: { readonly sessionId: string }) => {
          const items = options.attentionBySessionId?.[sessionId];
          return Promise.resolve(
            items === undefined
              ? refusedRead("attentionProjectionRead", "attention-projection-read")
              : { status: "served", value: { items } },
          );
        },
        sessionList: () =>
          Promise.resolve(
            directorySessionIds === undefined
              ? refusedRead("sessionList", "session-directory-read")
              : {
                  status: "served",
                  value: directorySessionIds.map((sessionId) => ({
                    sessionId,
                    state: "active",
                  })),
                },
          ),
      },
    },
    frameStore: { navigate: () => undefined },
    sessionStore: options.sessionStore,
    sessionStoreRegistry: {
      openSessionIds: options.windowSessionIds ?? [],
      subscribe: () => () => undefined,
    },
    uiStateStore: new UiStateStore({ adapter: new MemoryPersistenceAdapter() }),
    draftStore: undefined,
  } as unknown as ConsoleSurfaceContext;
}

describe("which kind of nothing an empty list is", () => {
  it("says nobody asked when the directory read is refused", async () => {
    const { container } = render(<SessionsSurface context={contextWith({})} />);
    await settle();
    const text = container.textContent ?? "";
    expect(text).toContain("This console is not holding any sessions.");
    expect(listAbsenceKinds(container)).toStrictEqual([
      "meridian-nothing--block",
      "meridian-nothing--not-checked",
    ]);
    // The claim it must never make in this state. `toContain` on the honest
    // sentence would pass beside it, which is why it is asserted separately.
    expect(text).not.toMatch(/no sessions (?:exist|on this daemon)/iu);
  });

  it("carries the port's own refusal sentence rather than inventing one", async () => {
    const { container } = render(<SessionsSurface context={contextWith({})} />);
    await settle();
    expect(container.textContent ?? "").toContain("the sessionList read is not registered yet");
  });

  it("says the node has none when the directory answered with no rows", async () => {
    const { container } = render(
      <SessionsSurface context={contextWith({ directorySessionIds: [] })} />,
    );
    await settle();
    const text = container.textContent ?? "";
    expect(text).toContain("There are no sessions on this node yet.");
    expect(listAbsenceKinds(container)).toStrictEqual([
      "meridian-nothing--block",
      "meridian-nothing--empty",
    ]);
    // The negative control that makes the arm above mean something: the refused
    // sentence is gone with the refused kind.
    expect(text).not.toContain("This console is not holding any sessions.");
  });

  it("says the read is in flight before it settles, and neither of the other two", () => {
    // Rendered WITHOUT settling on purpose: this is the one state that exists only
    // between the mount and the first microtask, and a test that settled first
    // could not observe it.
    const { container } = render(
      <SessionsSurface context={contextWith({ directorySessionIds: [] })} />,
    );
    expect(listAbsenceKinds(container)).toStrictEqual([
      "meridian-nothing--block",
      "meridian-nothing--not-loaded",
    ]);
  });
});

describe("what the destination lists", () => {
  it("lists the node's sessions on an address that names none of them", async () => {
    // The regression this arm exists for: before the directory read, a window that
    // had opened nothing reported an empty NODE, which is a different claim.
    const { container } = render(
      <SessionsSurface context={contextWith({ directorySessionIds: ["session-node"] })} />,
    );
    await settle();
    const text = container.textContent ?? "";
    expect(text).toContain("One session is on this node.");
    expect(listAbsenceKinds(container)).toStrictEqual([]);
  });

  it("names a session once when the node and this window both hold it", async () => {
    const { container } = render(
      <SessionsSurface
        context={contextWith({
          directorySessionIds: ["session-a"],
          sessionStore: storeHolding(["session-a"]),
        })}
      />,
    );
    await settle();
    expect(container.textContent ?? "").toContain("One session is on this node.");
  });

  it("appends what only this window knows to what the node reported", async () => {
    const { container } = render(
      <SessionsSurface
        context={contextWith({
          directorySessionIds: ["session-node"],
          sessionStore: storeHolding(["session-local"]),
        })}
      />,
    );
    await settle();
    expect(container.textContent ?? "").toContain("2 sessions are on this node.");
  });

  it("counts this window's own sessions in this console's words when the node refused", async () => {
    const { container } = render(
      <SessionsSurface
        context={contextWith({ sessionStore: storeHolding(["session-a", "session-b"]) })}
      />,
    );
    await settle();
    const text = container.textContent ?? "";
    expect(text).toContain("2 sessions are open in this console.");
    // The authority is the claim: a refused directory may not be reported as the
    // node's answer.
    expect(text).not.toContain("sessions are on this node.");
  });

  it("reads one session as one rather than as a quantity", async () => {
    const { container } = render(
      <SessionsSurface context={contextWith({ sessionStore: storeHolding(["session-a"]) })} />,
    );
    await settle();
    expect(container.textContent ?? "").toContain("One session is open in this console.");
  });
});

describe("starting a session is an act", () => {
  it("mounts nothing that could create a session until the control is pressed", () => {
    const { container } = render(<SessionsSurface context={contextWith({})} />);
    expect(container.querySelector(".meridian-sessions__started")).toBeNull();
  });

  it("offers exactly one start control, and it is reachable", async () => {
    const { container } = render(<SessionsSurface context={contextWith({})} />);
    await settle();
    const controls = container.querySelectorAll(".meridian-sessions__start");
    expect(controls).toHaveLength(1);
    expect(controls[0]?.tagName).toBe("BUTTON");
  });

  it("mounts the probe on the press, and remounts it on the next one", async () => {
    const { container } = render(<SessionsSurface context={contextWith({})} />);
    await settle();
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

  it("declines to ask on the probe's behalf while the console runs on the fixture", async () => {
    const { container } = render(<SessionsSurface context={contextWith({})} />);
    await settle();
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

  it("asks about every session it can name, not only the one the address names", async () => {
    // The read is session-scoped on the wire and this destination is not, so the
    // proof is that an item raised for a session THIS ADDRESS DOES NOT NAME still
    // reaches the panel. Before the fan-out the surface read for the active session
    // and the address names none, so this panel could never populate at all.
    const { container } = render(
      <SessionsSurface
        context={contextWith({
          directorySessionIds: ["session-node"],
          attentionBySessionId: {
            "session-node": [
              {
                id: "attention-1",
                sessionId: "session-node",
                trigger: "pending_approval",
                severity: "actionable",
                summary: "A tool call is waiting on you.",
                sourceEventId: "event-1",
                createdAt: "2026-01-01T10:00:00.000Z",
              },
            ],
          },
        })}
      />,
    );
    await settle();
    const text = container.textContent ?? "";
    expect(text).toContain("A tool call is waiting on you.");
    expect(text).not.toContain("The attention projection has not been read.");
  });
});

describe("the invitations the destination reads for", () => {
  /** One invitation as the port serves it. Pending, so the shelf lists it. */
  function pendingInvite(inviteId: string): unknown {
    return { inviteId, state: "pending", expiresAt: "2026-02-01T10:00:00.000Z" };
  }

  it("asks once per session it can name, and names each of them", async () => {
    // The regression this arm exists for: the read was keyed on the route's
    // session, every address that mounts this surface names none, and the fan-out
    // was therefore empty forever. Under that reader this array stays `[]`.
    const invitesListCalls: string[] = [];
    render(
      <SessionsSurface
        context={contextWith({
          directorySessionIds: ["session-a", "session-b"],
          invitesListCalls,
        })}
      />,
    );
    await settle();
    expect(invitesListCalls).toStrictEqual(["session-a", "session-b"]);
  });

  it("lists an invitation for a session this address does not name", async () => {
    const { container } = render(
      <SessionsSurface
        context={contextWith({
          directorySessionIds: ["session-a"],
          invitesBySessionId: { "session-a": [pendingInvite("invite-1")] },
        })}
      />,
    );
    await settle();
    const text = container.textContent ?? "";
    expect(text).toContain("invite-1");
    expect(text).not.toContain("No invitations have been read.");
  });

  it("does not let one session's refusal hide another session's invitation", async () => {
    // Each session's outcome travels on its own, so a partial read is a partial
    // read. A fan-out that collapsed to the first answer would render the refusal
    // and drop the invitation that did arrive — and one that dropped the refusal
    // would hide a session the console never got an answer from, so both are on
    // screen and neither stands for the other.
    const { container } = render(
      <SessionsSurface
        context={contextWith({
          directorySessionIds: ["session-refused", "session-served"],
          invitesBySessionId: { "session-served": [pendingInvite("invite-2")] },
        })}
      />,
    );
    await settle();
    const text = container.textContent ?? "";
    expect(text).toContain("invite-2");
    expect(text).toContain("the invitesList read is not registered yet");
  });

  it("negative control: asks nothing when it can name no session", async () => {
    // Without this, the fan-out could pass by asking about a session it invented.
    // A console holding none has nothing to ask about, and the shelf says exactly
    // that rather than reporting an empty inbox.
    const invitesListCalls: string[] = [];
    const { container } = render(<SessionsSurface context={contextWith({ invitesListCalls })} />);
    await settle();
    expect(invitesListCalls).toStrictEqual([]);
    expect(container.textContent ?? "").toContain("No invitations have been read.");
  });
});
