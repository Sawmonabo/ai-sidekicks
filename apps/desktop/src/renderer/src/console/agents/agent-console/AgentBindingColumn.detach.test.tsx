// Detaching an agent, and the address the column's busy state belongs to.
//
// A detach ends an agent, and it shares one latch with the switch — so what this file
// is about is the state a press LEAVES: while the call is outstanding the control has
// to say so, and a refusal has to reach the same line a refused switch does.
//
// WHY THE RE-ADDRESS CASES ARE HERE, AND WHAT THEY DO NOT CLAIM. Both binding moves
// publish which agent the round is about, and that value is held for the addressing it
// was published under, so a handler carrying a retired publisher writes nothing and the
// column shows nothing at all — no busy control, no refusal — over an act that reached
// the wire and ended an agent. The two moves were written out separately and one left
// the publisher off its dependency list, which is that hazard sitting one edit away;
// they now go through one admission, where the publisher is named once and neither
// caller can omit it.
//
// It is stated as a hazard rather than as a defect these cases catch, because it is
// not reachable TODAY and saying otherwise would be a comment about a test rather than
// about the code: `useCallback` compares its dependencies against the immediately
// previous render, and both the subject and the key of this holder are read off the
// `models` prop, so every script that moves the addressing also moves a dependency the
// omission still listed. What follows is regression coverage that a detach across a
// re-address keeps its busy state and its refusal — which is what a reader would come
// here to check — and not a control that fails on the shape it replaced.
//
// The column's other two subjects have their own files —
// `AgentBindingColumn.attach.test.tsx` and `AgentBindingColumn.switch.test.tsx` — and
// the scaffolding all three share is `agent-binding-column.test-support.ts`.

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { settleReads } from "./agent-console.test-support.js";
import {
  AGENT_ON_CLAUDE,
  HeldBindingMoveDaemon,
  bridgeCalling,
  currentDetachControl,
  disposeOpenedModels,
  modelsOver,
} from "./agent-binding-column.test-support.js";
import { AgentBindingColumn } from "./AgentBindingColumn.js";

afterEach(disposeOpenedModels);

describe("agent binding column — detaching an agent", () => {
  it("marks the control busy while the detach is outstanding", async () => {
    const scriptedDaemon = new HeldBindingMoveDaemon([AGENT_ON_CLAUDE]);
    const bridge = bridgeCalling(scriptedDaemon);
    const { container } = render(
      <AgentBindingColumn models={modelsOver(bridge)} agentId="agent-a" />,
    );
    await settleReads(bridge);

    await act(async () => {
      fireEvent.click(currentDetachControl(container));
    });

    expect(scriptedDaemon.detachCallCount).toBe(1);
    expect(currentDetachControl(container).disabled).toBe(true);
  });

  it("negative control: with nothing pressed the control takes a press", async () => {
    // Without this, every assertion below would hold for a column whose detach was
    // disabled from the first frame — which reports an outstanding call forever.
    const scriptedDaemon = new HeldBindingMoveDaemon([AGENT_ON_CLAUDE]);
    const bridge = bridgeCalling(scriptedDaemon);
    const { container } = render(
      <AgentBindingColumn models={modelsOver(bridge)} agentId="agent-a" />,
    );
    await settleReads(bridge);

    expect(currentDetachControl(container).disabled).toBe(false);
    expect(scriptedDaemon.detachCallCount).toBe(0);
  });

  it("still says so after the console left these models and came back", async () => {
    // s1 → s2 → s1: the third visit is the same pair as the first and a DIFFERENT
    // addressing, which is why the holder serialises visits rather than comparing the
    // pair — the first visit's publisher is not valid on the third. What this asserts
    // is that the press still reports itself across that move.
    const scriptedDaemon = new HeldBindingMoveDaemon([AGENT_ON_CLAUDE]);
    const bridge = bridgeCalling(scriptedDaemon);
    const firstModels = modelsOver(bridge);
    const secondModels = modelsOver(bridge, "session-10");
    const mounted = render(<AgentBindingColumn models={firstModels} agentId="agent-a" />);
    await settleReads(bridge);

    mounted.rerender(<AgentBindingColumn models={secondModels} agentId="agent-a" />);
    await settleReads(bridge);
    mounted.rerender(<AgentBindingColumn models={firstModels} agentId="agent-a" />);
    await settleReads(bridge);

    await act(async () => {
      fireEvent.click(currentDetachControl(mounted.container));
    });

    // Both halves, because a detach that reaches the wire while the column reports
    // nothing is the worst pair available: an irreversible act performed by a surface
    // that showed no sign of performing it.
    expect(scriptedDaemon.detachCallCount).toBe(1);
    expect(currentDetachControl(mounted.container).disabled).toBe(true);
  });

  it("renders a refused detach on the binding's own refusal line", async () => {
    const scriptedDaemon = new HeldBindingMoveDaemon([AGENT_ON_CLAUDE]);
    const bridge = bridgeCalling(scriptedDaemon);
    const { container } = render(
      <AgentBindingColumn models={modelsOver(bridge)} agentId="agent-a" />,
    );
    await settleReads(bridge);

    await act(async () => {
      fireEvent.click(currentDetachControl(container));
    });
    await act(async () => {
      await scriptedDaemon.refuse(new Error("the agent is mid-run"));
    });

    expect(container.textContent ?? "").toContain("the agent is mid-run");
    // And the control comes back: a refusal that left it disabled would cost the
    // person the surface over an act that did not happen.
    expect(currentDetachControl(container).disabled).toBe(false);
  });

  it("renders it after a re-address too, where the settlement had nowhere to land", async () => {
    const scriptedDaemon = new HeldBindingMoveDaemon([AGENT_ON_CLAUDE]);
    const bridge = bridgeCalling(scriptedDaemon);
    const firstModels = modelsOver(bridge);
    const secondModels = modelsOver(bridge, "session-10");
    const mounted = render(<AgentBindingColumn models={firstModels} agentId="agent-a" />);
    await settleReads(bridge);

    mounted.rerender(<AgentBindingColumn models={secondModels} agentId="agent-a" />);
    await settleReads(bridge);
    mounted.rerender(<AgentBindingColumn models={firstModels} agentId="agent-a" />);
    await settleReads(bridge);

    await act(async () => {
      fireEvent.click(currentDetachControl(mounted.container));
    });
    await act(async () => {
      await scriptedDaemon.refuse(new Error("the agent is mid-run"));
    });

    expect(mounted.container.textContent ?? "").toContain("the agent is mid-run");
  });
});
