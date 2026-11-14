// "+ New" and the draft behind it, driven through the screen.
//
// The first-turn call rejects unless a case says otherwise, so a real send lands
// `session.create` and then says what it could not do; a control that reported a plain
// success would describe a session with no first turn as finished. That partial leaves Send
// pressable, so one case holds the affordance half of the double-press guard (the structural
// half lives in the draft). The second describe resolves the first-turn call, which is the
// only way a send completes.
//
// Which composition a settlement lands in, and which bridge a draft belongs to, is
// `NewSessionControl.addressing.test.tsx`.

import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CREATED_SESSION_ID, bridgeFor } from "../draft.test-support.js";
import {
  bridgeHoldingCreate,
  completingFirstTurn,
  composeAndCompleteASend,
  openDraftWithFirstTurn,
  politeText,
  press,
  renderControl,
  renderControlOn,
} from "./NewSessionControl.test-support.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";

describe("the composed new-session draft — what a send reports", () => {
  afterEach(cleanup);

  it("sends through the registered create verb and reports what it could not do", async () => {
    const container = renderControl({ scriptsCreate: true });
    await openDraftWithFirstTurn();
    await press("Send");

    // The session exists and what could not follow is named. Only `session.create` is
    // scripted, so the turn's call is refused by the fixture, under a different code from a
    // refused create.
    expect(container.textContent).toContain(
      "The session was created, but the first turn was not queued.",
    );
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

    expect(container.textContent).toContain("The session could not be created.");
    expect(politeText(container)).toBe("Nothing was sent, and the draft is still here.");
  });

  it("disables Send while a send is in flight, and re-enables it afterwards", async () => {
    const held = bridgeHoldingCreate();
    const container = renderControlOn(held.bridge);
    await openDraftWithFirstTurn();

    // The create is suspended: the window a double-click's second press would land in.
    await press("Send");
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      held.answer();
      await crossMacrotaskBoundary();
    });

    // Pressable again once it settles, since the partial leaves a draft the person may
    // correct; a flag that never cleared would freeze the control.
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).toBe(
      "false",
    );
    expect(container.textContent).toContain(
      "The session was created, but the first turn was not queued.",
    );
  });
});

describe("the composed new-session draft — what a completed send hands out", () => {
  afterEach(cleanup);

  it("names the session it made, and leaves the screen", async () => {
    // A completed send hands its session out and closes the form, so no real session is left
    // that nothing above can name.
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
    expect(container.textContent).toContain(
      "The session was created, but the first turn was not queued.",
    );
    expect(container.querySelector(".meridian-new-session")).not.toBeNull();
  });
});
