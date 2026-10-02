// The Providers page as a fixture launch mounts it: the fixture body registered into the page,
// its registry read and its sign-in start reaching the scenario's scripted replies through
// `callDaemon`, and the registry's tail reaching the body.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import {
  createFixtureBridge,
  type FixtureBridge,
} from "@renderer/services/platform/platform-bridge.fixture.js";
import { FixtureBridgeProvider } from "@test/helpers/app-frame-fixtures.js";
import { settleScheduledRead } from "@test/helpers/scheduled-read.js";
import { settle } from "@test/helpers/settle.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../../../../../../fixtures/scenarios/concurrent-streaming.js";
import { ProvidersPage } from "../ProvidersPage.js";
import { pressFirstStartControl } from "./accounts-fixture-body.test-support.js";
import { registerAccountsFixtureBody } from "./register-accounts-fixture-body.js";

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
      expect.stringContaining("Claude — work"),
      expect.stringContaining("Codex — personal"),
    ]);

    pressFirstStartControl(container);
    // The scripted sign-in answers after its latency.
    await settle(() => {
      fixture.scenarioEngine.advance(200);
    });
    expect(container.textContent).toContain("provider.example.test/device");
  });

  it("clears a sign-in the service reports finished on its own", async () => {
    const { container, fixture } = await mountProvidersPage();
    pressFirstStartControl(container);
    await settle(() => {
      fixture.scenarioEngine.advance(200);
    });
    expect(container.textContent).toContain("provider.example.test/device");

    // The scripted sign-in finishes on its own seconds later, reported on the registry's tail.
    await settle(() => {
      fixture.scenarioEngine.advance(5000);
    });
    expect(container.textContent).not.toContain("provider.example.test/device");
  });
});
