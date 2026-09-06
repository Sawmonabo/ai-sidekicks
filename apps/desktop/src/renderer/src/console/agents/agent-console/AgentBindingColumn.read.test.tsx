// The one arm of this column a person could not get out of.
//
// A refused agent roster read is terminal by construction: the effect that opened the
// read runs once per (models) pair and nothing re-runs it, so the column said one line
// of error text for the life of the window and a refusal that would clear in thirty
// seconds was indistinguishable from one that never would. The column's other three
// subjects have their own files; this one is about the read.

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { settleReads } from "./agent-console.test-support.js";
import {
  bridgeCalling,
  disposeOpenedModels,
  modelsOver,
  type ScriptedDaemon,
} from "./agent-binding-column.test-support.js";
import { AgentBindingColumn } from "./AgentBindingColumn.js";

afterEach(disposeOpenedModels);

/** Refuses `agent.list` a fixed number of times, then serves an empty roster. */
class RefusingRosterDaemon implements ScriptedDaemon {
  #refusalsLeft: number;
  public listCallCount = 0;

  public constructor(refusalCount: number) {
    this.#refusalsLeft = refusalCount;
  }

  public async answer(method: string): Promise<unknown> {
    if (method === "agent.list") {
      this.listCallCount += 1;
      if (this.#refusalsLeft > 0) {
        this.#refusalsLeft -= 1;
        throw new Error("the roster read was refused");
      }
      return { agents: [] };
    }
    if (method === "sidekick.definitionList") {
      return { definitions: [] };
    }
    return { drivers: [] };
  }
}

function currentRetryControl(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector(".meridian-refusal__action button");
}

describe("agent binding column — a refused roster read", () => {
  it("offers a way back, and taking it reaches the wire again", async () => {
    const scriptedDaemon = new RefusingRosterDaemon(1);
    const bridge = bridgeCalling(scriptedDaemon);
    const { container } = render(
      <AgentBindingColumn models={modelsOver(bridge)} agentId={undefined} />,
    );
    await settleReads(bridge);
    expect(container.textContent ?? "").toContain("read-failed");
    const retry = currentRetryControl(container);
    expect(retry?.textContent).toBe("Try again");
    const callsBeforeRetry = scriptedDaemon.listCallCount;

    await act(async () => {
      fireEvent.click(retry as HTMLButtonElement);
    });
    await settleReads(bridge);

    expect(scriptedDaemon.listCallCount).toBeGreaterThan(callsBeforeRetry);
    expect(currentRetryControl(container)).toBeNull();
  });

  it("negative control: a roster that answered offers no way back", async () => {
    // Without this, the case above would pass over a column that rendered the control
    // on every arm — a retry beside a roster that is already current, which reads as a
    // refresh this surface does not have.
    const bridge = bridgeCalling(new RefusingRosterDaemon(0));
    const { container } = render(
      <AgentBindingColumn models={modelsOver(bridge)} agentId={undefined} />,
    );
    await settleReads(bridge);

    expect(currentRetryControl(container)).toBeNull();
  });
});
