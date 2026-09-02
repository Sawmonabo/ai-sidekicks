// The column's one irreversible act, pressed twice — and what the control says
// while the first press is still outstanding.
//
// `agent.attach` creates a durable agent, so the property worth a whole test file
// is that the second press of a double click reaches the wire never. It is asserted
// against the REAL models over a bridge whose daemon call this file holds open,
// because the failure is invisible against a call that settles: a reply delivered
// on the next microtask makes every ordering look correct.
//
// The refusal being INVISIBLE is a second defect beside the double request, so the
// disabled-and-busy affordance is asserted here rather than on the form alone: the
// column is the only place the latch's arm and the control's attributes meet, and
// a form flag agreeing with itself would prove nothing about which one is true.

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AgentConsoleModels } from "../../agents/index.js";
import { DRIVER_CATALOG_FIXTURE } from "../../agents/driver-catalog-fixtures.js";
import {
  fixtureBridgeWithGrowth,
  unscriptedScenario,
} from "../../bridge/fixture-bridge-overrides.test-support.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { SessionStore } from "../../store/index.js";
import { AgentBindingColumn } from "./AgentBindingColumn.js";

type DaemonCall = ConsoleBridge["sidekicks"]["daemon"]["call"];

/** The definition the picker offers, so the form reaches its ready state. */
const DEFINITION = { definitionId: "definition-1", name: "Reviewer" };

/**
 * A daemon that answers the picker's read and holds `agent.attach` open.
 *
 * The count is the whole assertion: "one agent exists" is also true of a column
 * that issued two requests and lost one of the replies.
 */
class HeldAttachDaemon {
  #attachCallCount = 0;
  #attachRequest: unknown;
  #release: ((reading: unknown) => void) | undefined;

  public get attachCallCount(): number {
    return this.#attachCallCount;
  }

  /** What the column actually put on the wire, not what the form believed. */
  public get attachRequest(): unknown {
    return this.#attachRequest;
  }

  public readonly call = async (method: string, params?: unknown): Promise<unknown> => {
    if (method === "sidekick.definitionList") {
      return { definitions: [DEFINITION] };
    }
    if (method === "agent.attach") {
      this.#attachCallCount += 1;
      this.#attachRequest = params;
      return await new Promise<unknown>((resolve) => {
        this.#release = resolve;
      });
    }
    throw new Error(`the test daemon scripts no reply for ${method}`);
  };

  public async settle(agentId: string): Promise<void> {
    this.#release?.({ agentId });
    await Promise.resolve();
    await Promise.resolve();
  }
}

/** What either test daemon below exposes to the bridge. */
interface ScriptedDaemon {
  readonly call: (method: string, params?: unknown) => Promise<unknown>;
}

/** The real fixture bridge with its daemon call replaced by a scripted one. */
function bridgeCalling(daemon: ScriptedDaemon): ConsoleBridge {
  const fixture = fixtureBridgeWithGrowth(unscriptedScenario("agent-console-attach"), {});
  return {
    ...fixture,
    sidekicks: {
      ...fixture.sidekicks,
      daemon: {
        ...fixture.sidekicks.daemon,
        // The `DaemonMethod` brand no string literal satisfies, cast once here for
        // `collaboration/wire-access.ts`' reason. The method NAME is the only
        // untyped thing; what this daemon answers with is the test's own claim.
        call: daemon.call as unknown as DaemonCall,
      },
    },
  };
}

const openedModels: AgentConsoleModels[] = [];

afterEach(() => {
  for (const models of openedModels.splice(0, openedModels.length)) {
    models.dispose();
  }
});

/** The real models over that bridge, disposed after the test that opened them. */
function modelsOver(bridge: ConsoleBridge): AgentConsoleModels {
  const models = new AgentConsoleModels(bridge, new SessionStore({ sessionId: "session-9" }));
  openedModels.push(models);
  return models;
}

/** Move the frozen clock past the refresh debounce and let the replies land. */
async function settleReads(bridge: ConsoleBridge): Promise<void> {
  await act(async () => {
    bridge.scenarioEngine?.advance(500);
    for (let pass = 0; pass < 4; pass += 1) {
      await Promise.resolve();
    }
  });
}

/** The submit control as it stands now — re-queried, never held across a render. */
function currentSubmitControl(): HTMLButtonElement {
  const submit = document.querySelector(".meridian-attach__submit");
  expect(submit).not.toBeNull();
  return submit as HTMLButtonElement;
}

/**
 * Open the dialog, name the agent, choose the definition arm, pick the definition.
 *
 * The name is typed rather than assumed: the registered request requires it of both
 * arms, so a form that skipped it would never reach its ready state at all.
 */
async function openReadyAttachForm(
  container: HTMLElement,
  agentName = "Scout",
): Promise<HTMLButtonElement> {
  await act(async () => {
    fireEvent.click(container.querySelector(".meridian-agent-card__action") as HTMLElement);
  });
  const nameInput = document.querySelector(
    ".meridian-attach__popup .meridian-axis-field__text",
  ) as HTMLInputElement;
  await act(async () => {
    fireEvent.change(nameInput, { target: { value: agentName } });
  });
  const armButton = [...document.querySelectorAll(".meridian-attach__arm")].find(
    (candidate) => candidate.textContent === "From a definition",
  );
  await act(async () => {
    fireEvent.click(armButton as HTMLElement);
  });
  await act(async () => {
    fireEvent.click(document.querySelector(".meridian-attach__definition-button") as HTMLElement);
  });
  const submit = currentSubmitControl();
  expect(submit.disabled).toBe(false);
  return submit;
}

/**
 * A daemon that answers the roster and catalog reads and holds `agent.configUpdate`
 * open, counting how often it was called.
 *
 * The count is the whole assertion for the double press, and holding the call open
 * is what makes the failure visible: a reply delivered on the next microtask makes
 * every ordering look correct.
 */
class HeldConfigUpdateDaemon {
  #updateCallCount = 0;
  #release: ((reading: unknown) => void) | undefined;
  readonly #roster: readonly unknown[];

  public constructor(roster: readonly unknown[]) {
    this.#roster = roster;
  }

  public get updateCallCount(): number {
    return this.#updateCallCount;
  }

  public readonly call = async (method: string): Promise<unknown> => {
    if (method === "agent.list") {
      return { agents: this.#roster };
    }
    if (method === "driver.listModels") {
      return DRIVER_CATALOG_FIXTURE.models;
    }
    if (method === "driver.listCapabilities") {
      return DRIVER_CATALOG_FIXTURE.capabilities;
    }
    if (method === "sidekick.definitionList") {
      return { definitions: [DEFINITION] };
    }
    if (method === "agent.configUpdate") {
      this.#updateCallCount += 1;
      return await new Promise<unknown>((resolve) => {
        this.#release = resolve;
      });
    }
    throw new Error(`the test daemon scripts no reply for ${method}`);
  };

  public async settle(reply: unknown): Promise<void> {
    this.#release?.(reply);
    await Promise.resolve();
    await Promise.resolve();
  }
}

const AGENT_ON_CLAUDE = {
  agentId: "agent-a",
  name: "Scout",
  state: "ready",
  driverName: "claude",
  modelId: "claude-sonnet",
};

const AGENT_ON_CODEX = {
  agentId: "agent-b",
  name: "Runner",
  state: "ready",
  driverName: "codex",
  modelId: "gpt-5.6",
};

/** The switch actions as they stand now — re-queried, never held across a render. */
function currentSwitchActions(): HTMLButtonElement[] {
  return [...document.querySelectorAll(".meridian-switch__apply")] as HTMLButtonElement[];
}

/** Edits the account axis, which is a plain input and needs no popup to open. */
function editProviderAccount(container: HTMLElement, value: string): void {
  const input = container.querySelector(".meridian-switch .meridian-axis-field__text");
  fireEvent.change(input as HTMLInputElement, { target: { value } });
}

describe("agent binding column — moving one agent's binding", () => {
  it("issues one config update for a double press", async () => {
    const daemon = new HeldConfigUpdateDaemon([AGENT_ON_CLAUDE]);
    const bridge = bridgeCalling(daemon);
    const { container } = render(
      <AgentBindingColumn models={modelsOver(bridge)} agentId="agent-a" />,
    );
    await settleReads(bridge);

    editProviderAccount(container, "account-2");
    const [deferred] = currentSwitchActions();
    await act(async () => {
      fireEvent.click(deferred as HTMLButtonElement);
      fireEvent.click(deferred as HTMLButtonElement);
    });

    expect(daemon.updateCallCount).toBe(1);
  });

  it("disables both actions and the detach control while one is outstanding", async () => {
    const daemon = new HeldConfigUpdateDaemon([AGENT_ON_CLAUDE]);
    const bridge = bridgeCalling(daemon);
    const { container } = render(
      <AgentBindingColumn models={modelsOver(bridge)} agentId="agent-a" />,
    );
    await settleReads(bridge);

    editProviderAccount(container, "account-2");
    await act(async () => {
      fireEvent.click(currentSwitchActions()[0] as HTMLButtonElement);
    });

    expect(currentSwitchActions().every((action) => action.disabled)).toBe(true);
    expect(currentSwitchActions()[0]?.getAttribute("aria-busy")).toBe("true");
    const detach = [...container.querySelectorAll(".meridian-agent-card__action")].find(
      (action) => action.textContent === "Detach",
    ) as HTMLButtonElement;
    expect(detach.disabled).toBe(true);

    // Negative control for a control that goes busy and stays that way: the settled
    // attempt has to hand it back, or one press has cost the person the surface.
    await act(async () => {
      await daemon.settle({ agentId: "agent-a" });
    });
    expect(currentSwitchActions().every((action) => action.disabled)).toBe(false);
    expect(currentSwitchActions()[0]?.getAttribute("aria-busy")).toBe("false");
  });

  it("shows the settled reply's own settlement", async () => {
    const daemon = new HeldConfigUpdateDaemon([AGENT_ON_CLAUDE]);
    const bridge = bridgeCalling(daemon);
    const { container } = render(
      <AgentBindingColumn models={modelsOver(bridge)} agentId="agent-a" />,
    );
    await settleReads(bridge);

    editProviderAccount(container, "account-2");
    await act(async () => {
      fireEvent.click(currentSwitchActions()[0] as HTMLButtonElement);
    });
    await act(async () => {
      await daemon.settle({
        agentId: "agent-a",
        switch: { status: "pending", switchId: "switch-11", appliesAt: "run_boundary" },
      });
    });

    expect(container.textContent ?? "").toContain("switches at the next run boundary");
  });

  it("carries no draft and no settlement across a move to another agent", async () => {
    // Both agents are in one session's roster and the route moves between them, so
    // the models and the component type are stable and React keeps this subtree
    // mounted: without a key the axes edited for the first are submitted against the
    // second, and the first's settlement is shown under it.
    const daemon = new HeldConfigUpdateDaemon([AGENT_ON_CLAUDE, AGENT_ON_CODEX]);
    const bridge = bridgeCalling(daemon);
    const models = modelsOver(bridge);
    const { container, rerender } = render(
      <AgentBindingColumn models={models} agentId="agent-a" />,
    );
    await settleReads(bridge);

    editProviderAccount(container, "account-2");
    await act(async () => {
      fireEvent.click(currentSwitchActions()[0] as HTMLButtonElement);
    });
    await act(async () => {
      await daemon.settle({
        agentId: "agent-a",
        switch: { status: "pending", switchId: "switch-11", appliesAt: "run_boundary" },
      });
    });
    expect(container.textContent ?? "").toContain("switches at the next run boundary");

    rerender(<AgentBindingColumn models={models} agentId="agent-b" />);

    // The account axis is back to the second agent's own value, no edit is pending
    // against it, and the first agent's settlement is nowhere on its card.
    expect(container.textContent ?? "").toContain("Runner");
    expect(container.textContent ?? "").not.toContain("switches at the next run boundary");
    expect(currentSwitchActions().length).toBe(0);
    const accountInput = container.querySelector(
      ".meridian-switch .meridian-axis-field__text",
    ) as HTMLInputElement;
    expect(accountInput.value).toBe("");
  });
});

describe("agent binding column — attaching a sidekick", () => {
  it("issues one request for a double click", async () => {
    const daemon = new HeldAttachDaemon();
    const bridge = bridgeCalling(daemon);
    const { container } = render(
      <AgentBindingColumn models={modelsOver(bridge)} agentId={undefined} />,
    );
    await settleReads(bridge);

    const submit = await openReadyAttachForm(container);
    await act(async () => {
      fireEvent.click(submit);
      fireEvent.click(submit);
    });

    expect(daemon.attachCallCount).toBe(1);
  });

  it("puts the session and the typed name on the wire, not just the arm's axes", async () => {
    const daemon = new HeldAttachDaemon();
    const bridge = bridgeCalling(daemon);
    const { container } = render(
      <AgentBindingColumn models={modelsOver(bridge)} agentId={undefined} />,
    );
    await settleReads(bridge);

    const submit = await openReadyAttachForm(container, "Reviewer");
    await act(async () => {
      fireEvent.click(submit);
    });

    expect(daemon.attachRequest).toMatchObject({
      sessionId: "session-9",
      name: "Reviewer",
      definitionId: "definition-1",
    });
  });

  it("negative control: an unnamed form never becomes submittable at all", async () => {
    // The pre-fix form was ready on the definition id alone and composed a request
    // carrying neither the session nor a name.
    const daemon = new HeldAttachDaemon();
    const bridge = bridgeCalling(daemon);
    const { container } = render(
      <AgentBindingColumn models={modelsOver(bridge)} agentId={undefined} />,
    );
    await settleReads(bridge);

    await act(async () => {
      fireEvent.click(container.querySelector(".meridian-agent-card__action") as HTMLElement);
    });
    const armButton = [...document.querySelectorAll(".meridian-attach__arm")].find(
      (candidate) => candidate.textContent === "From a definition",
    );
    await act(async () => {
      fireEvent.click(armButton as HTMLElement);
    });
    await act(async () => {
      fireEvent.click(document.querySelector(".meridian-attach__definition-button") as HTMLElement);
    });

    expect(currentSubmitControl().disabled).toBe(true);
    expect(document.body.textContent ?? "").toContain("Still needed: a name");
    expect(daemon.attachCallCount).toBe(0);
  });

  it("negative control: the control re-arms, so a press after settlement asks again", async () => {
    // Without this, the case above would pass over a column that attached exactly
    // once for the life of the mount — a different defect wearing the same green.
    const daemon = new HeldAttachDaemon();
    const bridge = bridgeCalling(daemon);
    const { container } = render(
      <AgentBindingColumn models={modelsOver(bridge)} agentId={undefined} />,
    );
    await settleReads(bridge);

    const submit = await openReadyAttachForm(container);
    await act(async () => {
      fireEvent.click(submit);
    });
    await act(async () => {
      await daemon.settle("agent-scout");
    });
    expect(document.body.textContent ?? "").toContain("agent-scout");

    await act(async () => {
      fireEvent.click(submit);
    });
    expect(daemon.attachCallCount).toBe(2);
  });

  it("disables the control and marks it busy while one attach is outstanding", async () => {
    const daemon = new HeldAttachDaemon();
    const bridge = bridgeCalling(daemon);
    const { container } = render(
      <AgentBindingColumn models={modelsOver(bridge)} agentId={undefined} />,
    );
    await settleReads(bridge);

    const submit = await openReadyAttachForm(container);
    expect(submit.getAttribute("aria-busy")).toBe("false");

    await act(async () => {
      fireEvent.click(submit);
    });
    expect(currentSubmitControl().disabled).toBe(true);
    expect(currentSubmitControl().getAttribute("aria-busy")).toBe("true");

    // Negative control for a control that goes busy and stays that way: the
    // settled attempt has to hand it back, or one refused press has cost the
    // person the form for the life of the mount.
    await act(async () => {
      await daemon.settle("agent-scout");
    });
    expect(currentSubmitControl().disabled).toBe(false);
    expect(currentSubmitControl().getAttribute("aria-busy")).toBe("false");
  });
});
