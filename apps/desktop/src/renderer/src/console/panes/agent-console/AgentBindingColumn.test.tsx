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
import { DRIVER_CATALOG_FIXTURE } from "../../agents/driver-catalog.test-support.js";
import {
  fixtureBridgeWithGrowth,
  growthAnswering,
  unscriptedScenario,
  withDaemonCall,
} from "../../bridge/fixture-bridge.test-support.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { SessionStore } from "../../store/index.js";
import { AgentBindingColumn } from "./AgentBindingColumn.js";

/**
 * The definition the picker offers, so the form reaches its ready state.
 *
 * A whole registry row rather than an id and a label: the registry answers full
 * records — `null` is how a stored row says "inherit", never absence — and the
 * picker projects that row onto its own summary. A partial literal would be
 * teaching the projection a shape the registry cannot serve.
 */
const DEFINITION = {
  definitionId: "definition-1",
  name: "Reviewer",
  description: "",
  driverName: "claude",
  modelId: "claude-sonnet",
  providerAccountId: null,
  effort: null,
  executionPostureMode: null,
  instructions: "",
  goal: null,
  toolAllowlist: null,
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:00:00.000Z",
};

/**
 * A daemon that answers the picker's read and holds `agent.attach` open.
 *
 * The count is the whole assertion: "one agent exists" is also true of a column
 * that issued two requests and lost one of the replies.
 */
class HeldAttachDaemon {
  #attachCallCount = 0;
  #attachRequest: unknown;
  readonly #heldReplies: ((reading: unknown) => void)[] = [];

  public get attachCallCount(): number {
    return this.#attachCallCount;
  }

  /** What the column actually put on the wire, not what the form believed. */
  public get attachRequest(): unknown {
    return this.#attachRequest;
  }

  public readonly answer = async (method: string, params?: unknown): Promise<unknown> => {
    if (method === "sidekick.definitionList") {
      return [DEFINITION];
    }
    if (method === "agent.attach") {
      this.#attachCallCount += 1;
      this.#attachRequest = params;
      return await new Promise<unknown>((resolve) => {
        this.#heldReplies.push(resolve);
      });
    }
    throw new Error(`the test daemon scripts no reply for ${method}`);
  };

  /** Settle the OLDEST held reply — the one a reversed order lands last. */
  public async settle(agentId: string): Promise<void> {
    await this.#release(this.#heldReplies.shift(), agentId);
  }

  /** Settle the NEWEST held reply, leaving anything older still outstanding. */
  public async settleNewest(agentId: string): Promise<void> {
    await this.#release(this.#heldReplies.pop(), agentId);
  }

  async #release(
    resolve: ((reading: unknown) => void) | undefined,
    agentId: string,
  ): Promise<void> {
    resolve?.({ agentId });
    await Promise.resolve();
    await Promise.resolve();
  }
}

/**
 * What either test daemon below exposes to the bridge.
 *
 * `answer` rather than `call`, and held to that name deliberately: this object is a
 * per-method reply script, not the bridge every surface shares. A stand-in whose
 * operation were named `call` on a holder named for the daemon would be
 * indistinguishable in source text from a surface reaching the real call door —
 * which is what `test/console/architecture/daemon-reply-chokepoint.test.ts` scans
 * for, and it would flag this file.
 */
interface ScriptedDaemon {
  readonly answer: (method: string, params?: unknown) => Promise<unknown>;
}

/**
 * The real fixture bridge, answering this suite's scripted daemon on both seams.
 *
 * TWO seams, because the agent console reaches two. The four `agent.*` verbs and the
 * definition list have no registered request/response pair anywhere in the corpus,
 * so they are growth operations and a suite decides their answers by overriding the
 * growth port. The two driver catalog reads ARE registered, so they go through the
 * call door and reach the bridge's own call arm — through the shared
 * `withDaemonCall`, which is where the reach lives, so this file holds no copy of
 * the bridge's namespace shape.
 *
 * The scripted daemon is keyed by method name across both, which is what lets one
 * class answer a surface that talks to two seams without knowing that it does.
 */
function bridgeCalling(scriptedDaemon: ScriptedDaemon): ConsoleBridge {
  const base = fixtureBridgeWithGrowth(unscriptedScenario("agent-console-attach"), {
    agentList: growthAnswering(
      async (request) => await scriptedDaemon.answer("agent.list", request),
    ),
    agentAttach: growthAnswering(
      async (request) => await scriptedDaemon.answer("agent.attach", request),
    ),
    agentConfigUpdate: growthAnswering(
      async (request) => await scriptedDaemon.answer("agent.configUpdate", request),
    ),
    agentDetach: growthAnswering(
      async (request) => await scriptedDaemon.answer("agent.detach", request),
    ),
    sidekickDefinitionList: growthAnswering(
      async (request) => await scriptedDaemon.answer("sidekick.definitionList", request),
    ),
    orchestrationChildRunLinkRead: growthAnswering(
      async (request) => await scriptedDaemon.answer("orchestration.childRunLinkRead", request),
    ),
  });
  return withDaemonCall(
    base,
    async ({ method, params }) => await scriptedDaemon.answer(method, params),
  ).bridge;
}

const openedModels: AgentConsoleModels[] = [];

afterEach(() => {
  for (const models of openedModels.splice(0, openedModels.length)) {
    models.dispose();
  }
});

/** The real models over that bridge, disposed after the test that opened them. */
function modelsOver(bridge: ConsoleBridge, sessionId = "session-9"): AgentConsoleModels {
  const models = new AgentConsoleModels(bridge, new SessionStore({ sessionId }));
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

  public readonly answer = async (method: string): Promise<unknown> => {
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
      return [DEFINITION];
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
    const scriptedDaemon = new HeldConfigUpdateDaemon([AGENT_ON_CLAUDE]);
    const bridge = bridgeCalling(scriptedDaemon);
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

    expect(scriptedDaemon.updateCallCount).toBe(1);
  });

  it("disables both actions and the detach control while one is outstanding", async () => {
    const scriptedDaemon = new HeldConfigUpdateDaemon([AGENT_ON_CLAUDE]);
    const bridge = bridgeCalling(scriptedDaemon);
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
      await scriptedDaemon.settle({ agentId: "agent-a" });
    });
    expect(currentSwitchActions().every((action) => action.disabled)).toBe(false);
    expect(currentSwitchActions()[0]?.getAttribute("aria-busy")).toBe("false");
  });

  it("shows the settled reply's own settlement", async () => {
    const scriptedDaemon = new HeldConfigUpdateDaemon([AGENT_ON_CLAUDE]);
    const bridge = bridgeCalling(scriptedDaemon);
    const { container } = render(
      <AgentBindingColumn models={modelsOver(bridge)} agentId="agent-a" />,
    );
    await settleReads(bridge);

    editProviderAccount(container, "account-2");
    await act(async () => {
      fireEvent.click(currentSwitchActions()[0] as HTMLButtonElement);
    });
    await act(async () => {
      await scriptedDaemon.settle({
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
    const scriptedDaemon = new HeldConfigUpdateDaemon([AGENT_ON_CLAUDE, AGENT_ON_CODEX]);
    const bridge = bridgeCalling(scriptedDaemon);
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
      await scriptedDaemon.settle({
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
    const scriptedDaemon = new HeldAttachDaemon();
    const bridge = bridgeCalling(scriptedDaemon);
    const { container } = render(
      <AgentBindingColumn models={modelsOver(bridge)} agentId={undefined} />,
    );
    await settleReads(bridge);

    const submit = await openReadyAttachForm(container);
    await act(async () => {
      fireEvent.click(submit);
      fireEvent.click(submit);
    });

    expect(scriptedDaemon.attachCallCount).toBe(1);
  });

  it("puts the session and the typed name on the wire, not just the arm's axes", async () => {
    const scriptedDaemon = new HeldAttachDaemon();
    const bridge = bridgeCalling(scriptedDaemon);
    const { container } = render(
      <AgentBindingColumn models={modelsOver(bridge)} agentId={undefined} />,
    );
    await settleReads(bridge);

    const submit = await openReadyAttachForm(container, "Reviewer");
    await act(async () => {
      fireEvent.click(submit);
    });

    expect(scriptedDaemon.attachRequest).toMatchObject({
      sessionId: "session-9",
      name: "Reviewer",
      definitionId: "definition-1",
    });
  });

  it("negative control: an unnamed form never becomes submittable at all", async () => {
    // The pre-fix form was ready on the definition id alone and composed a request
    // carrying neither the session nor a name.
    const scriptedDaemon = new HeldAttachDaemon();
    const bridge = bridgeCalling(scriptedDaemon);
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
    expect(scriptedDaemon.attachCallCount).toBe(0);
  });

  it("negative control: the control re-arms, so a press after settlement asks again", async () => {
    // Without this, the case above would pass over a column that attached exactly
    // once for the life of the mount — a different defect wearing the same green.
    const scriptedDaemon = new HeldAttachDaemon();
    const bridge = bridgeCalling(scriptedDaemon);
    const { container } = render(
      <AgentBindingColumn models={modelsOver(bridge)} agentId={undefined} />,
    );
    await settleReads(bridge);

    const submit = await openReadyAttachForm(container);
    await act(async () => {
      fireEvent.click(submit);
    });
    await act(async () => {
      await scriptedDaemon.settle("agent-scout");
    });
    expect(document.body.textContent ?? "").toContain("agent-scout");

    await act(async () => {
      fireEvent.click(submit);
    });
    expect(scriptedDaemon.attachCallCount).toBe(2);
  });

  it("disables the control and marks it busy while one attach is outstanding", async () => {
    const scriptedDaemon = new HeldAttachDaemon();
    const bridge = bridgeCalling(scriptedDaemon);
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
      await scriptedDaemon.settle("agent-scout");
    });
    expect(currentSubmitControl().disabled).toBe(false);
    expect(currentSubmitControl().getAttribute("aria-busy")).toBe("false");
  });
});

describe("agent binding column — a reply whose subject the column has left", () => {
  it("installs nothing when a switch reply lands after the console moved agents", async () => {
    // The render-time comparison hides such a settlement; it does not stop it
    // arriving. Without the round being abandoned, the reply installed into state
    // that was merely not being shown — and the moment the console came back to the
    // agent it was about, an answer read against a subject nobody was looking at was
    // there waiting under it.
    const scriptedDaemon = new HeldConfigUpdateDaemon([AGENT_ON_CLAUDE, AGENT_ON_CODEX]);
    const bridge = bridgeCalling(scriptedDaemon);
    const models = modelsOver(bridge);
    const { container, rerender } = render(
      <AgentBindingColumn models={models} agentId="agent-a" />,
    );
    await settleReads(bridge);

    editProviderAccount(container, "account-2");
    await act(async () => {
      fireEvent.click(currentSwitchActions()[0] as HTMLButtonElement);
    });

    rerender(<AgentBindingColumn models={models} agentId="agent-b" />);
    await act(async () => {
      await scriptedDaemon.settle({
        agentId: "agent-a",
        switch: { status: "pending", switchId: "switch-11", appliesAt: "run_boundary" },
      });
    });

    rerender(<AgentBindingColumn models={models} agentId="agent-a" />);

    expect(container.textContent ?? "").toContain("Scout");
    expect(container.textContent ?? "").not.toContain("switches at the next run boundary");
  });

  it("negative control: the same reply installs where the console did not move", async () => {
    // Without this the case above would hold for a column that discarded every
    // reply — which would leave a person's accepted switch invisible forever.
    const scriptedDaemon = new HeldConfigUpdateDaemon([AGENT_ON_CLAUDE, AGENT_ON_CODEX]);
    const bridge = bridgeCalling(scriptedDaemon);
    const models = modelsOver(bridge);
    const { container } = render(<AgentBindingColumn models={models} agentId="agent-a" />);
    await settleReads(bridge);

    editProviderAccount(container, "account-2");
    await act(async () => {
      fireEvent.click(currentSwitchActions()[0] as HTMLButtonElement);
    });
    await act(async () => {
      await scriptedDaemon.settle({
        agentId: "agent-a",
        switch: { status: "pending", switchId: "switch-11", appliesAt: "run_boundary" },
      });
    });

    expect(container.textContent ?? "").toContain("switches at the next run boundary");
  });

  it("lets the newer attach settlement stand when an abandoned round answers last", async () => {
    // The generation rather than the latch. Moving sessions abandons the round in
    // flight and hands the control back, so a second attach is admitted while the
    // first call is still outstanding and the two replies may land in either order.
    const scriptedDaemon = new HeldAttachDaemon();
    const bridge = bridgeCalling(scriptedDaemon);
    const firstSession = modelsOver(bridge, "session-first");
    const secondSession = modelsOver(bridge, "session-second");
    const { container, rerender } = render(
      <AgentBindingColumn models={firstSession} agentId={undefined} />,
    );
    await settleReads(bridge);

    const submit = await openReadyAttachForm(container);
    await act(async () => {
      fireEvent.click(submit);
    });
    expect(currentSubmitControl().disabled).toBe(true);

    // Away and back. The round for the session left is abandoned, and the control
    // is handed back for the session the console is on.
    rerender(<AgentBindingColumn models={secondSession} agentId={undefined} />);
    await settleReads(bridge);
    rerender(<AgentBindingColumn models={firstSession} agentId={undefined} />);
    await settleReads(bridge);
    expect(currentSubmitControl().disabled).toBe(false);

    await act(async () => {
      fireEvent.click(currentSubmitControl());
    });
    expect(scriptedDaemon.attachCallCount).toBe(2);

    await act(async () => {
      await scriptedDaemon.settleNewest("agent-second");
    });
    expect(document.body.textContent ?? "").toContain("agent-second");

    // The abandoned round answers last and says something else. It must change
    // nothing: it is the answer to a question that was replaced.
    await act(async () => {
      await scriptedDaemon.settle("agent-first");
    });

    expect(document.body.textContent ?? "").toContain("agent-second");
    expect(document.body.textContent ?? "").not.toContain("agent-first");
  });
});

describe("agent binding column — what a disabled control says", () => {
  it("names why the switch actions are not taking a press", async () => {
    const scriptedDaemon = new HeldConfigUpdateDaemon([AGENT_ON_CLAUDE]);
    const bridge = bridgeCalling(scriptedDaemon);
    const { container } = render(
      <AgentBindingColumn models={modelsOver(bridge)} agentId="agent-a" />,
    );
    await settleReads(bridge);

    editProviderAccount(container, "account-2");
    await act(async () => {
      fireEvent.click(currentSwitchActions()[0] as HTMLButtonElement);
    });

    // Disabled is half the answer: a control that stops responding and says nothing
    // is indistinguishable from one that is broken.
    const applyAction = currentSwitchActions()[0] as HTMLButtonElement;
    expect(applyAction.disabled).toBe(true);
    const describedBy = applyAction.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent ?? "").toContain(
      "no second change until the daemon answers the first",
    );
  });

  it("negative control: with nothing outstanding the actions are live and describe nothing", async () => {
    // Without this, the case above would hold for a form that is disabled and
    // explaining itself in every state, which is a control nobody can ever use.
    const scriptedDaemon = new HeldConfigUpdateDaemon([AGENT_ON_CLAUDE]);
    const bridge = bridgeCalling(scriptedDaemon);
    const { container } = render(
      <AgentBindingColumn models={modelsOver(bridge)} agentId="agent-a" />,
    );
    await settleReads(bridge);
    editProviderAccount(container, "account-2");

    const applyAction = currentSwitchActions()[0] as HTMLButtonElement;
    expect(applyAction.disabled).toBe(false);
    expect(applyAction.getAttribute("aria-describedby")).toBeNull();
  });
});
