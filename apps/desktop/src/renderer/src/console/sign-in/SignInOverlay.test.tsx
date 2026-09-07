// Sign-in opens from the palette, and the browser hand-off goes out through `native`.
//
// THE HAND-OFF IS THE CLAIM. `native.openExternal` is the only sanctioned way out to
// a browser — a renderer-opened window would put a control-plane origin inside this
// renderer's own frame tree — so the case below watches which bridge member the
// control reaches for, and the address it is handed is the one the ceremony named
// rather than anything this window composed.
//
// AND THE CARD IS NOT ON SCREEN UNTIL SOMEBODY ASKS. Nothing in the corpus makes a
// control-plane identity a precondition for a local session, so a console that opened
// this on mount would be demanding an account to do work that needs none.
//
// AND THE WINDOW BEHIND IT IS UNREACHABLE WHILE IT IS UP, which is the third subject
// below and the one claim this component cannot make alone. Base UI's `trap-focus`
// marks `.meridian-frame` `aria-hidden` for us and stops there: the rail and the whole
// route surface stay reachable to a reader that navigates by STRUCTURE. The console's
// own guard is the frame's `inert` background, the frame may not import this family,
// and so the card publishes into the window store and the frame folds it — a seam no
// module on either side of it can prove on its own, which is why those cases drive the
// composed `ConsoleRoot` rather than this component alone.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";
import { ONBOARDING_SCENARIO } from "../bridge/scenarios/onboarding.js";
import { backgroundOf } from "../frame/AppFrame.test-support.js";
import { SESSIONS_HASH, mountConsole } from "../frame/ConsoleRoot.test-support.js";
import { consoleCommands } from "../palette/index.js";
import { FrameStore } from "../store/index.js";
import { SignInOverlay } from "./SignInOverlay.js";
import type { ConsoleSurfaceContext } from "../seats/index.js";

const SIGN_IN_COMMAND_ID = "signIn.open";

/**
 * The members these cases exercise, over a REAL frame store.
 *
 * The store is the real class rather than a stub with the one method on it: the card
 * publishes into it and the assertions read it back, so a stand-in here would be the
 * test proving its own fixture rather than the contract.
 */
function contextOver(bridge: ConsoleBridge): ConsoleSurfaceContext {
  return {
    route: { kind: "sessions" },
    bridge,
    frameStore: new FrameStore(),
  } as unknown as ConsoleSurfaceContext;
}

async function settle(): Promise<void> {
  await act(async () => {
    await crossMacrotaskBoundary();
  });
}

/** Open the card the way a person does: through the command this family contributes. */
async function openTheCard(): Promise<void> {
  await act(async () => {
    consoleCommands.invoke(SIGN_IN_COMMAND_ID, {});
    await crossMacrotaskBoundary();
  });
}

afterEach(() => {
  consoleCommands.unregister(SIGN_IN_COMMAND_ID);
});

describe("how the card opens", () => {
  it("shows nothing until the command is run", async () => {
    render(
      <SignInOverlay
        context={contextOver(createFixtureBridge({ scenario: ONBOARDING_SCENARIO }))}
      />,
    );
    await settle();
    expect(consoleCommands.has(SIGN_IN_COMMAND_ID)).toBe(true);
    expect(document.body.textContent).not.toContain("Sign in with a passkey");
  });

  it("offers the passkey action once it is open", async () => {
    render(
      <SignInOverlay
        context={contextOver(createFixtureBridge({ scenario: ONBOARDING_SCENARIO }))}
      />,
    );
    await settle();
    await openTheCard();
    expect(document.body.textContent).toContain("Sign in with a passkey");
  });
});

describe("the browser hand-off", () => {
  it("opens the address the ceremony named, through the native bridge and nothing else", async () => {
    const opened: string[] = [];
    const base = createFixtureBridge({ scenario: ONBOARDING_SCENARIO });
    const watched: ConsoleBridge = {
      ...base,
      sidekicks: {
        ...base.sidekicks,
        native: {
          ...base.sidekicks.native,
          openExternal: async (url: string) => {
            opened.push(url);
          },
        },
      },
    };
    render(<SignInOverlay context={contextOver(watched)} />);
    await settle();
    await openTheCard();

    const passkey = [...document.body.querySelectorAll("button")].find(
      (control) => control.textContent === "Sign in with a passkey",
    );
    await act(async () => {
      passkey?.click();
      await crossMacrotaskBoundary();
    });
    await settle();

    // The scenario's host reports no PRF, so the card is now on the hand-off.
    expect(document.body.textContent).toContain("JQPD-4KTM");
    const openBrowser = [...document.body.querySelectorAll("button")].find(
      (control) => control.textContent === "Open the browser",
    );
    await act(async () => {
      openBrowser?.click();
      await crossMacrotaskBoundary();
    });
    await settle();

    expect(opened).toStrictEqual(["http://127.0.0.1:8419/callback"]);
    // And the wait finished: the scenario's second assertion settles the grant, which
    // is the whole point of scripting the ceremony as a sequence.
    expect(document.body.textContent).toContain("Signed in for this run only");
  });
});

describe("the window behind the card", () => {
  beforeEach(() => {
    window.location.hash = SESSIONS_HASH;
  });

  afterEach(() => {
    cleanup();
    window.location.hash = SESSIONS_HASH;
  });

  /**
   * The composed window with this card in the overlay slot — the composition
   * `App.tsx` ships, minus the walkthrough beside it.
   *
   * The frame store is taken off the context the frame BUILT rather than one this
   * file made, because that is the store the card writes into and the frame reads
   * back; a store handed in here would be a third party to a conversation between
   * two.
   */
  async function mountWindowWithSignInCard(): Promise<{
    readonly background: HTMLElement;
    readonly frameStore: FrameStore;
    readonly unmount: () => void;
  }> {
    let frameStore: FrameStore | undefined;
    const mounted = await mountConsole(
      (context) => {
        frameStore = context.frameStore;
      },
      (context) => <SignInOverlay context={context} />,
    );
    if (frameStore === undefined) {
      throw new Error("the frame handed its surfaces no store");
    }
    return {
      background: backgroundOf(mounted.container),
      frameStore,
      unmount: () => {
        mounted.unmount();
      },
    };
  }

  it("makes the frame's background inert while the card is up, and clears it on close", async () => {
    // Base UI hides the frame from the accessibility tree by itself; nothing below
    // this file makes the rail and the route surface unreachable to structural
    // navigation, and nothing above it can, because the frame may not name this
    // family. The card publishes and the frame folds — proved end to end, over the
    // real composition root and the real dialog.
    const { background } = await mountWindowWithSignInCard();
    expect(background.hasAttribute("inert")).toBe(false);

    await openTheCard();
    expect(background.hasAttribute("inert")).toBe(true);

    // Dismissed the way a person dismisses it: the dialog family owns Escape, and
    // this console registers no close control of its own.
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
      await crossMacrotaskBoundary();
    });
    expect(document.body.textContent).not.toContain("Sign in with a passkey");
    expect(background.hasAttribute("inert")).toBe(false);
  });

  it("leaves nothing inert when the card is unmounted with the ceremony still open", async () => {
    // The ending the close path does not cover. An OS dialog outlives this
    // component, so a card React discards mid-ceremony is a real sequence — and a
    // published flag with no publisher left would leave the window inert with
    // nothing on screen to close it.
    const { background, frameStore, unmount } = await mountWindowWithSignInCard();

    await openTheCard();
    expect(background.hasAttribute("inert")).toBe(true);
    expect(frameStore.getState().isModalSurfaceOpen).toBe(true);

    act(() => {
      unmount();
    });

    expect(frameStore.getState().isModalSurfaceOpen).toBe(false);
  });
});
