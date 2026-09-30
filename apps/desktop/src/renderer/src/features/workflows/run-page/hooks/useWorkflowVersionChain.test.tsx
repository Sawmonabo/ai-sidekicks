// What the chain read offers a picker: what the read ANSWERED, in the order it arrived
// with the pin marked by comparison, and nothing when no pin names a version.

import { render } from "@testing-library/react";
import { describe, expect, it, vi, type Mock } from "vitest";

import type { WorkflowVersionChainEntry } from "@ai-sidekicks/contracts";
import { settle, versionChainEntry } from "../../workflows-probe.test-support.js";
import type { WorkflowVersionChoice } from "../run-controls.js";
import {
  useWorkflowVersionChain,
  type WorkflowVersionChainReadCall,
} from "./useWorkflowVersionChain.js";

/** The pin every case reads for, and the chain the call answers with. */
const PINNED_VERSION = "wfv-03";

const ANSWERED_CHAIN: readonly WorkflowVersionChainEntry[] = [
  versionChainEntry(PINNED_VERSION, 3),
  versionChainEntry("wfv-02", 2),
  versionChainEntry("wfv-01", 1),
];

/** A chain read that answers `ANSWERED_CHAIN` and records what it was addressed by. */
function servingCall(): Mock<WorkflowVersionChainReadCall> {
  return vi.fn<WorkflowVersionChainReadCall>(async () => ({ versions: ANSWERED_CHAIN }));
}

function ChainProbe(props: {
  readonly readChain: WorkflowVersionChainReadCall;
  readonly pinnedWorkflowVersionId: string | undefined;
  readonly onObserve: (chain: readonly WorkflowVersionChoice[]) => void;
}): React.JSX.Element {
  props.onObserve(useWorkflowVersionChain(props.readChain, props.pinnedWorkflowVersionId));
  return <></>;
}

/** The chain as the latest render saw it, plus the handle a re-render needs. */
function observeChain(
  readChain: WorkflowVersionChainReadCall,
  pinnedWorkflowVersionId: string | undefined,
): {
  readonly latest: () => readonly WorkflowVersionChoice[];
  readonly rerender: () => void;
} {
  const observed: (readonly WorkflowVersionChoice[])[] = [];
  const collect = (chain: readonly WorkflowVersionChoice[]): void => {
    observed.push(chain);
  };
  const probe = (
    <ChainProbe
      readChain={readChain}
      pinnedWorkflowVersionId={pinnedWorkflowVersionId}
      onObserve={collect}
    />
  );
  const view = render(probe);
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

describe("the version chain a served read offers", () => {
  it("offers every answered version, in the order it was answered", async () => {
    const observed = observeChain(servingCall(), PINNED_VERSION);

    await settle();

    expect(observed.latest().map((choice) => choice.workflowVersionId)).toStrictEqual(
      ANSWERED_CHAIN.map((entry) => entry.workflowVersionId),
    );
  });

  it("addresses the read by the pin and by nothing else", async () => {
    const readChain = servingCall();
    observeChain(readChain, PINNED_VERSION);

    await settle();

    expect(readChain.mock.calls).toStrictEqual([[{ workflowVersionId: PINNED_VERSION }]]);
  });

  it("marks the current pin by comparison, and marks exactly one", async () => {
    const observed = observeChain(servingCall(), PINNED_VERSION);

    await settle();

    const pinned = observed.latest().filter((choice) => choice.isCurrentPin);
    expect(pinned.map((choice) => choice.workflowVersionId)).toStrictEqual([PINNED_VERSION]);
  });

  it("labels each version by its own ordinal rather than by its id", async () => {
    const observed = observeChain(servingCall(), PINNED_VERSION);

    await settle();

    expect(observed.latest().map((choice) => choice.label)).toStrictEqual([
      "Version 3",
      "Version 2",
      "Version 1",
    ]);
  });

  it("reads once per pin, so a re-render puts no second question", async () => {
    const readChain = servingCall();
    const observed = observeChain(readChain, PINNED_VERSION);
    await settle();

    observed.rerender();
    await settle();

    expect(readChain).toHaveBeenCalledTimes(1);
  });
});

describe("the chain before an answer exists", () => {
  it("offers nothing while no pin names a version, and asks nobody", async () => {
    const readChain = servingCall();
    const observed = observeChain(readChain, undefined);

    await settle();

    expect(observed.latest()).toStrictEqual([]);
    // A question never put, not an answer of none: a read against a made-up id would ask
    // about a version nobody named.
    expect(readChain).not.toHaveBeenCalled();
  });
});
