// What the all-sessions destination may claim, and the act it must never perform.
//
// Three properties here are the LIST's whole reason for existing and none of them is
// a type. The fourth — that both session-scoped reads ask about every session rather
// than the one the address names — moved to `SessionsSurface.aside.test.tsx` with the
// reads it is about, and the harness both files mount through is hoisted beside them:
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
//   4. **A blocked shell blocks the acts, not only the words.** The window's
//      read-only state was computed and rendered as explanatory text while every
//      control on this screen stayed live, so a person told the runtime was gone
//      could still press Start and have the probe create a session from its mount
//      effect. Each case pairs the closed control with the healthy one.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  contextWith,
  listAbsenceKinds,
  renderSurface,
  settle,
  storeHolding,
} from "./session-surface.test-support.js";
import {
  UNREPORTED_SHELL_STATE,
  shellMutationBlock,
  type ShellConnection,
} from "../store/index.js";

describe("which kind of nothing an empty list is", () => {
  it("says nobody asked when the directory read is refused", async () => {
    const { container } = renderSurface(contextWith({}));
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
    const { container } = renderSurface(contextWith({}));
    await settle();
    expect(container.textContent ?? "").toContain("the sessionList read is not registered yet");
  });

  it("says the node has none when the directory answered with no rows", async () => {
    const { container } = renderSurface(contextWith({ directorySessionIds: [] }));
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
    const { container } = renderSurface(contextWith({ directorySessionIds: [] }));
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
    const { container } = renderSurface(contextWith({ directorySessionIds: ["session-node"] }));
    await settle();
    const text = container.textContent ?? "";
    expect(text).toContain("One session is on this node.");
    expect(listAbsenceKinds(container)).toStrictEqual([]);
  });

  it("names a session once when the node and this window both hold it", async () => {
    const { container } = renderSurface(
      contextWith({
        directorySessionIds: ["session-a"],
        openStores: [storeHolding({ sessionId: "session-a" })],
      }),
    );
    await settle();
    expect(container.textContent ?? "").toContain("One session is on this node.");
  });

  it("appends what only this window knows to what the node reported", async () => {
    const { container } = renderSurface(
      contextWith({
        directorySessionIds: ["session-node"],
        openStores: [storeHolding({ sessionId: "session-local" })],
      }),
    );
    await settle();
    expect(container.textContent ?? "").toContain("2 sessions are on this node.");
  });

  it("counts this window's own sessions in this console's words when the node refused", async () => {
    const { container } = renderSurface(
      contextWith({
        openStores: [
          storeHolding({ sessionId: "session-a" }),
          storeHolding({ sessionId: "session-b" }),
        ],
      }),
    );
    await settle();
    const text = container.textContent ?? "";
    expect(text).toContain("2 sessions are open in this console.");
    // The authority is the claim: a refused directory may not be reported as the
    // node's answer.
    expect(text).not.toContain("sessions are on this node.");
  });

  it("reads one session as one rather than as a quantity", async () => {
    const { container } = renderSurface(
      contextWith({ openStores: [storeHolding({ sessionId: "session-a" })] }),
    );
    await settle();
    expect(container.textContent ?? "").toContain("One session is open in this console.");
  });
});

describe("what an open session contributes to its row", () => {
  // The regression these three close: this destination is mounted at an address that
  // names no session, so the frame hands it `undefined` for the route's store and the
  // list used to be built from that. Every locally open session was reduced to its
  // identifier — no projected touched time to order by, no participants on the row —
  // and the ordering sentence the design opens with had nothing to order.

  /** The session identifiers the list renders, in the order it renders them. */
  function listedSessionIds(container: HTMLElement): readonly string[] {
    return [...container.querySelectorAll(".meridian-session-row__name")].map(
      (name) => name.textContent ?? "",
    );
  }

  it("orders two open sessions by the touched time their own stores project", async () => {
    const { container } = renderSurface(
      contextWith({
        openStores: [
          storeHolding({ sessionId: "session-older", touchedAtIso: "2026-01-01T09:00:00.000Z" }),
          storeHolding({ sessionId: "session-newer", touchedAtIso: "2026-01-01T11:00:00.000Z" }),
        ],
      }),
    );
    await settle();

    // Newest first, and the stores are handed over oldest-first so insertion order
    // cannot be what produced this.
    expect(listedSessionIds(container)).toStrictEqual(["session-newer", "session-older"]);
  });

  it("carries an open session's participants onto its row", async () => {
    const { container } = renderSurface(
      contextWith({
        openStores: [
          storeHolding({
            sessionId: "session-a",
            participantIds: ["participant-mira", "participant-tomas"],
          }),
        ],
      }),
    );
    await settle();

    const participants = container.querySelector(".meridian-session-row__participants");
    expect(participants?.textContent).toContain("participant-mira");
    expect(participants?.textContent).toContain("participant-tomas");
  });

  it("leaves a directory-only session as its directory row", async () => {
    // The other side of the same merge: a session on the node that this window has
    // not opened has no projection, and must not borrow the open session's people.
    const { container } = renderSurface(
      contextWith({
        directorySessionIds: ["session-elsewhere"],
        openStores: [
          storeHolding({ sessionId: "session-a", participantIds: ["participant-mira"] }),
        ],
      }),
    );
    await settle();

    expect(listedSessionIds(container)).toContain("session-elsewhere");
    expect(container.querySelectorAll(".meridian-session-row__participants")).toHaveLength(1);
  });

  it("negative control: the route-scoped store contributes nothing here", async () => {
    // This address opens no store, so a list that read `context.sessionStore` read
    // `undefined` forever. Supplying one and finding none of it on screen is what
    // proves the source moved to the registry rather than merely being widened.
    const { container } = renderSurface(
      contextWith({
        directorySessionIds: [],
        sessionStore: storeHolding({
          sessionId: "session-route",
          participantIds: ["participant-route"],
        }),
      }),
    );
    await settle();

    expect(listedSessionIds(container)).toStrictEqual([]);
    expect(container.textContent ?? "").not.toContain("participant-route");
  });

  it("negative control: the same store reached through the registry is listed", async () => {
    // Without this, the case above would pass over a list that had stopped reading
    // any store at all.
    const { container } = renderSurface(
      contextWith({
        directorySessionIds: [],
        openStores: [
          storeHolding({ sessionId: "session-route", participantIds: ["participant-route"] }),
        ],
      }),
    );
    await settle();

    expect(listedSessionIds(container)).toStrictEqual(["session-route"]);
    expect(container.textContent ?? "").toContain("participant-route");
  });
});

describe("starting a session is an act", () => {
  it("mounts nothing that could create a session until the control is pressed", () => {
    const { container } = renderSurface(contextWith({}));
    expect(container.querySelector(".meridian-sessions__started")).toBeNull();
  });

  it("offers exactly one start control, and it is reachable", async () => {
    const { container } = renderSurface(contextWith({}));
    await settle();
    const controls = container.querySelectorAll(".meridian-sessions__start");
    expect(controls).toHaveLength(1);
    expect(controls[0]?.tagName).toBe("BUTTON");
  });

  it("mounts the probe on the press, and remounts it on the next one", async () => {
    const { container } = renderSurface(contextWith({}));
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
    const { container } = renderSurface(contextWith({}));
    await settle();
    act(() => {
      container.querySelector<HTMLButtonElement>(".meridian-sessions__start")?.click();
    });
    expect(container.textContent ?? "").toContain("running on the fixture");
  });
});

describe("while the shell cannot be written to", () => {
  /** The block the store derives for one supervisor state, so no sentence is retyped. */
  function blockDetailFor(connection: ShellConnection): string {
    const block = shellMutationBlock({ ...UNREPORTED_SHELL_STATE, connection });
    if (block === undefined) {
      throw new Error(`the store derives no block for ${connection.kind}`);
    }
    return block.detail;
  }

  it("puts no session start, and names the shell's own cause", async () => {
    // The defect: the block reached the palette as explanatory text while this
    // destination's controls stayed live, so a window that had been told the runtime
    // was gone still dispatched `session.create` from the probe's mount effect.
    const { container } = renderSurface(
      contextWith({
        shellConnection: { kind: "offline", attemptLimit: 5, lastError: undefined },
      }),
    );
    await settle();

    const start = container.querySelector<HTMLButtonElement>(".meridian-sessions__start");
    expect(start?.disabled).toBe(true);
    act(() => {
      start?.click();
    });
    expect(container.querySelector(".meridian-sessions__started")).toBeNull();
    // The store's own sentence, read back from the store rather than retyped here:
    // a control naming a cause this file invented would be the second copy of the
    // rule the fix exists to avoid.
    expect(container.textContent ?? "").toContain(
      blockDetailFor({ kind: "offline", attemptLimit: 5, lastError: undefined }),
    );
  });

  it("closes the join form on the same cause", async () => {
    const { container } = renderSurface(
      contextWith({ shellConnection: { kind: "version-incompatible" } }),
    );
    await settle();
    act(() => {
      container.querySelector<HTMLButtonElement>(".meridian-session-acts__secondary")?.click();
    });

    const join = container.querySelector<HTMLButtonElement>(".meridian-session-join__submit");
    expect(join?.disabled).toBe(true);
    expect(container.textContent ?? "").toContain(blockDetailFor({ kind: "version-incompatible" }));
  });

  it("blocks a deliberate shutdown too, and says so as a shutdown", async () => {
    // `stopped` is not a failure and does not read as one, but nothing can be sent to
    // a runtime somebody turned off — so the act is closed and the sentence is its own.
    const { container } = renderSurface(contextWith({ shellConnection: { kind: "stopped" } }));
    await settle();
    expect(container.querySelector<HTMLButtonElement>(".meridian-sessions__start")?.disabled).toBe(
      true,
    );
    expect(container.textContent ?? "").toContain(blockDetailFor({ kind: "stopped" }));
  });

  it("starts a session while the shell is connected — the control", async () => {
    // Without this the case above passes for a surface that disabled the control for
    // every shell state, including the healthy one.
    const { container } = renderSurface(contextWith({ shellConnection: { kind: "connected" } }));
    await settle();
    const start = container.querySelector<HTMLButtonElement>(".meridian-sessions__start");
    expect(start?.disabled).toBe(false);
    act(() => {
      start?.click();
    });
    expect(container.querySelector(".meridian-sessions__started")).not.toBeNull();
  });
});
