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

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";
import { ONBOARDING_SCENARIO } from "../bridge/scenarios/onboarding.js";
import { consoleCommands } from "../palette/index.js";
import { SignInOverlay } from "./SignInOverlay.js";
import type { ConsoleSurfaceContext } from "../seats/index.js";

const SIGN_IN_COMMAND_ID = "signIn.open";

function contextOver(bridge: ConsoleBridge): ConsoleSurfaceContext {
  return { route: { kind: "sessions" }, bridge } as unknown as ConsoleSurfaceContext;
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
