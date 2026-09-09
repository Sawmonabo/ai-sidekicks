// WHICH composition a settlement lands in, and which bridge a draft belongs to.
//
// Split from `NewSessionControl.test.tsx`, which is about the acts being reachable at
// all. Every case here is about ADDRESSING: discard is reachable while a send is in
// flight and "+ New" is reachable the moment it is, so a continuation that wrote its
// result into whatever composition was on screen when it settled would show an older
// draft's refusal under a newer one — and a control that held its draft on nothing
// would keep sending through a bridge that has been replaced.
//
// AND THE SAME QUESTION ASKED OF ONE DRAFT RATHER THAN TWO: a completed send closes the
// content it SENT, and a draft the person has typed into since is not that content. The
// second describe holds that pair — the revision the settlement is measured against, and
// the read-only field that keeps the window it lives in as narrow as a frame.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { type ConsoleBridge } from "../../bridge/index.js";
import { withDaemonCall } from "../../bridge/fixture/call-plane/bridge.test-support.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { NewSessionControl } from "./NewSessionControl.js";
import { CREATED_SESSION_ID } from "./new-session-draft.test-support.js";
import {
  CREATE_REPLY,
  NOTHING_BLOCKS_THE_ACT,
  bridgeFor,
  bridgeHoldingCreate,
  bridgeQueueingCreates,
  openDraftWithFirstTurn,
  politeText,
  press,
  renderControl,
  renderControlOn,
  typeFirstTurn,
} from "./NewSessionControl.test-support.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";

describe("the composed new-session draft — which composition a settlement lands in", () => {
  it("drops a discarded draft's settlement rather than showing it under its replacement", async () => {
    // The defect: the continuation wrote its result into whatever composition was on
    // screen when it settled. Discard is reachable while a send is in flight and
    // "+ New" is reachable the moment it is, so a person who discarded and started
    // again was shown a refusal for a session THIS draft never sent.
    const queued = bridgeQueueingCreates();
    const container = renderControlOn(queued.bridge);
    await openDraftWithFirstTurn();
    await press("Send");

    await press("Discard");
    await openDraftWithFirstTurn();
    await act(async () => {
      queued.answerOldest();
      await crossMacrotaskBoundary();
    });

    expect(container.textContent).not.toContain("first-turn-failed");
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
    await openDraftWithFirstTurn();
    await press("Send");
    await press("Discard");
    await openDraftWithFirstTurn();
    await press("Send");
    expect(queued.pendingCount()).toBe(2);

    await act(async () => {
      queued.answerOldest();
      await crossMacrotaskBoundary();
    });

    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    expect(container.textContent).not.toContain("first-turn-failed");

    await act(async () => {
      queued.answerOldest();
      await crossMacrotaskBoundary();
    });

    // The newer draft's own settlement is the one that lands.
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
    expect(container.textContent).toContain("first-turn-failed");
  });

  it("negative control: a settlement for the draft still on screen is rendered", async () => {
    // Without this, a control that dropped EVERY settlement would pass both cases
    // above — and no send would ever report anything.
    const queued = bridgeQueueingCreates();
    const container = renderControlOn(queued.bridge);
    await openDraftWithFirstTurn();
    await press("Send");

    await act(async () => {
      queued.answerOldest();
      await crossMacrotaskBoundary();
    });

    expect(container.textContent).toContain("first-turn-failed");
    expect(politeText(container)).toBe(
      "The session was created, but not everything the draft asked for could be sent.",
    );
  });

  // The negative control: without it, a control whose Send button was wired to
  // nothing would satisfy every case above that only reads the opened panel — the
  // refusal text and the announcement are the only evidence a send happened at all.
  it("negative control: an unsent draft carries neither refusal nor announcement", async () => {
    const container = renderControl({ scriptsCreate: true });
    await openDraftWithFirstTurn();

    expect(container.textContent).not.toContain("first-turn-failed");
    expect(container.textContent).not.toContain("session-create-failed");
    expect(politeText(container)).toBe("");
  });
});

describe("the composed new-session draft — the composition a completed send closes", () => {
  afterEach(cleanup);

  it("keeps words typed after the press rather than closing the draft over them", async () => {
    // The defect: a completed send published `undefined` over whatever draft was on
    // screen. `#performSend` captured the first message when it read the draft, so text
    // typed while the create was in flight was never sent — and the settlement then
    // threw away the only copy of it. The send is slow here because that is the whole
    // window the defect lives in.
    const settledSessionIds: string[] = [];
    const held = bridgeHoldingCreate({ scriptsFirstTurn: true });
    const container = renderControlOn(held.bridge, (sessionId) =>
      settledSessionIds.push(sessionId),
    );
    await openDraftWithFirstTurn();
    await press("Send");
    // The frame between the press and the render that closes the field: the control
    // publishes its sending flag inside the click handler, so a person typing into a
    // field that is already read-only cannot reach this — a keyboard path, an input
    // method, or a caller arriving before that render can.
    await typeFirstTurn("Start on the migration, and read the changelog first.");

    await act(async () => {
      held.answer();
      await crossMacrotaskBoundary();
    });

    expect(container.querySelector(".meridian-new-session")).not.toBeNull();
    expect((screen.getByLabelText("Its first message") as HTMLTextAreaElement).value).toBe(
      "Start on the migration, and read the changelog first.",
    );
    // And the person is told, rather than left to notice: the session exists, and the
    // words in front of them are not in it.
    expect(container.textContent).toContain(
      "What you typed after pressing Send was not sent, and it is still here.",
    );
    expect(politeText(container)).toBe(
      "The session was created. What you typed after pressing Send was not sent, and it is still here.",
    );
    // Nothing more can be put on the wire from this draft — every leg it names landed —
    // so Send is closed rather than left to report the same session again.
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    // Not settled either: the settlement navigates, and it would take the sentence above
    // and the unsent words off the screen with it.
    expect(settledSessionIds).toStrictEqual([]);
  });

  it("closes the field while the send runs, without taking focus off it", async () => {
    // The structural half is the revision above; this is the affordance half, and it is
    // `readOnly` rather than `disabled` on purpose — a disabled control loses focus, so
    // a person typing when the press landed would find their place gone.
    const held = bridgeHoldingCreate({ scriptsFirstTurn: true });
    renderControlOn(held.bridge);
    await openDraftWithFirstTurn();
    await press("Send");

    const field = screen.getByLabelText("Its first message") as HTMLTextAreaElement;
    expect(field.readOnly).toBe(true);
    expect(field.hasAttribute("disabled")).toBe(false);
    expect(field.title).toContain("being sent");

    await act(async () => {
      held.answer();
      await crossMacrotaskBoundary();
    });
  });

  it("negative control: a send nobody edited closes its draft and hands the session out", async () => {
    // Without this, a control that never closed a draft at all would pass the case
    // above — and every completed send would leave a form standing over a session the
    // console had already started.
    const settledSessionIds: string[] = [];
    const held = bridgeHoldingCreate({ scriptsFirstTurn: true });
    const container = renderControlOn(held.bridge, (sessionId) =>
      settledSessionIds.push(sessionId),
    );
    await openDraftWithFirstTurn();
    await press("Send");

    await act(async () => {
      held.answer();
      await crossMacrotaskBoundary();
    });

    expect(container.querySelector(".meridian-new-session")).toBeNull();
    expect(settledSessionIds).toStrictEqual([CREATED_SESSION_ID]);
    expect(politeText(container)).toBe("The session was created.");
  });
});

/**
 * The settlement these cases hand over, which records nothing.
 *
 * Every case in this describe is about which BRIDGE a draft sends through, and none of
 * them completes a send — only `session.create` is scripted, so each settles partial
 * and the settlement arm is never reached. Declared once so the three mounts hand over
 * one identity, which is the shape the destination does not: a settlement whose
 * identity moved every pass is exactly what the control's committed reference exists to
 * be correct under, and that property is asserted in `NewSessionControl.test.tsx`.
 */
function recordNothing(): void {
  return undefined;
}

/** The fixture bridge, plus a count of the creates that actually reached it. */
function bridgeCountingCreates(): {
  readonly bridge: ConsoleBridge;
  readonly createCount: () => number;
} {
  let creates = 0;
  // Scoped to the create by name: a composed draft's send makes the turn's call too,
  // and an arm that counted every call would report one send as two creates — and
  // would answer `run.queueCreate` with a reply the create's own schema shapes.
  const { bridge } = withDaemonCall(
    bridgeFor({ scriptsCreate: true }),
    async (call, passThrough) => {
      if (call.method !== "session.create") {
        return await passThrough();
      }
      creates += 1;
      return CREATE_REPLY;
    },
  );
  return { bridge, createCount: () => creates };
}

describe("the composed new-session draft — the transport it would send through", () => {
  afterEach(cleanup);

  it("drops the draft when the bridge is replaced, and sends nothing through the retired one", async () => {
    // A draft holds the bridge it was composed against and sends `session.create`
    // through that one, so a reconnect leaves it addressed to a transport that is
    // gone: the send would either never land or land on a connection this console
    // will not read again, and the id it reported back would name a session nobody
    // can open. The draft goes with the transport, and "+ New" comes back.
    const retired = bridgeCountingCreates();
    const live = bridgeCountingCreates();
    const { rerender } = render(
      <LiveAnnouncerProvider>
        <NewSessionControl
          bridge={retired.bridge}
          blockedAct={NOTHING_BLOCKS_THE_ACT}
          onSessionCreated={recordNothing}
          onSessionDirectoryRecheck={recordNothing}
        />
      </LiveAnnouncerProvider>,
    );
    await openDraftWithFirstTurn();

    rerender(
      <LiveAnnouncerProvider>
        <NewSessionControl
          bridge={live.bridge}
          blockedAct={NOTHING_BLOCKS_THE_ACT}
          onSessionCreated={recordNothing}
          onSessionDirectoryRecheck={recordNothing}
        />
      </LiveAnnouncerProvider>,
    );

    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.getByRole("button", { name: "+ New" })).toBeDefined();

    await openDraftWithFirstTurn();
    await press("Send");

    expect(live.createCount()).toBe(1);
    expect(retired.createCount()).toBe(0);
  });

  it("negative control: with no replacement, the same composition reaches its own bridge", async () => {
    // Without this, the case above would pass over a control whose Send reached no
    // bridge at all, and "never the retired one" would be true of every bridge.
    const composed = bridgeCountingCreates();
    render(
      <LiveAnnouncerProvider>
        <NewSessionControl
          bridge={composed.bridge}
          blockedAct={NOTHING_BLOCKS_THE_ACT}
          onSessionCreated={recordNothing}
          onSessionDirectoryRecheck={recordNothing}
        />
      </LiveAnnouncerProvider>,
    );
    await openDraftWithFirstTurn();
    await press("Send");

    expect(composed.createCount()).toBe(1);
  });
});
