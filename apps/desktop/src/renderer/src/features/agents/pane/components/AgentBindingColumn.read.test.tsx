// The column's recovery from a refused roster read, which is terminal: nothing re-runs the
// effect that opened it, so the column needs its own retry. Other subjects have their own files.

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { settleReads } from "../agents-pane.test-support.js";
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
    if (method === "agent.definitionList") {
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
    const fixture = bridgeCalling(scriptedDaemon);
    const { container } = render(
      <AgentBindingColumn models={modelsOver(fixture, scriptedDaemon)} agentId={undefined} />,
    );
    await settleReads(fixture.scenarioEngine);
    expect(container.textContent ?? "").toContain("read-failed");
    const retry = currentRetryControl(container);
    expect(retry?.textContent).toBe("Try again");
    const callsBeforeRetry = scriptedDaemon.listCallCount;

    await act(async () => {
      fireEvent.click(retry as HTMLButtonElement);
    });
    await settleReads(fixture.scenarioEngine);

    expect(scriptedDaemon.listCallCount).toBeGreaterThan(callsBeforeRetry);
    expect(currentRetryControl(container)).toBeNull();
  });

  it("negative control: a roster that answered offers no way back", async () => {
    // Guards against a retry control rendered on every arm, beside a roster that is current.
    const scriptedDaemon = new RefusingRosterDaemon(0);
    const fixture = bridgeCalling(scriptedDaemon);
    const { container } = render(
      <AgentBindingColumn models={modelsOver(fixture, scriptedDaemon)} agentId={undefined} />,
    );
    await settleReads(fixture.scenarioEngine);

    expect(currentRetryControl(container)).toBeNull();
  });
});
