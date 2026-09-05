// Moving a live agent's binding: one request per intended action, and a settlement
// that belongs to the agent it was asked about.
//
// `agent.configUpdate` acts on an agent that already exists and can move it onto a
// different driver, model, or paying account, so the property worth this file is that
// a double press costs one request and that the settlement shown is the settled
// reply's rather than whichever landed last. Both are invisible against a call that
// answers immediately, which is why every case here drives a held-open daemon.
//
// The column's other two subjects have their own files —
// `AgentBindingColumn.attach.test.tsx` and `AgentBindingColumn.detach.test.tsx` — and
// the scaffolding all three share is `agent-binding-column.test-support.ts`.

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { settleReads } from "./agent-console.test-support.js";
import {
  AGENT_ON_CLAUDE,
  AGENT_ON_CODEX,
  HeldBindingMoveDaemon,
  bridgeCalling,
  currentSwitchActions,
  disposeOpenedModels,
  editProviderAccount,
  modelsOver,
} from "./agent-binding-column.test-support.js";
import { AgentBindingColumn } from "./AgentBindingColumn.js";

afterEach(disposeOpenedModels);

describe("agent binding column — moving one agent's binding", () => {
  it("issues one config update for a double press", async () => {
    const scriptedDaemon = new HeldBindingMoveDaemon([AGENT_ON_CLAUDE]);
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
    const scriptedDaemon = new HeldBindingMoveDaemon([AGENT_ON_CLAUDE]);
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
    const scriptedDaemon = new HeldBindingMoveDaemon([AGENT_ON_CLAUDE]);
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
    const scriptedDaemon = new HeldBindingMoveDaemon([AGENT_ON_CLAUDE, AGENT_ON_CODEX]);
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

describe("agent binding column — a switch reply whose subject the column has left", () => {
  it("installs nothing when a switch reply lands after the console moved agents", async () => {
    // The render-time comparison hides such a settlement; it does not stop it
    // arriving. Without the round being abandoned, the reply installed into state
    // that was merely not being shown — and the moment the console came back to the
    // agent it was about, an answer read against a subject nobody was looking at was
    // there waiting under it.
    const scriptedDaemon = new HeldBindingMoveDaemon([AGENT_ON_CLAUDE, AGENT_ON_CODEX]);
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
    const scriptedDaemon = new HeldBindingMoveDaemon([AGENT_ON_CLAUDE, AGENT_ON_CODEX]);
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
});

describe("agent binding column — what a disabled control says", () => {
  it("names why the switch actions are not taking a press", async () => {
    const scriptedDaemon = new HeldBindingMoveDaemon([AGENT_ON_CLAUDE]);
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
    const scriptedDaemon = new HeldBindingMoveDaemon([AGENT_ON_CLAUDE]);
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
