// A queue row says which run it is bound to, and says nothing where it is not.
//
// Driven through the real hook, the real component, and the real fixture for
// `QueueContents.test.tsx`'s reason: the binding arrives as its own growth-port
// projection folded onto the feed, so a projection that stopped being asked for, or a
// fold that lost it, fails here rather than leaving every row quietly unbound.
//
// The unbound row is the bound rows' negative control. A component that rendered a
// target unconditionally would draw one for all three, and a projection that answered
// nothing would draw one for none.

import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, useQueueFeed, type ConsoleBridge } from "../../../bridge/index.js";
import { settleScheduledRead } from "../../../bridge/readings/scheduled-read.test-support.js";
import { RUNS_SCENARIO } from "../../../bridge/scenarios/runs.js";
import { RUN_ID } from "../../../bridge/scenarios/runs.identifiers.js";
import { QueueContents } from "./QueueContents.js";

/** A one-component harness: the real hook, the real component, the real fixture. */
function QueueHarness(props: {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
}): React.JSX.Element {
  const feed = useQueueFeed(props.bridge, props.sessionId);
  return <QueueContents feed={feed} />;
}

async function renderQueue(): Promise<HTMLElement> {
  // Built outside the component: a fresh bridge per render would change the hook's
  // dependency every pass and re-open the subscription forever.
  const bridge = createFixtureBridge({ scenario: RUNS_SCENARIO });
  const { container } = render(
    <QueueHarness bridge={bridge} sessionId={RUNS_SCENARIO.sessionId} />,
  );
  await settleScheduledRead(bridge);
  await waitFor(() => {
    expect(container.querySelector(".meridian-queue__row")).not.toBeNull();
  });
  return container;
}

/** The `Target run` figure each row carries, `undefined` where a row carries none. */
function targetRunLabels(container: HTMLElement): readonly (string | undefined)[] {
  return [...container.querySelectorAll(".meridian-queue__row")].map((row) => {
    const figures = [...row.querySelectorAll(".meridian-queue__figure")];
    const bound = figures.find(
      (figure) => figure.querySelector("dt")?.textContent === "Target run",
    );
    return bound?.querySelector("dd")?.textContent ?? undefined;
  });
}

describe("a queue row says which run it is bound to", () => {
  it("draws the target on the bound rows and nothing on the unbound one", async () => {
    const container = await renderQueue();

    await waitFor(() => {
      expect(targetRunLabels(container)).toStrictEqual([RUN_ID, RUN_ID, undefined]);
    });
  });

  it("negative control: the figure is the run id, never the queue item's own id", async () => {
    const container = await renderQueue();

    await waitFor(() => {
      const labels = targetRunLabels(container).filter((label) => label !== undefined);
      expect(labels.length).toBeGreaterThan(0);
      const identities = [...container.querySelectorAll(".meridian-queue__identity")].map(
        (identity) => identity.textContent ?? "",
      );
      for (const label of labels) {
        expect(identities.some((identity) => identity.includes(label))).toBe(false);
      }
    });
  });
});
