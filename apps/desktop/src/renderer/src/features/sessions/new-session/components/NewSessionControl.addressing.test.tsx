// Which composition a settlement lands in, and which bridge a draft belongs to. Discard and
// "+ New" are reachable while a send is in flight, so a continuation that wrote into
// whatever composition was on screen would show an older draft's refusal under a newer one,
// and a draft held on nothing would keep sending through a replaced bridge. The second
// describe asks the same of one draft: a completed send closes the content it sent, not text
// typed since.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { type PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import { withDaemonCall } from "#test/helpers/fixture/bridge.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { NewSessionControl } from "./NewSessionControl.js";
import {
  CREATE_REPLY,
  CREATED_SESSION_ID,
  NEW_SESSION_LEAD,
  bridgeFor,
} from "../new-session-draft.test-support.js";
import { SESSION_CREATE_METHOD } from "../settlement.js";
import {
  REJECTING_FIRST_TURN,
  bridgeHoldingCreate,
  bridgeQueueingCreates,
  completingFirstTurn,
  openDraftWithFirstTurn,
  politeText,
  press,
  renderControlOn,
  typeFirstTurn,
} from "./NewSessionControl.test-support.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";

describe("the composed new-session draft — which composition a settlement lands in", () => {
  it("drops a discarded draft's settlement rather than show it under its replacement", async () => {
    // A settlement lands only in the composition it was sent for, so a person who discarded and
    // started again never sees a refusal for a session this draft never sent.
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

    expect(container.textContent).not.toContain(
      "The session was created, but the first turn was not queued.",
    );
    expect(politeText(container)).toBe("");
    // The replacement is untouched and still sendable, including its sending flag.
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
  });

  it("keeps Send disabled when an older draft's send settles under a newer one", async () => {
    // One boolean over two drafts was cleared by whichever send settled first, re-enabling
    // Send under a composition whose own create was still in flight.
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
    expect(container.textContent).not.toContain(
      "The session was created, but the first turn was not queued.",
    );

    await act(async () => {
      queued.answerOldest();
      await crossMacrotaskBoundary();
    });

    // The newer draft's own settlement is the one that lands.
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
    expect(container.textContent).toContain(
      "The session was created, but the first turn was not queued.",
    );
  });

  it("negative control: a settlement for the draft still on screen is rendered", async () => {
    // Without this, a control that dropped every settlement would pass both cases above.
    const queued = bridgeQueueingCreates();
    const container = renderControlOn(queued.bridge);
    await openDraftWithFirstTurn();
    await press("Send");

    await act(async () => {
      queued.answerOldest();
      await crossMacrotaskBoundary();
    });

    expect(container.textContent).toContain(
      "The session was created, but the first turn was not queued.",
    );
    expect(politeText(container)).toBe(
      "The session was created, but not everything the draft asked for could be sent.",
    );
  });
});

describe("the composed new-session draft — the composition a completed send closes", () => {
  afterEach(cleanup);

  it("keeps words typed after the press rather than closing the draft over them", async () => {
    // The send captured the first message when it read the draft, so text typed while the
    // create was in flight was not sent, and closing the draft would throw away the only copy.
    // The send is slow here because that window is the one under test.
    const settledSessionIds: string[] = [];
    const held = bridgeHoldingCreate();
    const container = renderControlOn(held.bridge, {
      onSessionCreated: (sessionId) => settledSessionIds.push(sessionId),
      queueFirstTurn: completingFirstTurn().call,
    });
    await openDraftWithFirstTurn();
    await press("Send");
    // The frame between the press and the render that closes the field: the sending flag is
    // published inside the click handler, so only a keyboard path, an input method or a caller
    // arriving before that render can type here.
    await typeFirstTurn("Start on the migration, and read the changelog first.");

    await act(async () => {
      held.answer();
      await crossMacrotaskBoundary();
    });

    expect(container.querySelector(".meridian-new-session")).not.toBeNull();
    expect((screen.getByLabelText("Its first message") as HTMLTextAreaElement).value).toBe(
      "Start on the migration, and read the changelog first.",
    );
    // The person is told the session exists and the words in front of them are not in it.
    expect(container.textContent).toContain(
      "What you typed after pressing Send was not sent, and it is still here.",
    );
    expect(politeText(container)).toBe(
      "The session was created. What you typed after pressing Send was " +
        "not sent, and it is still here.",
    );
    // Every leg it names landed, so Send is closed rather than left to report the session again.
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    // Not settled either: settling navigates and would take the sentence and the words away.
    expect(settledSessionIds).toStrictEqual([]);
  });

  it("negative control: an unedited send closes its draft and hands the session out", async () => {
    // Without this, a control that never closed a draft would pass the case above and leave a
    // form standing over a session the app had already started.
    const settledSessionIds: string[] = [];
    const held = bridgeHoldingCreate();
    const container = renderControlOn(held.bridge, {
      onSessionCreated: (sessionId) => settledSessionIds.push(sessionId),
      queueFirstTurn: completingFirstTurn().call,
    });
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
 * The settlement these cases hand over, which records nothing. None of them completes a send
 * (only `session.create` is scripted, so each settles partial).
 */
function recordNothing(): void {
  return undefined;
}

/** The fixture bridge, plus a count of the creates that actually reached it. */
function bridgeCountingCreates(): {
  readonly bridge: PlatformBridge;
  readonly createCount: () => number;
} {
  let creates = 0;
  // Scoped to the create by name, so any other call reaches the fixture's own answer.
  const { bridge } = withDaemonCall(
    bridgeFor({ scriptsCreate: true }),
    async (call, passThrough) => {
      if (call.method !== SESSION_CREATE_METHOD) {
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

  it("drops the draft when the bridge is replaced, and sends nothing via the old one", async () => {
    // A reconnect leaves a draft addressed to a retired transport, where its send would never
    // land or would name a session nobody can open. The draft goes with the transport and
    // "+ New" comes back.
    const retired = bridgeCountingCreates();
    const live = bridgeCountingCreates();
    const { rerender } = render(
      <LiveAnnouncerProvider>
        <NewSessionControl
          bridge={retired.bridge}
          queueFirstTurn={REJECTING_FIRST_TURN}
          lead={NEW_SESSION_LEAD}
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
          queueFirstTurn={REJECTING_FIRST_TURN}
          lead={NEW_SESSION_LEAD}
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

  it("negative control: unreplaced, the same composition reaches its own bridge", async () => {
    // Without this, the case above would pass over a Send that reached no bridge at all.
    const composed = bridgeCountingCreates();
    render(
      <LiveAnnouncerProvider>
        <NewSessionControl
          bridge={composed.bridge}
          queueFirstTurn={REJECTING_FIRST_TURN}
          lead={NEW_SESSION_LEAD}
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
