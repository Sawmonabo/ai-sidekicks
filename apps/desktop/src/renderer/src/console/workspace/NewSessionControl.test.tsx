// "+ New", and the draft nobody could reach.
//
// `NewSessionDraft` shipped with a co-located test and no consumer: every act it
// holds — compose, discard, send — was reachable from a test file and from nowhere
// a person could press. These cases drive the control instead of the class, so what
// they assert is that the acts are reachable, in that order, through the screen.
//
// The send case is the load-bearing one. Exactly one of the three calls the draft's
// coalesced send names is registered, so a real send lands `session.create` and then
// says what it could not do. A control that reported that as a plain success would
// be describing a session with no sidekicks and no first turn as a finished one.
//
// And because that partial leaves the draft on screen with Send still pressable,
// the last case here is the affordance half of the double-press guard: Send is
// disabled from the press until the send settles. The structural half lives in the
// draft and is asserted where it lives — this file asserts only what the screen
// does, which is what a person can actually observe.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { withDaemonCall } from "../bridge/fixture-bridge.test-support.js";
import type { ConsoleScenario } from "../bridge/scenario.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import { NewSessionControl } from "./NewSessionControl.js";

const CREATED_SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5ac0de";

/**
 * The WHOLE registered create response.
 *
 * Whole, because the fixture bridge parses a scripted reply against the method's own
 * shape and refuses one that is short of it — a partial script would have been a
 * console tested against a reply the daemon cannot send. Named once, so the scripted
 * arm and the two suspended arms below settle on the same thing.
 */
const CREATE_REPLY = {
  sessionId: CREATED_SESSION_ID,
  state: "active",
  memberships: [],
  channels: [],
} as const;

/**
 * A bridge whose `session.create` answers, or one whose does not.
 *
 * The fixture bridge rather than a hand-written stub: the draft calls through
 * `bridge.sidekicks.daemon.call`, and a stub of that member would be a second
 * implementation of the one door this family's tests already have.
 */
function bridgeFor(options: { readonly scriptsCreate: boolean }): ConsoleBridge {
  const scenario: ConsoleScenario = {
    id: "new-session-control",
    label: "New session control",
    purpose: "Drives the composed-draft control's one reachable wire call.",
    sessionId: "session-draft",
    participantIdsInJoinOrder: ["participant-you"],
    startedAtIso: "2026-01-01T09:00:00.000Z",
    beats: [],
    replies: options.scriptsCreate
      ? [
          {
            call: "session.create",
            result: CREATE_REPLY,
          },
        ]
      : [],
  };
  return createFixtureBridge({ scenario });
}

/** The control under the window's announcer, which is where the frame mounts it. */
function renderControlOn(bridge: ConsoleBridge): HTMLElement {
  const { container } = render(
    <LiveAnnouncerProvider>
      <NewSessionControl bridge={bridge} />
    </LiveAnnouncerProvider>,
  );
  return container;
}

function renderControl(options: { readonly scriptsCreate: boolean }): HTMLElement {
  return renderControlOn(bridgeFor(options));
}

/** A bridge whose `session.create` is held open, and the handle that lets it answer. */
interface HeldCreate {
  readonly bridge: ConsoleBridge;
  /** Lets the held `session.create` settle on the registered reply. */
  readonly answer: () => void;
}

/**
 * The fixture bridge with its `session.create` suspended until told to answer.
 *
 * A send that resolves within the same microtask cannot be observed mid-flight, and
 * "Send is disabled while a send is running" is a claim about exactly that moment.
 * Only the TIMING is the test's: what settles is `CREATE_REPLY`, the same whole
 * registered response every other case here reads.
 *
 * Through `withDaemonCall` rather than a spread written here, because a test reaches
 * `daemon.call` on the same terms production does — `daemon-reply-chokepoint` scans
 * source text and does not care which tier wrote it — and one shared arm is what
 * keeps every suite driving the same door.
 */
function bridgeHoldingCreate(): HeldCreate {
  let answer = (): void => {};
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const { bridge } = withDaemonCall(bridgeFor({ scriptsCreate: true }), async () => {
    await held;
    return CREATE_REPLY;
  });
  return { bridge, answer };
}

/** Several suspended creates at once, and the handle that answers them in order. */
interface QueuedCreates {
  readonly bridge: ConsoleBridge;
  /** Lets the OLDEST still-suspended create proceed to the fixture's reply. */
  readonly answerOldest: () => void;
  readonly pendingCount: () => number;
}

/**
 * The fixture bridge with every `session.create` suspended, answerable one at a time.
 *
 * {@link bridgeHoldingCreate} holds them all behind one promise, which cannot show
 * what happens when an OLD draft's send settles while a new one is still running —
 * the case where a shared flag and an unguarded continuation do their damage. Every
 * reply is still `CREATE_REPLY`; only their order is the test's.
 */
function bridgeQueueingCreates(): QueuedCreates {
  const suspended: (() => void)[] = [];
  const { bridge } = withDaemonCall(bridgeFor({ scriptsCreate: true }), async () => {
    await new Promise<void>((resolve) => {
      suspended.push(resolve);
    });
    return CREATE_REPLY;
  });
  return {
    bridge,
    answerOldest: () => {
      suspended.shift()?.();
    },
    pendingCount: () => suspended.length,
  };
}

/**
 * Press a control and let React finish reacting.
 *
 * Unwrapped, an assertion would read a tree one render behind — and the send case
 * would additionally resolve its promise outside `act`, so the announcement it is
 * about would arrive after the assertion that reads for it.
 */
async function press(name: string | RegExp): Promise<void> {
  await act(async () => {
    screen.getByRole("button", { name }).click();
    await Promise.resolve();
  });
}

function politeText(container: HTMLElement): string {
  return container.querySelector('[data-live-region="polite"]')?.textContent ?? "";
}

/** Open a draft and choose a posture — the shortest composition that can be sent. */
async function openDraftWithPosture(): Promise<void> {
  await press("+ New");
  await act(async () => {
    screen.getByRole("radio", { name: "Trusted" }).click();
    await Promise.resolve();
  });
}

describe("the composed new-session draft — reachable, and only on an act", () => {
  afterEach(cleanup);

  it("offers one control and composes no draft until it is pressed", () => {
    const container = renderControl({ scriptsCreate: true });

    expect(screen.getByRole("button", { name: "+ New" })).toBeDefined();
    // No posture picker on screen means no draft was constructed. A control that
    // built one on mount would make visiting the sessions list compose a session,
    // which is the defect this destination's own probe was moved off.
    expect(screen.queryByRole("group", { name: "How its agents may work" })).toBeNull();
    expect(container.querySelector(".meridian-new-session")).toBeNull();
  });

  it("opens the draft on the press, with the posture axis the definitions declare", async () => {
    renderControl({ scriptsCreate: true });
    await press("+ New");

    expect(screen.getByRole("radio", { name: "Trusted" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "Sandboxed to the workspace" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "Sandboxed, read-only" })).toBeDefined();
    // Nothing is chosen yet, so there is nothing to send. The draft's own
    // `isEmpty` is what disables it — the control does not keep a second opinion.
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
  });

  it("takes a posture, which is what makes the draft sendable", async () => {
    renderControl({ scriptsCreate: true });
    await press("+ New");
    await act(async () => {
      screen.getByRole("radio", { name: "Trusted" }).click();
      await Promise.resolve();
    });

    expect((screen.getByRole("radio", { name: "Trusted" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
  });

  it("discards to nothing, leaving no draft and no chosen posture behind", async () => {
    const container = renderControl({ scriptsCreate: true });
    await press("+ New");
    await act(async () => {
      screen.getByRole("radio", { name: "Trusted" }).click();
      await Promise.resolve();
    });
    await press("Discard");

    // Back to the one control, and re-opening starts empty: `new-session-draft.ts`'s
    // "a draft that is closed empty reverts to nothing and leaves no row" is a claim
    // about what a discard leaves, so the case that matters is the state the NEXT draft
    // is in.
    expect(container.querySelector(".meridian-new-session")).toBeNull();
    await press("+ New");
    expect((screen.getByRole("radio", { name: "Trusted" }) as HTMLInputElement).checked).toBe(
      false,
    );
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
  });

  it("sends through the registered create verb and reports what it could not do", async () => {
    const container = renderControl({ scriptsCreate: true });
    await press("+ New");
    await act(async () => {
      screen.getByRole("radio", { name: "Trusted" }).click();
      await Promise.resolve();
    });
    await press("Send");

    // The session exists — `session.create` is the one call of the three that is
    // registered — and the other two are named rather than silently skipped.
    expect(container.textContent).toContain("wire-unregistered");
    // Named apart rather than joined, because they are unsendable for different
    // reasons: one has no registered shape at all, and the other has a shape and no
    // first turn to put in it.
    expect(container.textContent).toContain("agent.attach");
    expect(container.textContent).toContain("run.queueCreate");
    // Said once, in the announcer, in the vocabulary of what happened rather than
    // in the wire's.
    expect(politeText(container)).toBe(
      "The session was created, but not everything the draft asked for could be sent.",
    );
    // The draft stays on screen: a partial send is reported, never rolled back, so
    // there is something to correct rather than a form that vanished.
    expect(container.querySelector(".meridian-new-session")).not.toBeNull();
  });

  it("says nothing was sent when the create call itself refuses", async () => {
    const container = renderControl({ scriptsCreate: false });
    await press("+ New");
    await act(async () => {
      screen.getByRole("radio", { name: "Trusted" }).click();
      await Promise.resolve();
    });
    await press("Send");

    expect(container.textContent).toContain("session-create-failed");
    expect(politeText(container)).toBe("Nothing was sent, and the draft is still here.");
  });

  it("disables Send while a send is in flight, and re-enables it afterwards", async () => {
    const held = bridgeHoldingCreate();
    const container = renderControlOn(held.bridge);
    await press("+ New");
    await act(async () => {
      screen.getByRole("radio", { name: "Trusted" }).click();
      await Promise.resolve();
    });

    // The window a double-click lands in: the create is suspended, so this is what
    // the screen looks like while a person's second press would arrive.
    await press("Send");
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);

    await act(async () => {
      held.answer();
      await Promise.resolve();
    });

    // ...and pressable again once it settles, because the partial leaves a draft the
    // person may still correct. A flag that never cleared would be a control frozen
    // by its own guard.
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
    expect(container.textContent).toContain("wire-unregistered");
  });

  it("drops a discarded draft's settlement rather than showing it under its replacement", async () => {
    // The defect: the continuation wrote its result into whatever composition was on
    // screen when it settled. Discard is reachable while a send is in flight and
    // "+ New" is reachable the moment it is, so a person who discarded and started
    // again was shown a refusal for a session THIS draft never sent.
    const queued = bridgeQueueingCreates();
    const container = renderControlOn(queued.bridge);
    await openDraftWithPosture();
    await press("Send");

    await press("Discard");
    await openDraftWithPosture();
    await act(async () => {
      queued.answerOldest();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("wire-unregistered");
    expect(politeText(container)).toBe("");
    // The replacement is untouched and still sendable — nothing about the old send
    // reached it, including its sending flag.
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
  });

  it("keeps Send disabled when an older draft's send settles under a newer one", async () => {
    // The second half of the same defect. One boolean over two drafts is cleared by
    // whichever send settles first, so the older one's `finally` re-enabled Send under
    // a composition whose own create was still in flight.
    const queued = bridgeQueueingCreates();
    const container = renderControlOn(queued.bridge);
    await openDraftWithPosture();
    await press("Send");
    await press("Discard");
    await openDraftWithPosture();
    await press("Send");
    expect(queued.pendingCount()).toBe(2);

    await act(async () => {
      queued.answerOldest();
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    expect(container.textContent).not.toContain("wire-unregistered");

    await act(async () => {
      queued.answerOldest();
      await Promise.resolve();
    });

    // The newer draft's own settlement is the one that lands.
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
    expect(container.textContent).toContain("wire-unregistered");
  });

  it("negative control: a settlement for the draft still on screen is rendered", async () => {
    // Without this, a control that dropped EVERY settlement would pass both cases
    // above — and no send would ever report anything.
    const queued = bridgeQueueingCreates();
    const container = renderControlOn(queued.bridge);
    await openDraftWithPosture();
    await press("Send");

    await act(async () => {
      queued.answerOldest();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("wire-unregistered");
    expect(politeText(container)).toBe(
      "The session was created, but not everything the draft asked for could be sent.",
    );
  });

  // The negative control: without it, a control whose Send button was wired to
  // nothing would satisfy every case above that only reads the opened panel — the
  // refusal text and the announcement are the only evidence a send happened at all.
  it("negative control: an unsent draft carries neither refusal nor announcement", async () => {
    const container = renderControl({ scriptsCreate: true });
    await press("+ New");
    await act(async () => {
      screen.getByRole("radio", { name: "Trusted" }).click();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("wire-unregistered");
    expect(container.textContent).not.toContain("session-create-failed");
    expect(politeText(container)).toBe("");
  });
});
