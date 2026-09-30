// "+ New" and the draft behind it. These cases drive the control rather than the class, so
// they assert that compose, discard and send are reachable through the screen.
//
// The send case is load-bearing: the first-turn call is unscripted, so a real send lands
// `session.create` and then says what it could not do, and a control that reported a plain
// success would describe a session with no first turn as finished. Because that partial
// leaves Send pressable, the last case here is the affordance half of the double-press guard
// (the structural half lives in the draft).
//
// The third describe covers what a completed send hands out; the first-turn call resolves
// there, since everywhere else it rejects and every send settles partial. The last describe
// pins an axis that is not offered, which nothing else here would notice returning.
//
// Which composition a settlement lands in, and which bridge a draft belongs to, is
// `NewSessionControl.addressing.test.tsx`.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { NewSessionControl } from "./NewSessionControl.js";
import { CREATED_SESSION_ID, NEW_SESSION_LEAD } from "../new-session-draft.test-support.js";
import {
  bridgeAnsweringCreateUnreadably,
  bridgeFor,
  bridgeHoldingCreate,
  bridgeRecordingASend,
  completingFirstTurn,
  composeAndCompleteASend,
  openDraftWithFirstTurn,
  politeText,
  press,
  renderControl,
  renderControlOn,
} from "./NewSessionControl.test-support.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";

/** The directory re-read no case in this file presses. */
const recordNoRecheck = (): void => undefined;

describe("the composed new-session draft — reachable, and only on an act", () => {
  afterEach(cleanup);

  it("offers one control and composes no draft until it is pressed", () => {
    const container = renderControl({ scriptsCreate: true });

    expect(screen.getByRole("button", { name: "+ New" })).toBeDefined();
    // No first-message field means no draft was built; building one on mount would compose a
    // session whenever the sessions list is visited.
    expect(screen.queryByLabelText("Its first message")).toBeNull();
    expect(container.querySelector(".meridian-new-session")).toBeNull();
  });

  it("opens the draft on the press, with the one axis it offers", async () => {
    renderControl({ scriptsCreate: true });
    await press("+ New");

    expect(screen.getByLabelText("Its first message")).toBeDefined();
    // Nothing is typed, so the draft's own `isEmpty` disables Send; the control keeps no
    // second opinion.
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
  });

  it("takes the first message, which is what makes the draft sendable", async () => {
    renderControl({ scriptsCreate: true });
    await openDraftWithFirstTurn();

    expect((screen.getByLabelText("Its first message") as HTMLTextAreaElement).value).toBe(
      "Start on the migration.",
    );
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
  });

  it("discards to nothing, leaving no draft and no typed words behind", async () => {
    const container = renderControl({ scriptsCreate: true });
    await openDraftWithFirstTurn();
    await press("Discard");

    // Back to the one control, and re-opening starts empty: what matters is the state the next
    // draft is in.
    expect(container.querySelector(".meridian-new-session")).toBeNull();
    await press("+ New");
    expect((screen.getByLabelText("Its first message") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
  });

  it("sends through the registered create verb and reports what it could not do", async () => {
    const container = renderControl({ scriptsCreate: true });
    await openDraftWithFirstTurn();
    await press("Send");

    // The session exists and what could not follow is named. Only `session.create` is
    // scripted, so the turn's call is refused by the fixture, under a different code from a
    // refused create.
    expect(container.textContent).toContain("first-turn-failed");
    // The calls that did land are named beneath the refusal.
    expect(container.textContent).toContain("Already sent: session.create");
    // Said once in the announcer, in the vocabulary of what happened rather than the wire's.
    expect(politeText(container)).toBe(
      "The session was created, but not everything the draft asked for could be sent.",
    );
    // The draft stays on screen: a partial send is reported, never rolled back.
    expect(container.querySelector(".meridian-new-session")).not.toBeNull();
  });

  it("says nothing was sent when the create call itself refuses", async () => {
    const container = renderControl({ scriptsCreate: false });
    await openDraftWithFirstTurn();
    await press("Send");

    expect(container.textContent).toContain("session-create-failed");
    expect(politeText(container)).toBe("Nothing was sent, and the draft is still here.");
  });

  it("disables Send while a send is in flight, and re-enables it afterwards", async () => {
    const held = bridgeHoldingCreate();
    const container = renderControlOn(held.bridge);
    await openDraftWithFirstTurn();

    // The create is suspended: the window a double-click's second press would land in.
    await press("Send");
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);

    await act(async () => {
      held.answer();
      await crossMacrotaskBoundary();
    });

    // Pressable again once it settles, since the partial leaves a draft the person may
    // correct; a flag that never cleared would freeze the control.
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
    expect(container.textContent).toContain("first-turn-failed");
  });
});

describe("the composed new-session draft — what a completed send hands out", () => {
  afterEach(cleanup);

  it("names the session it made, and leaves the screen", async () => {
    // A send that fully succeeded once left this form standing with Send enabled and a real
    // session nothing above could name.
    const settledSessionIds: string[] = [];
    const container = renderControlOn(bridgeFor({ scriptsCreate: true }), {
      onSessionCreated: (sessionId) => settledSessionIds.push(sessionId),
      queueFirstTurn: completingFirstTurn().call,
    });

    await composeAndCompleteASend();

    expect(settledSessionIds).toStrictEqual([CREATED_SESSION_ID]);
    // The draft goes with the act: it can only re-report the session that already exists.
    expect(container.querySelector(".meridian-new-session")).toBeNull();
    expect(screen.getByRole("button", { name: "+ New" })).toBeDefined();
    // The sentence is still said before the settlement, which navigates.
    expect(politeText(container)).toBe("The session was created.");
  });

  it("hands nothing out for a send that stopped part way, and keeps the draft", async () => {
    // A partial made a session too, and settling would navigate away from the sentence a
    // second press acts on.
    const settledSessionIds: string[] = [];
    const container = renderControlOn(bridgeFor({ scriptsCreate: true }), {
      onSessionCreated: (sessionId) => settledSessionIds.push(sessionId),
    });

    await openDraftWithFirstTurn();
    await press("Send");

    expect(settledSessionIds).toStrictEqual([]);
    expect(container.textContent).toContain("first-turn-failed");
    expect(container.querySelector(".meridian-new-session")).not.toBeNull();
  });

  it("hands nothing out when the create itself refused, because there is no session", async () => {
    const settledSessionIds: string[] = [];
    renderControlOn(bridgeFor({ scriptsCreate: false }), {
      onSessionCreated: (sessionId) => settledSessionIds.push(sessionId),
    });

    await openDraftWithFirstTurn();
    await press("Send");

    expect(settledSessionIds).toStrictEqual([]);
  });

  it("settles once, however many times the destination re-renders under it", async () => {
    // The destination composes its settlement fresh every pass, so a control that put the
    // callback in the settling effect's dependencies would settle on every render. The count
    // says it did not follow the identity.
    const settledSessionIds: string[] = [];
    const bridge = bridgeFor({ scriptsCreate: true });
    const queueFirstTurn = completingFirstTurn().call;
    const { rerender } = render(
      <LiveAnnouncerProvider>
        <NewSessionControl
          bridge={bridge}
          queueFirstTurn={queueFirstTurn}
          lead={NEW_SESSION_LEAD}
          onSessionCreated={(sessionId) => settledSessionIds.push(sessionId)}
          onSessionDirectoryRecheck={recordNoRecheck}
        />
      </LiveAnnouncerProvider>,
    );

    await composeAndCompleteASend();
    for (let pass = 0; pass < 3; pass += 1) {
      rerender(
        <LiveAnnouncerProvider>
          <NewSessionControl
            bridge={bridge}
            queueFirstTurn={queueFirstTurn}
            lead={NEW_SESSION_LEAD}
            onSessionCreated={(sessionId) => settledSessionIds.push(sessionId)}
            onSessionDirectoryRecheck={recordNoRecheck}
          />
        </LiveAnnouncerProvider>,
      );
      await act(async () => {
        await crossMacrotaskBoundary();
      });
    }

    expect(settledSessionIds).toStrictEqual([CREATED_SESSION_ID]);
  });
});

describe("the composed new-session draft — the create it cannot answer for", () => {
  afterEach(cleanup);

  it("names the ambiguity, closes Send, and offers the sessions list instead", async () => {
    // An unreadable reply once rendered as `session-create-failed` beside a live Send, which
    // invites the press that makes a second orphan session.
    const rechecks: number[] = [];
    const container = renderControlOn(bridgeAnsweringCreateUnreadably(), {
      onSessionDirectoryRecheck: () => rechecks.push(1),
    });

    await openDraftWithFirstTurn();
    await press("Send");

    expect(container.textContent).toContain("session-create-unreadable");
    expect(container.textContent).toContain("Check the sessions list");
    // Closed, and stays closed: this draft can put nothing else on the wire.
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    // The act that is available is drawn rather than left to be guessed at.
    await press("Check the sessions list");
    expect(rechecks).toStrictEqual([1]);
    // The draft stays: a person can still read what they typed and copy it out.
    expect(container.querySelector(".meridian-new-session")).not.toBeNull();
    expect(politeText(container)).toBe(
      "A session may have been created, and this window could not read the reply. Check the sessions list.",
    );
  });

  it("negative control: no session is handed to the destination on that arm", async () => {
    // Without this, the case above would pass over a build that settled the ambiguous arm as a
    // start, for a session that may not exist and is not named.
    const settledSessionIds: string[] = [];
    renderControlOn(bridgeAnsweringCreateUnreadably(), {
      onSessionCreated: (sessionId) => settledSessionIds.push(sessionId),
    });

    await openDraftWithFirstTurn();
    await press("Send");

    expect(settledSessionIds).toStrictEqual([]);
  });
});

describe("the composed new-session draft — the axis it does not offer", () => {
  afterEach(cleanup);

  it("offers no execution-posture control, because no reachable call would carry one", async () => {
    // This control once rendered a posture picker whose value reached no wire: neither call
    // the send makes has a member for it (both requests are strict). A choice that cannot be
    // honored is not offered.
    renderControl({ scriptsCreate: true });
    await press("+ New");

    expect(screen.queryAllByRole("radio")).toStrictEqual([]);
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("negative control: nothing posture-shaped reaches the wire on the arm not taken", async () => {
    // Asserted over the request bodies, not the screen: this would go red if the picker
    // returned without a member to send it on.
    const recorded = bridgeRecordingASend();
    const firstTurns = completingFirstTurn();
    renderControlOn(recorded.bridge, { queueFirstTurn: firstTurns.call });
    await openDraftWithFirstTurn();
    await press("Send");

    // Both legs were made; otherwise the absence below would be the absence of any request.
    expect(recorded.calls.map((call) => call.method)).toStrictEqual(["session.create"]);
    expect(firstTurns.requests).toHaveLength(1);
    for (const request of [...recorded.calls.map((call) => call.params), ...firstTurns.requests]) {
      expect(JSON.stringify(request)).not.toMatch(/posture/i);
    }
  });
});
