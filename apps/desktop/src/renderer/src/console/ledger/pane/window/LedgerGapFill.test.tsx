// What a window renders about the entries it was told about and never received.
//
// Driven through a REAL registry and a real store rather than through scripted facts:
// the hole is produced by applying a batch that skips a position, which is the same
// path a delivery gap takes in a shipped window, and the kept position is produced by
// a read that acknowledges one. A suite that handed the surface two literals would be
// asserting against its own reading of the store rather than against the store.

import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SidekicksBridgeProvider, createFixtureBridge } from "../../../bridge/index.js";
import { LEDGER_QUIET_SCENARIO } from "../../../bridge/scenario/ledger/ledger-quiet.js";
import { SessionStoreRegistry, type SessionStore } from "../../../store/index.js";
import { eventOfKind } from "../../../store/session-event.test-support.js";
import { emptySnapshot } from "../../../store/session-store-registry.test-support.js";
import { LedgerGapFill } from "./LedgerGapFill.js";

const SESSION_ID = "session-gap-surface";
const ACKNOWLEDGED_CURSOR = "cursor-acknowledged-by-the-read";

/**
 * A registry whose read answers at the base cursor, with or without a kept position.
 *
 * The base state is `emptySnapshot`'s, so the shape a store opens with is this tree's
 * one reading of it; the cursor block is the only thing these two cases differ in.
 */
function registryAcknowledging(acknowledged: string | undefined): SessionStoreRegistry {
  return new SessionStoreRegistry({
    refreshDebounceMs: 0,
    read: () =>
      Promise.resolve({
        ...emptySnapshot(0),
        timelineCursors: {
          latest: "cursor-latest",
          ...(acknowledged === undefined ? {} : { acknowledged }),
        },
      }),
  });
}

/**
 * An open session whose first read has landed, so both facts this surface reads exist.
 *
 * The read is what settles the resume decision, which is why it goes through the
 * registry rather than through `SessionStore.initialise`: a store initialised by hand
 * holds a base state and no record of what the daemon acknowledged, which is exactly
 * the half this surface asks about.
 */
async function openAndRead(registry: SessionStoreRegistry): Promise<SessionStore> {
  const sessionStore = registry.open(SESSION_ID);
  registry.requestRefresh(SESSION_ID, "subscribe");
  await waitFor(() => {
    expect(sessionStore.snapshot().initialised).toBe(true);
  });
  return sessionStore;
}

/** Deliver two rows with two positions missing in front of them. */
function openHole(sessionStore: SessionStore): void {
  sessionStore.applyBatch([
    eventOfKind(sessionStore.sessionId, "run.starting", 3, { runId: "run-after-the-hole" }),
    eventOfKind(sessionStore.sessionId, "run.starting", 4, { runId: "run-after-the-hole" }),
  ]);
}

/** The surface, under a bridge whose growth port is the one a fixture window holds. */
function renderFill(registry: SessionStoreRegistry, sessionStore: SessionStore): void {
  render(
    <SidekicksBridgeProvider bridge={createFixtureBridge({ scenario: LEDGER_QUIET_SCENARIO })}>
      <LedgerGapFill registry={registry} sessionStore={sessionStore} />
    </SidekicksBridgeProvider>,
  );
}

describe("LedgerGapFill", () => {
  it("renders nothing for a window that is missing nothing", async () => {
    const registry = registryAcknowledging(ACKNOWLEDGED_CURSOR);
    const sessionStore = await openAndRead(registry);

    const { container } = render(
      <SidekicksBridgeProvider bridge={createFixtureBridge({ scenario: LEDGER_QUIET_SCENARIO })}>
        <LedgerGapFill registry={registry} sessionStore={sessionStore} />
      </SidekicksBridgeProvider>,
    );

    // The negative control for both arms below: an ordinary window says nothing at all
    // here, so neither absence can be rendering for a reason other than the hole.
    expect(container.innerHTML).toBe("");
  });

  it("says the replay is not available on a build with no seam to send the position", async () => {
    const registry = registryAcknowledging(ACKNOWLEDGED_CURSOR);
    const sessionStore = await openAndRead(registry);
    openHole(sessionStore);

    renderFill(registry, sessionStore);

    // The port's own sentence travels verbatim beside the console's, which is rule 9:
    // the refusal names who owes the wire and this surface does not paraphrase it.
    expect(
      await screen.findByText("Replaying from a kept position is not available on this build."),
    ).not.toBeNull();
  });

  it("says there is no position to replay from when no read acknowledged one", async () => {
    const registry = registryAcknowledging(undefined);
    const sessionStore = await openAndRead(registry);
    openHole(sessionStore);

    renderFill(registry, sessionStore);

    // A different fact from the arm above, and the distinction is the whole point: one
    // window could ask and this build cannot carry the ask, and this one has nothing to
    // ask with. Reporting them alike would tell a person the console had tried.
    expect(await screen.findByText("There is no position to replay from.")).not.toBeNull();
    expect(
      screen.queryByText("Replaying from a kept position is not available on this build."),
    ).toBeNull();
  });
});
