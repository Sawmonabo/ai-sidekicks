// What the chain read offers a picker, and what every arm that is not served does.
//
// The claim under test is one rule with four inputs: the chain a picker may offer is
// what the read ANSWERED and nothing else. So a served reply reaches the caller in the
// order it arrived with the pin marked by comparison, and each of the three unserved
// arms — nobody asked, the wire refused, the seam rejected — offers nothing rather
// than a target synthesized from the one id in hand.
//
// THE PORTS ARE THE CONSOLE'S OWN, spread from `createRefusingGrowthPort` with the one
// operation a case is about. A stand-in shaped like a port would agree with whatever
// this hook did with it, and the refusing arm in particular is only meaningful because
// it is the refusal the real port composes from the real slate row.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { GrowthPort, WorkflowVersionChainEntry } from "../../../bridge/index.js";
import { createRefusingGrowthPort } from "../../../bridge/growth-port/growth-port.js";
import type { WorkflowVersionChoice } from "./run-controls.js";
import { useWorkflowVersionChain } from "./version-chain.js";

/** The pin every case reads for, and the chain a served port answers with. */
const PINNED_VERSION = "wfv-03";

const ANSWERED_CHAIN: readonly WorkflowVersionChainEntry[] = [
  { workflowVersionId: PINNED_VERSION, versionNumber: 3 },
  { workflowVersionId: "wfv-02", versionNumber: 2 },
  { workflowVersionId: "wfv-01", versionNumber: 1 },
];

/** A port that answers the chain read, recording what it was addressed by. */
function servingPort(): { readonly growth: GrowthPort; readonly requests: string[] } {
  const requests: string[] = [];
  return {
    growth: {
      ...createRefusingGrowthPort(),
      workflowVersionChainRead: async (request) => {
        requests.push(request.workflowVersionId);
        return { status: "served", value: { versions: ANSWERED_CHAIN } };
      },
    },
    requests,
  };
}

/** And one whose call REJECTS, which is the seam's fourth settlement. */
function rejectingPort(): GrowthPort {
  return {
    ...createRefusingGrowthPort(),
    workflowVersionChainRead: () => Promise.reject(new Error("the bridge closed mid-read")),
  };
}

function ChainProbe(props: {
  readonly growth: GrowthPort;
  readonly pinnedWorkflowVersionId: string | undefined;
  readonly onObserve: (chain: readonly WorkflowVersionChoice[]) => void;
}): React.JSX.Element {
  props.onObserve(useWorkflowVersionChain(props.growth, props.pinnedWorkflowVersionId));
  return <></>;
}

/** The chain as the latest render saw it, plus the handle a re-render needs. */
function observeChain(
  growth: GrowthPort,
  pinnedWorkflowVersionId: string | undefined,
): {
  readonly latest: () => readonly WorkflowVersionChoice[];
  readonly rerender: () => void;
} {
  const observed: (readonly WorkflowVersionChoice[])[] = [];
  const collect = (chain: readonly WorkflowVersionChoice[]): void => {
    observed.push(chain);
  };
  const view = render(
    <ChainProbe
      growth={growth}
      pinnedWorkflowVersionId={pinnedWorkflowVersionId}
      onObserve={collect}
    />,
  );
  const probe = (
    <ChainProbe
      growth={growth}
      pinnedWorkflowVersionId={pinnedWorkflowVersionId}
      onObserve={collect}
    />
  );
  return {
    latest: () => {
      const current = observed.at(-1);
      if (current === undefined) {
        throw new Error("the probe rendered no chain");
      }
      return current;
    },
    rerender: () => {
      view.rerender(probe);
    },
  };
}

/**
 * Let the read's own microtasks run, which is all an immediate answer needs.
 *
 * A BOUNDED DRAIN RATHER THAN A COUNTED ONE. How many turns of the microtask queue a
 * settlement chain costs is not a contract the hook makes — it moves whenever a layer
 * is added between the call and the publish, which is how a suite written against an
 * exact count fails on a change that broke nothing. Turns are free when nothing is
 * queued, so the ceiling is generous and the cases below assert on what was published
 * rather than on how many turns it took to get there.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 32; turn += 1) {
    await Promise.resolve();
  }
}

describe("the version chain a served read offers", () => {
  it("offers every answered version, in the order it was answered", async () => {
    const port = servingPort();
    const observed = observeChain(port.growth, PINNED_VERSION);

    await settle();

    expect(observed.latest().map((choice) => choice.workflowVersionId)).toStrictEqual(
      ANSWERED_CHAIN.map((entry) => entry.workflowVersionId),
    );
  });

  it("addresses the read by the pin and by nothing else", async () => {
    const port = servingPort();
    observeChain(port.growth, PINNED_VERSION);

    await settle();

    expect(port.requests).toStrictEqual([PINNED_VERSION]);
  });

  it("marks the current pin by comparison, and marks exactly one", async () => {
    const port = servingPort();
    const observed = observeChain(port.growth, PINNED_VERSION);

    await settle();

    const pinned = observed.latest().filter((choice) => choice.isCurrentPin);
    expect(pinned.map((choice) => choice.workflowVersionId)).toStrictEqual([PINNED_VERSION]);
  });

  it("labels each version by its own ordinal rather than by its id", async () => {
    const port = servingPort();
    const observed = observeChain(port.growth, PINNED_VERSION);

    await settle();

    expect(observed.latest().map((choice) => choice.label)).toStrictEqual([
      "Version 3",
      "Version 2",
      "Version 1",
    ]);
  });

  it("reads once per pin, so a re-render puts no second question", async () => {
    const port = servingPort();
    const observed = observeChain(port.growth, PINNED_VERSION);
    await settle();

    observed.rerender();
    await settle();

    expect(port.requests).toStrictEqual([PINNED_VERSION]);
  });
});

describe("the three arms that are not served offer nothing", () => {
  it("offers nothing while no pin names a version, and asks nobody", async () => {
    const port = servingPort();
    const observed = observeChain(port.growth, undefined);

    await settle();

    expect(observed.latest()).toStrictEqual([]);
    // The absence is a question never put rather than an answer of none: a pane whose
    // run read has not settled holds no pin, and a read against a fabricated id would
    // be asking about a version nobody named.
    expect(port.requests).toStrictEqual([]);
  });

  it("offers nothing when the port refuses the wire", async () => {
    const observed = observeChain(createRefusingGrowthPort(), PINNED_VERSION);

    await settle();

    expect(observed.latest()).toStrictEqual([]);
  });

  it("offers nothing when the call rejects, rather than reading forever", async () => {
    const observed = observeChain(rejectingPort(), PINNED_VERSION);

    await settle();

    expect(observed.latest()).toStrictEqual([]);
  });

  it("negative control: the same probe over a serving port offers the whole chain", async () => {
    // Without this, the three cases above would pass over a hook that answered empty
    // on every arm — including the served one — which is the surface this read exists
    // to replace rather than a fix for it.
    const observed = observeChain(servingPort().growth, PINNED_VERSION);

    await settle();

    expect(observed.latest()).toHaveLength(ANSWERED_CHAIN.length);
  });
});
