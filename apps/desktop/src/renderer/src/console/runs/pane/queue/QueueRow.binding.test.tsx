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
//
// AND THE SECOND SUITE BELOW IS THE ARM A RELEASE BUILD TAKES. No wire carries the
// binding yet, so the read refuses and every row is targetless — which without the
// projection's own refusal beside them reads as a queue nothing is bound to. Driven
// from a composed reading rather than the fixture, because the fixture SERVES this
// operation: a refusal is not a state any scenario can put it in.

import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { QueueItemSummary } from "@ai-sidekicks/contracts";

import {
  createFixtureBridge,
  readQueueItemId,
  useQueueFeed,
  type ConsoleBridge,
  type QueueFeed,
} from "../../../bridge/index.js";
import { settleScheduledRead } from "../../../bridge/readings/scheduled-read.test-support.js";
import { RUNS_SCENARIO } from "../../../bridge/scenarios/runs.js";
import { RUN_ID } from "../../../bridge/scenarios/runs.identifiers.js";
import { refuse } from "../../../core/index.js";
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

const BINDING_ROW_ID = readQueueItemId("5e6f7081-9203-44b5-a6c7-d8e9f0011223");
if (BINDING_ROW_ID === undefined) {
  throw new Error("the queue-row fixture names an item identifier the wire refuses");
}

/** One waiting row, so the surface has something to be unbound about. */
const BINDING_ROW: QueueItemSummary = {
  id: BINDING_ROW_ID,
  state: "queued",
  priority: 0,
  createdAt: "2026-09-02T09:00:00.000Z",
  updatedAt: "2026-09-02T09:00:00.000Z",
};

/** A settled reading whose binding projection carries whatever the case supplies. */
function feedWithBinding(
  runBindings: Pick<QueueFeed, "targetRunIdByItemId" | "bindingRefusal">,
): QueueFeed {
  return {
    items: [BINDING_ROW],
    phase: "read",
    readRefusal: undefined,
    pendingCancelIds: new Set<string>(),
    cancelRefusalByItemId: new Map(),
    cancelItem: () => undefined,
    unreadableDeliveryCount: 0,
    unreadableRefusal: undefined,
    ...runBindings,
  };
}

describe("a binding read that refused is said, never left as an unbound row", () => {
  it("renders the projection's own refusal beside the rows it could not label", () => {
    // The arm a release build takes: no wire carries the binding, so the read refuses
    // and every row is targetless. Without the notice that reads as "nothing here is
    // bound to a run", which is a claim about the queue nobody checked.
    const { container } = render(
      <QueueContents
        feed={feedWithBinding({
          targetRunIdByItemId: new Map<string, string>(),
          bindingRefusal: refuse(
            "queue-run-binding",
            "wire-unregistered",
            "Not checked — the run each queued item is bound to is not registered on this build yet.",
          ),
        })}
      />,
    );

    expect(container.querySelector(".meridian-refusal")?.textContent).toContain(
      "wire-unregistered",
    );
    // Beside the rows and never in place of them.
    expect(container.querySelectorAll(".meridian-queue__row")).toHaveLength(1);
    expect(targetRunLabels(container)).toStrictEqual([undefined]);
  });

  it("negative control: a served read naming none draws no target and no refusal", () => {
    // Without the control above this case would hold over a surface that mounted the
    // notice whenever a row was unbound — and "the read found no binding for this
    // row" is not a refusal.
    const { container } = render(
      <QueueContents
        feed={feedWithBinding({
          targetRunIdByItemId: new Map<string, string>(),
          bindingRefusal: undefined,
        })}
      />,
    );

    expect(container.querySelector(".meridian-refusal")).toBeNull();
    expect(targetRunLabels(container)).toStrictEqual([undefined]);
  });
});
