// The Providers page as a fixture launch mounts it: the fixture body registered into the page,
// its registry read and its sign-in start reaching the scenario's scripted replies through
// `callDaemon`, and the registry's tail reaching the body.

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import {
  createFixtureBridge,
  type FixtureBridge,
} from "#renderer/services/platform/bridge.fixture.js";
import { FixtureBridgeProvider } from "#test/helpers/app/frame-fixtures.js";
import { settleScheduledRead } from "#test/helpers/scheduled-read.js";
import { settle } from "#test/helpers/settle.js";
import { CONCURRENT_STREAMING_SCENARIO } from "#fixtures/scenarios/concurrent-streaming.js";
import { ProvidersPage } from "../ProvidersPage.js";
import { pressFirstStartControl, signInAddressOf } from "./AccountsFixtureBody.test-support.js";
import { registerAccountsFixtureBody } from "./register-accounts-body.js";

afterEach(() => {
  cleanup();
});

/** The Providers page over the concurrent-streaming fixture, its first registry read landed. */
async function mountProvidersPage(): Promise<{
  readonly container: HTMLElement;
  readonly fixture: FixtureBridge;
}> {
  registerAccountsFixtureBody();
  const fixture = createFixtureBridge({ scenario: CONCURRENT_STREAMING_SCENARIO });
  const { container } = render(
    <FixtureBridgeProvider fixture={fixture}>
      <LiveAnnouncerProvider>
        <ProvidersPage />
      </LiveAnnouncerProvider>
    </FixtureBridgeProvider>,
  );
  await settleScheduledRead(fixture.scenarioEngine.clock);
  return { container, fixture };
}

describe("AccountsFixtureMount", () => {
  it("draws the scenario's scripted registry and starts a sign-in through it", async () => {
    const { container, fixture } = await mountProvidersPage();
    const accountRows = container.querySelectorAll(".meridian-accounts__rows > li");
    expect([...accountRows].map((row) => row.textContent)).toStrictEqual([
      expect.stringContaining("sam@example.com · Max"),
      expect.stringContaining("Personal · Claude Code token"),
      expect.stringContaining("sam@example.org · Business · Example Inc"),
    ]);

    pressFirstStartControl(container);
    // The scripted sign-in answers after its latency.
    await settle(() => {
      fixture.scenarioEngine.advance(200);
    });
    expect(signInAddressOf(container)).toContain("provider.example.test/device");
    // The code's time left counts down on the window's clock, a second at a time.
    expect(container.textContent).toContain("This code expires in 15:00.");
    await settle(() => {
      fixture.scenarioEngine.advance(1000);
    });
    expect(container.textContent).toContain("This code expires in 14:59.");
    await settle(() => {
      fixture.scenarioEngine.advance(1000);
    });
    expect(container.textContent).toContain("This code expires in 14:58.");
  });

  it("says a failed sign-in did not finish, then clears one that finishes", async () => {
    const { container, fixture } = await mountProvidersPage();
    const signInEndsAfterStart = async (): Promise<void> => {
      pressFirstStartControl(container);
      await settle(() => {
        fixture.scenarioEngine.advance(200);
      });
      expect(signInAddressOf(container)).toContain("provider.example.test/device");
      // The scripted sign-in ends on its own seconds later, reported on the registry's tail.
      await settle(() => {
        fixture.scenarioEngine.advance(5000);
      });
      expect(signInAddressOf(container)).toBeUndefined();
    };

    // The first sign-in fails, with the provider's own reason under the line.
    await signInEndsAfterStart();
    expect(container.textContent).toContain("Sign-in did not finish.");
    expect(container.textContent).toContain("The device code expired before it was entered.");

    // `Sign in` is still there, and the next attempt finishes and leaves nothing drawn.
    await signInEndsAfterStart();
    expect(container.textContent).not.toContain("Sign-in did not finish.");
  });

  it("reports no completion for a sign-in canceled before it finishes", async () => {
    const { container, fixture } = await mountProvidersPage();
    const registryFrames: unknown[] = [];
    fixture.bridge.daemon.subscribe("providerAccount.subscribe", {}, (frame) => {
      registryFrames.push(frame);
    });
    pressFirstStartControl(container);
    await settle(() => {
      fixture.scenarioEngine.advance(200);
    });
    const [cancelControl] = [
      ...container.querySelectorAll(".meridian-accounts__signin button"),
    ].filter((button) => button.textContent === "Cancel");
    if (cancelControl === undefined) {
      throw new Error("the running sign-in rendered no control to cancel it");
    }
    fireEvent.click(cancelControl);
    await settle(() => undefined);

    // Past the moment the scripted sign-in would have finished on its own.
    await settle(() => {
      fixture.scenarioEngine.advance(5000);
    });
    expect(registryFrames).toStrictEqual([]);
  });

  it("says the provider did not accept a pasted token, the field left empty", async () => {
    const { container, fixture } = await mountProvidersPage();
    const form = container.querySelector<HTMLFormElement>(".meridian-accounts__resupply");
    const field = form?.querySelector<HTMLInputElement>('input[type="password"]');
    if (form === null || field === undefined || field === null) {
      throw new Error("the expired token account drew no field to paste a fresh token into");
    }
    fireEvent.change(field, { target: { value: "a-token-the-provider-refuses" } });
    fireEvent.submit(form);
    await settle(() => {
      fixture.scenarioEngine.advance(200);
    });

    expect(form.querySelector('[role="alert"]')?.textContent).toBe(
      "The provider did not accept that token.",
    );
    expect(field.value).toBe("");
    expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  });

  it("moves the default to a signed-in account and refuses one whose login is gone", async () => {
    const { container, fixture } = await mountProvidersPage();
    const pressAccountRow = async (label: string): Promise<void> => {
      const row = [...container.querySelectorAll(".meridian-accounts__rows > li")].find(
        (candidate) => candidate.textContent.includes(label),
      );
      const press = row?.querySelector("button");
      if (press === undefined || press === null) {
        throw new Error(`the account list drew no row to press for ${label}`);
      }
      fireEvent.click(press);
      await settle(() => {
        fixture.scenarioEngine.advance(200);
      });
      await settleScheduledRead(fixture.scenarioEngine.clock);
    };

    // The signed-in account takes the mark, which the re-read registry shows.
    await pressAccountRow("sam@example.com · Max");
    const workRow = [...container.querySelectorAll(".meridian-accounts__rows > li")].find((row) =>
      row.textContent.includes("sam@example.com · Max"),
    );
    expect(workRow?.textContent).toContain("Default");

    // The token account's login is gone, so the move is refused with its own way back, the
    // remedy the refusal carried rather than one guessed from the code.
    await pressAccountRow("Personal · Claude Code token");
    const handoff = container.querySelector(".meridian-account-handoff__sentence");
    expect(handoff?.textContent).toBe(
      "This account cannot refresh itself. When the token stops working, mint a new one and " +
        "paste it here. Mint a fresh token at the provider and paste it below.",
    );
  });
});
