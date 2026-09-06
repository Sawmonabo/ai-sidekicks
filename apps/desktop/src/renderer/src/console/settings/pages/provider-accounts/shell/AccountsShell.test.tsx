// The accounts shell, driven against the deck it actually ships in.
//
// THE SCENARIO IS THE REAL ONE. `SETTINGS_SCENARIO` is the story the scenario
// selector opens, so every state asserted below is a state a reviewer can reach in a
// running fixture build rather than one that exists only in this file. That is the
// property the lane's own rule asks for and the reason nothing here hand-builds a
// registry reply.
//
// THE ONE STATE IT CANNOT REACH FROM THE DECK IS THE REFUSAL, because the deck
// answers this read. That case overrides the bound call so the failed arm is drawn
// too — every arm of the read is rendered somewhere.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  SidekicksBridgeProvider,
  createFixtureBridge,
  type ConsoleBridge,
} from "../../../../bridge/index.js";
import { settleScriptedRead } from "../../../../bridge/readings/scheduled-read.test-support.js";
import { SETTINGS_SCENARIO } from "../../../../bridge/scenarios/settings.js";
import { LiveAnnouncerProvider } from "../../../../primitives/index.js";
import { AccountsShell } from "./AccountsShell.js";

afterEach(() => {
  cleanup();
});

function renderShell(bridge: ConsoleBridge): HTMLElement {
  const { container } = render(
    <SidekicksBridgeProvider bridge={bridge}>
      <LiveAnnouncerProvider>
        <AccountsShell bridge={bridge} />
      </LiveAnnouncerProvider>
    </SidekicksBridgeProvider>,
  );
  return container;
}

/** Mount, carry the debounced read past its window and past the reply's latency. */
async function renderSettledShell(bridge: ConsoleBridge): Promise<HTMLElement> {
  const container = renderShell(bridge);
  await settleScriptedRead(bridge);
  return container;
}

function fixtureBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: SETTINGS_SCENARIO });
}

/** Open one account's detail the way a person does — by pressing its row. */
function selectAccount(container: HTMLElement, displayLabel: string): void {
  const rows = [...container.querySelectorAll<HTMLButtonElement>(".meridian-accounts__row")];
  const row = rows.find((button) => (button.textContent ?? "").includes(displayLabel));
  if (row === undefined) {
    throw new Error(`the registry rendered no account row labelled ${displayLabel}`);
  }
  fireEvent.click(row);
}

describe("AccountsShell", () => {
  it("draws a loading absence before the registry answers", () => {
    const container = renderShell(fixtureBridge());
    expect(container.textContent).toContain("account registry");
    expect(container.querySelectorAll(".meridian-accounts__row")).toHaveLength(0);
  });

  it("lists every account the node registry holds", async () => {
    const container = await renderSettledShell(fixtureBridge());
    expect(container.querySelectorAll(".meridian-accounts__row").length).toBeGreaterThanOrEqual(3);
  });

  it("says an account has never been observed rather than dating it", async () => {
    const container = await renderSettledShell(fixtureBridge());
    expect(container.textContent).toContain("Never observed");
  });

  it("offers the sign-in the readiness remedy names", async () => {
    await renderSettledShell(fixtureBridge());
    expect(screen.getAllByRole("button", { name: /start sign-in/iu }).length).toBeGreaterThan(0);
  });

  // The negative control for the case above: the authenticated entry carries no
  // remedy at all, so its readiness row offers nothing. One button per remedy-bearing
  // entry, never one per provider.
  it("offers no sign-in on the entry that needs nothing done", async () => {
    const container = await renderSettledShell(fixtureBridge());
    const readinessRows = container.querySelectorAll(".meridian-accounts__readiness");
    const rowsOfferingSignIn = [...readinessRows].filter((row) =>
      /start sign-in/iu.test(row.textContent ?? ""),
    );
    expect(rowsOfferingSignIn.length).toBeLessThan(readinessRows.length);
  });

  it("renders one quota row per limit, keeping three that share a window length", async () => {
    const container = await renderSettledShell(fixtureBridge());
    const limitRows = container.querySelectorAll(".meridian-accounts__quota tbody tr");
    expect(limitRows.length).toBeGreaterThanOrEqual(3);
  });

  it("marks a reading taken under an older credential generation", async () => {
    const container = await renderSettledShell(fixtureBridge());
    // The account is CHOSEN rather than assumed. A stale reading is one taken before
    // this account's credential was rotated, so it exists on the entry whose
    // generation has moved past its last probe — and the detail under the list is one
    // account's. Reading the whole page for the marker without opening that entry
    // would report the shell had lost a mark it never had the chance to draw.
    selectAccount(container, "Claude — batch runs");
    expect(container.textContent).toContain("Behind this account");
  });

  it("offers a token field that is write-only and starts empty", async () => {
    const container = await renderSettledShell(fixtureBridge());
    const tokenInput = container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(tokenInput).not.toBeNull();
    expect(tokenInput?.value).toBe("");
  });

  // The token is never a value the shell holds, so nothing on the page reads it back
  // and no other field on the form is masked. The negative control is the label
  // field, which is ordinary text input and must stay that way.
  it("masks the token field and nothing else", async () => {
    const container = await renderSettledShell(fixtureBridge());
    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(1);
    expect(container.querySelectorAll('input[type="text"]').length).toBeGreaterThan(0);
  });

  it("draws the daemon's own refusal where the read could not be put", async () => {
    const bridge = fixtureBridge();
    // The daemon namespace is REBUILT rather than spread. Spreading it takes the
    // namespace whole, which is one of the five reaches
    // `test/console/architecture/daemon-reply-chokepoint.test.ts` forbids outside the
    // bridge family — and it forbids it here for the reason it exists: a namespace
    // taken as a value is how a surface reaches the raw door without naming it. The
    // stream member is stepped through, which is the shape that is not a reach.
    const refusing: ConsoleBridge = {
      ...bridge,
      sidekicks: {
        ...bridge.sidekicks,
        daemon: {
          call: async (): Promise<never> => {
            throw new Error("the registry read could not be put");
          },
          subscribe: bridge.sidekicks.daemon.subscribe,
        },
      },
    };
    const container = await renderSettledShell(refusing);
    expect(container.textContent).toContain("Try again");
  });
});
