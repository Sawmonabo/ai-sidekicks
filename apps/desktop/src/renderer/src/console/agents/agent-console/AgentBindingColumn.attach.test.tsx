// Attaching a sidekick: the second press of a double click reaches the wire never.
//
// `agent.attach` creates a durable agent, so that is the property worth a whole file.
// It is asserted against the REAL models over a bridge whose daemon call this suite
// holds open, because the failure is invisible against a call that settles: a reply
// delivered on the next microtask makes every ordering look correct.
//
// The refusal being INVISIBLE is a second defect beside the double request, so the
// disabled-and-busy affordance is asserted here rather than on the form alone: the
// column is the only place the latch's arm and the control's attributes meet, and a
// form flag agreeing with itself would prove nothing about which one is true.
//
// The column's other two subjects have their own files —
// `AgentBindingColumn.switch.test.tsx` and `AgentBindingColumn.detach.test.tsx` — and
// the scaffolding all three share is `agent-binding-column.test-support.ts`.

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { settleReads } from "./agent-console.test-support.js";
import {
  HeldAttachDaemon,
  bridgeCalling,
  currentSubmitControl,
  disposeOpenedModels,
  modelsOver,
  openReadyAttachForm,
} from "./agent-binding-column.test-support.js";
import { AgentBindingColumn } from "./AgentBindingColumn.js";

afterEach(disposeOpenedModels);

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

describe("agent binding column — an attach reply whose subject the column has left", () => {
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
