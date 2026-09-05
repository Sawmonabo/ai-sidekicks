// The scaffolding all three `AgentBindingColumn` suites are driven with.
//
// The column has three subjects — attaching a sidekick, moving a live agent's
// binding, and detaching one — and one 677-line file held all three, which is two
// jobs too many by this package's own rule. Splitting it left the daemon scripts, the
// bridge, the roster fixtures, and the DOM queries needed by more than one of the
// three, so they live here once rather than being copied into the file that happened
// to be written second.
//
// THE DAEMONS ARE HELD-CALL SCRIPTS, not stubs. Every property these suites exist to
// assert — one request for a double press, a control that goes busy, a reply landing
// after the console moved — is invisible against a call that settles on the next
// microtask, because that makes every ordering look correct. So each script holds its
// call open and hands the case the moment it settles.
//
// `answer` rather than `call`, and held to that name deliberately: these objects are
// per-method reply scripts, not the bridge every surface shares. A stand-in whose
// operation were named `call` on a holder named for the daemon would be
// indistinguishable in source text from a surface reaching the real call door — which
// is what `test/console/architecture/daemon-reply-chokepoint.test.ts` scans for.

import { act, fireEvent } from "@testing-library/react";
import { expect } from "vitest";

import { AgentConsoleModels } from "../../agents/index.js";
import { DRIVER_CATALOG_FIXTURE } from "../../agents/driver-catalog.test-support.js";
import {
  fixtureBridgeWithGrowth,
  growthAnswering,
  unscriptedScenario,
} from "../../bridge/fixture-bridge.test-support.js";
import { withDaemonCall } from "../../bridge/fixture-bridge.test-support.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { SessionStore } from "../../store/index.js";

/**
 * The definition the picker offers, so the form reaches its ready state.
 *
 * A whole registry row rather than an id and a label: the registry answers full
 * records — `null` is how a stored row says "inherit", never absence — and the
 * picker projects that row onto its own summary. A partial literal would be
 * teaching the projection a shape the registry cannot serve.
 */
export const DEFINITION = {
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
export class HeldAttachDaemon {
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
export interface ScriptedDaemon {
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
export function bridgeCalling(scriptedDaemon: ScriptedDaemon): ConsoleBridge {
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

/**
 * Dispose every models object a case opened. Each suite calls it from its own
 * `afterEach`, rather than this module registering one on import: a hook that
 * attaches itself to whichever file happens to import a helper is a lifecycle a
 * reader of that file cannot see.
 */
export function disposeOpenedModels(): void {
  for (const models of openedModels.splice(0, openedModels.length)) {
    models.dispose();
  }
}

/** The real models over that bridge, disposed after the test that opened them. */
export function modelsOver(bridge: ConsoleBridge, sessionId = "session-9"): AgentConsoleModels {
  const models = new AgentConsoleModels(bridge, new SessionStore({ sessionId }));
  openedModels.push(models);
  return models;
}

/** The submit control as it stands now — re-queried, never held across a render. */
export function currentSubmitControl(): HTMLButtonElement {
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
export async function openReadyAttachForm(
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
 * A daemon that answers the roster and catalog reads and holds either BINDING MOVE
 * open — `agent.configUpdate` and `agent.detach` — counting how often each was called.
 *
 * The count is the whole assertion for the double press, and holding the call open is
 * what makes the failure visible: a reply delivered on the next microtask makes every
 * ordering look correct. Both moves share one held slot because the column gives them
 * one latch: two outstanding at once is the state the latch exists to make impossible.
 */
export class HeldBindingMoveDaemon {
  #updateCallCount = 0;
  #detachCallCount = 0;
  #release: ((reading: unknown) => void) | undefined;
  #reject: ((reason: unknown) => void) | undefined;
  readonly #roster: readonly unknown[];

  public constructor(roster: readonly unknown[]) {
    this.#roster = roster;
  }

  public get updateCallCount(): number {
    return this.#updateCallCount;
  }

  /** How often `agent.detach` reached the wire. */
  public get detachCallCount(): number {
    return this.#detachCallCount;
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
      return await this.#hold();
    }
    if (method === "agent.detach") {
      this.#detachCallCount += 1;
      return await this.#hold();
    }
    throw new Error(`the test daemon scripts no reply for ${method}`);
  };

  public async settle(reply: unknown): Promise<void> {
    this.#release?.(reply);
    await Promise.resolve();
    await Promise.resolve();
  }

  /** Refuse the held call, so a case can read what the column does with a refusal. */
  public async refuse(reason: unknown): Promise<void> {
    this.#reject?.(reason);
    await Promise.resolve();
    await Promise.resolve();
  }

  async #hold(): Promise<unknown> {
    return await new Promise<unknown>((resolve, reject) => {
      this.#release = resolve;
      this.#reject = reject;
    });
  }
}

export const AGENT_ON_CLAUDE = {
  agentId: "agent-a",
  name: "Scout",
  state: "ready",
  driverName: "claude",
  modelId: "claude-sonnet",
};

export const AGENT_ON_CODEX = {
  agentId: "agent-b",
  name: "Runner",
  state: "ready",
  driverName: "codex",
  modelId: "gpt-5.6",
};

/** The switch actions as they stand now — re-queried, never held across a render. */
export function currentSwitchActions(): HTMLButtonElement[] {
  return [...document.querySelectorAll(".meridian-switch__apply")] as HTMLButtonElement[];
}

/** Edits the account axis, which is a plain input and needs no popup to open. */
export function editProviderAccount(container: HTMLElement, value: string): void {
  const input = container.querySelector(".meridian-switch .meridian-axis-field__text");
  fireEvent.change(input as HTMLInputElement, { target: { value } });
}

/** The detach control as it stands now — re-queried, never held across a render. */
export function currentDetachControl(container: HTMLElement): HTMLButtonElement {
  const detach = [...container.querySelectorAll(".meridian-agent-card__action")].find(
    (action) => action.textContent === "Detach",
  );
  expect(detach).not.toBeUndefined();
  return detach as HTMLButtonElement;
}
