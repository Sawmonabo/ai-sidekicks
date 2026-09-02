// The queue, rendered from the scenario the fixture bridge actually serves.
//
// The point of driving this through `createFixtureBridge` rather than through a
// hand-built feed is that the scenario is what a person sees when they open the
// runs surface in the fixture: if the scripted `run.queueList` reply stops parsing
// through the registered schema, this file fails rather than the pane quietly
// rendering an empty queue.

import { useMemo } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "../../bridge/index.js";
import { RUNS_SCENARIO } from "../../bridge/scenarios/runs.js";
import { QueueContents } from "./QueueContents.js";
import { useQueueFeed } from "../../bridge/index.js";

/** A one-component harness: the real hook, the real component, the real fixture. */
function QueueHarness(props: { readonly sessionId: string }): React.JSX.Element {
  // Built once. A fresh bridge per render would change the hook's dependency on
  // every pass and re-open the subscription forever, which is a defect in the
  // harness rather than in the feed — and one worth stating, because the symptom
  // (a queue that never settles) looks exactly like a wire fault.
  const bridge = useMemo(() => createFixtureBridge({ scenario: RUNS_SCENARIO }), []);
  const feed = useQueueFeed(bridge, props.sessionId);
  return <QueueContents feed={feed} />;
}

async function renderQueue(): Promise<HTMLElement> {
  const { container } = render(<QueueHarness sessionId={RUNS_SCENARIO.sessionId} />);
  await act(async () => {
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(container.querySelector(".meridian-queue__row")).not.toBeNull();
  });
  return container;
}

describe("the queue renders from scenario data", () => {
  it("draws one row per scripted item, in the daemon's order", async () => {
    const container = await renderQueue();
    const states = [...container.querySelectorAll(".meridian-queue__identity .meridian-chip")].map(
      (chip) => chip.textContent,
    );
    // The scenario's canonical FIFO order, unreordered: the admitted head first.
    expect(states).toStrictEqual(["admitted", "queued", "queued"]);
  });

  it("keeps a row that is no longer waiting rather than dropping it", async () => {
    // A queue row is durable and never-evented — drained but never deleted — so the
    // `admitted` row is a row here, unlike on the composer's shelf.
    const container = await renderQueue();
    expect(container.textContent).toContain("admitted");
  });

  it("negative control: the empty state is not what rendered", async () => {
    // Without this the assertions above would pass over a component that rendered
    // its empty state and happened to contain the word "queued" in the copy.
    const container = await renderQueue();
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
    expect(container.querySelectorAll(".meridian-queue__row")).toHaveLength(3);
  });
});

describe("cancel before admission", () => {
  it("offers cancel on exactly the rows that are still waiting", async () => {
    const container = await renderQueue();
    const rows = [...container.querySelectorAll(".meridian-queue__row")];
    const cancellable = rows.map((row) => row.querySelector(".meridian-queue__cancel") !== null);
    // The `admitted` head cannot be taken back; the two `queued` rows can.
    expect(cancellable).toStrictEqual([false, true, true]);
  });

  it("negative control: the control is a real button, not decoration", async () => {
    const container = await renderQueue();
    const cancel = container.querySelector(".meridian-queue__cancel");
    expect(cancel).toBeInstanceOf(HTMLButtonElement);
    expect((cancel as HTMLButtonElement).disabled).toBe(false);
  });
});
