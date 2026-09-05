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
// WHICH composition a settlement lands in, and which bridge a draft belongs to, is
// `NewSessionControl.addressing.test.tsx`.

import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  bridgeHoldingCreate,
  politeText,
  press,
  renderControl,
  renderControlOn,
} from "./NewSessionControl.test-support.js";

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

    // The session exists, and what could not follow it is named. This draft chose a
    // posture and no sidekicks, so the only call left is the registered one with no
    // turn to carry — a different code from the one a draft naming sidekicks gets,
    // because they are unsendable for different reasons and a person pastes the code.
    expect(container.textContent).toContain("first-turn-missing");
    expect(container.textContent).toContain("run.queueCreate");
    expect(container.textContent).not.toContain("agent.attach");
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
    expect(container.textContent).toContain("first-turn-missing");
  });
});
