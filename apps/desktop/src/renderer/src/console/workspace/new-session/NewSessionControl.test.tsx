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
//
// THE THIRD DESCRIBE IS THE OTHER HALF OF A SEND: what a COMPLETED one hands out.
// Both of this draft's reachable calls are scripted there, which is what makes a
// completed send reachable at all — everywhere else in this file the first turn is
// unscripted, so every send settles partial and the settlement arm is never taken.
//
// AND THE LAST DESCRIBE IS ABOUT AN AXIS THAT IS NOT HERE, which needs a case for the
// same reason an absent control always does: nothing else in this file would notice a
// picker coming back, and the defect it names was a picker whose value reached no wire.
//
// WHICH composition a settlement lands in, and which bridge a draft belongs to, is
// `NewSessionControl.addressing.test.tsx`.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { NewSessionControl } from "./NewSessionControl.js";
import {
  CREATED_SESSION_ID,
  NOTHING_BLOCKS_THE_ACT,
  bridgeAnsweringCreateUnreadably,
  bridgeFor,
  bridgeHoldingCreate,
  bridgeRecordingACompleteSend,
  composeAndCompleteASend,
  openDraftWithFirstTurn,
  politeText,
  press,
  renderControl,
  renderControlOn,
} from "./NewSessionControl.test-support.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";

/** The directory re-read no case in this file presses. Named so a render reads as one. */
const recordNoRecheck = (): void => undefined;

describe("the composed new-session draft — reachable, and only on an act", () => {
  afterEach(cleanup);

  it("offers one control and composes no draft until it is pressed", () => {
    const container = renderControl({ scriptsCreate: true });

    expect(screen.getByRole("button", { name: "+ New" })).toBeDefined();
    // No first-message field on screen means no draft was constructed. A control that
    // built one on mount would make visiting the sessions list compose a session,
    // which is the defect this destination's own probe was moved off.
    expect(screen.queryByLabelText("Its first message")).toBeNull();
    expect(container.querySelector(".meridian-new-session")).toBeNull();
  });

  it("opens the draft on the press, with the one axis it offers", async () => {
    renderControl({ scriptsCreate: true });
    await press("+ New");

    expect(screen.getByLabelText("Its first message")).toBeDefined();
    // Nothing is typed yet, so there is nothing to send. The draft's own
    // `isEmpty` is what disables it — the control does not keep a second opinion.
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

    // Back to the one control, and re-opening starts empty: `new-session-draft.ts`'s
    // "a draft that is closed empty reverts to nothing and leaves no row" is a claim
    // about what a discard leaves, so the case that matters is the state the NEXT draft
    // is in.
    expect(container.querySelector(".meridian-new-session")).toBeNull();
    await press("+ New");
    expect((screen.getByLabelText("Its first message") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
  });

  it("sends through the registered create verb and reports what it could not do", async () => {
    const container = renderControl({ scriptsCreate: true });
    await openDraftWithFirstTurn();
    await press("Send");

    // The session exists, and what could not follow it is named. Only `session.create`
    // is scripted on this bridge, so the turn's own call is refused by the fixture — a
    // different code from the one a stopped attach gets, because they are unsendable
    // for different reasons and a person pastes the code.
    expect(container.textContent).toContain("first-turn-failed");
    // And the calls that DID land are named beneath the refusal, which is what a
    // person deciding whether to press again is reading for.
    expect(container.textContent).toContain("Already sent: session.create");
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
    await openDraftWithFirstTurn();
    await press("Send");

    expect(container.textContent).toContain("session-create-failed");
    expect(politeText(container)).toBe("Nothing was sent, and the draft is still here.");
  });

  it("disables Send while a send is in flight, and re-enables it afterwards", async () => {
    const held = bridgeHoldingCreate();
    const container = renderControlOn(held.bridge);
    await openDraftWithFirstTurn();

    // The window a double-click lands in: the create is suspended, so this is what
    // the screen looks like while a person's second press would arrive.
    await press("Send");
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);

    await act(async () => {
      held.answer();
      await crossMacrotaskBoundary();
    });

    // ...and pressable again once it settles, because the partial leaves a draft the
    // person may still correct. A flag that never cleared would be a control frozen
    // by its own guard.
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
    expect(container.textContent).toContain("first-turn-failed");
  });
});

describe("the composed new-session draft — what a completed send hands out", () => {
  afterEach(cleanup);

  it("names the session it made, and leaves the screen", async () => {
    // The defect: the continuation published its report and stopped. A send that fully
    // succeeded left this form standing with Send enabled and a real daemon session
    // nothing above could name — absent from the all-sessions list until some later
    // directory read happened to notice it, and carrying none of the origin markers
    // only this window can report.
    const settledSessionIds: string[] = [];
    const container = renderControlOn(
      bridgeFor({ scriptsCreate: true, scriptsFirstTurn: true }),
      (sessionId) => settledSessionIds.push(sessionId),
    );

    await composeAndCompleteASend();

    expect(settledSessionIds).toStrictEqual([CREATED_SESSION_ID]);
    // The act is over, so the draft goes with it: one draft object mints at most one
    // session, and a form left standing offers Send under a composition that could only
    // re-report the session that already exists.
    expect(container.querySelector(".meridian-new-session")).toBeNull();
    expect(screen.getByRole("button", { name: "+ New" })).toBeDefined();
    // And the sentence is still said, before the settlement rather than after it: the
    // settlement navigates, so a sentence spoken afterwards would be addressed to a
    // destination already coming down.
    expect(politeText(container)).toBe("The session was created.");
  });

  it("hands nothing out for a send that stopped part way, and keeps the draft", async () => {
    // A partial made a session too, and settling there would navigate away from the one
    // sentence that says which leg could not be made — the sentence a second press acts
    // on, because the draft resumes at exactly that call.
    const settledSessionIds: string[] = [];
    const container = renderControlOn(bridgeFor({ scriptsCreate: true }), (sessionId) =>
      settledSessionIds.push(sessionId),
    );

    await openDraftWithFirstTurn();
    await press("Send");

    expect(settledSessionIds).toStrictEqual([]);
    expect(container.textContent).toContain("first-turn-failed");
    expect(container.querySelector(".meridian-new-session")).not.toBeNull();
  });

  it("hands nothing out when the create itself refused, because there is no session", async () => {
    const settledSessionIds: string[] = [];
    renderControlOn(bridgeFor({ scriptsCreate: false }), (sessionId) =>
      settledSessionIds.push(sessionId),
    );

    await openDraftWithFirstTurn();
    await press("Send");

    expect(settledSessionIds).toStrictEqual([]);
  });

  it("settles once, however many times the destination re-renders under it", async () => {
    // The destination composes its settlement fresh on every pass — it says so — so a
    // control that named the callback in the dependencies of the effect that settles
    // would open the session, stamp the origin and put the navigation again on every
    // render of the surface above. The identity moves here on every render, and the
    // count is what says the settlement did not follow it.
    const settledSessionIds: string[] = [];
    const bridge = bridgeFor({ scriptsCreate: true, scriptsFirstTurn: true });
    const { rerender } = render(
      <LiveAnnouncerProvider>
        <NewSessionControl
          bridge={bridge}
          blockedAct={NOTHING_BLOCKS_THE_ACT}
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
            blockedAct={NOTHING_BLOCKS_THE_ACT}
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
    // The defect: an unreadable reply rendered as `session-create-failed` beside a Send
    // button that was live again — an invitation to press, which is the one act that
    // makes a second orphan session.
    const rechecks: number[] = [];
    const container = renderControlOn(
      bridgeAnsweringCreateUnreadably(),
      () => undefined,
      () => rechecks.push(1),
    );

    await openDraftWithFirstTurn();
    await press("Send");

    expect(container.textContent).toContain("session-create-unreadable");
    expect(container.textContent).toContain("Check the sessions list");
    // Closed, and stays closed: this draft can put nothing else on the wire.
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    // And the act that IS available is drawn rather than left to be guessed at.
    await press("Check the sessions list");
    expect(rechecks).toStrictEqual([1]);
    // The draft stays: a person can still read what they typed and copy it out.
    expect(container.querySelector(".meridian-new-session")).not.toBeNull();
    expect(politeText(container)).toBe(
      "A session may have been created, and this window could not read the reply. Check the sessions list.",
    );
  });

  it("negative control: no session is handed to the destination on that arm", async () => {
    // Without this the case above would pass over a build that settled the ambiguous
    // arm as a start — navigating away, opening a store, and stamping origin markers
    // for a session that may not exist and is certainly not named.
    const settledSessionIds: string[] = [];
    renderControlOn(bridgeAnsweringCreateUnreadably(), (sessionId) =>
      settledSessionIds.push(sessionId),
    );

    await openDraftWithFirstTurn();
    await press("Send");

    expect(settledSessionIds).toStrictEqual([]);
  });
});

describe("the composed new-session draft — the axis it does not offer", () => {
  afterEach(cleanup);

  it("offers no execution-posture control, because no reachable call would carry one", async () => {
    // The defect: this control rendered a three-way posture picker, and the value it
    // collected travelled only inside the `agentAttach` loop — a loop over
    // `request.agents`, which is empty on every send this build can make, because
    // nothing calls `NewSessionDraft.selectAgent`. So a person chose a posture, the
    // send reported success, and the choice reached no wire at all.
    //
    // The two calls it CAN make carry no posture member to send it on instead:
    // `SessionCreateRequest` is `{ config?, metadata? }` and `QueueItemCreateRequest`
    // is `{ sessionId, channelId?, workspaceId?, priority?, payload }`, both `.strict()`.
    // A control whose choice cannot be honoured is not offered.
    renderControl({ scriptsCreate: true });
    await press("+ New");

    expect(screen.queryAllByRole("radio")).toStrictEqual([]);
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("negative control: nothing posture-shaped reaches the wire on the arm not taken", async () => {
    // The other half of the same claim, and the one that would go red if a later build
    // put the picker back without a member to send it on. Asserted over the request
    // BODIES rather than over the screen: "never offered" and "always transmitted" are
    // the only two honest states, so this pins the second one's negative.
    const recorded = bridgeRecordingACompleteSend();
    renderControlOn(recorded.bridge);
    await openDraftWithFirstTurn();
    await press("Send");

    // Both legs really were made — without this the absence below would be the absence
    // of any request at all.
    expect(recorded.calls.map((call) => call.method)).toStrictEqual([
      "session.create",
      "run.queueCreate",
    ]);
    for (const call of recorded.calls) {
      expect(JSON.stringify(call.params)).not.toMatch(/posture/i);
    }
  });
});
