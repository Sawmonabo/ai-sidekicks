// `Answer this run` through the window's real keybinding table, on a run waiting on an approval:
// its chord pressed inside a text field is the field's own and answers nothing, and the same chord
// pressed anywhere else, with the step panel closed, opens the waiting step and approves it once
// its answer is offered. On a run waiting on a form, a press made while the form is still being
// read submits it once it has been read.

import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WORKFLOW_RUN_IDS } from "@fixtures/data/workflow-runs.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { advanceScenarioUntil } from "@test/helpers/scenario-manual-clock.js";
import { CommandRegistry } from "@renderer/registries/commands/command-registry.js";
import { parseChord } from "@renderer/registries/keybindings/keybinding-chord.js";
import { KeybindingTable } from "@renderer/registries/keybindings/keybinding-table.js";
import { workflowRunsRoute } from "@renderer/routing/route-readers.js";
import { answerThisRunTarget, nextWaitingTarget } from "../workflow-command-target.js";
import { mountWorkflowsScreen } from "../WorkflowsScreen.test-support.js";
import { createWorkflowCommands } from "./commands.js";
import { WORKFLOW_KEY_BINDINGS } from "./keybindings.js";
import { publishCommandWindow } from "@renderer/registries/commands/command-window.js";

/** Press `commandId`'s chord on `target`, with the modifiers the chord names on this platform. */
async function pressChordOf(commandId: string, target: EventTarget): Promise<void> {
  const binding = WORKFLOW_KEY_BINDINGS.find((candidate) => candidate.commandId === commandId);
  const parsed = binding === undefined ? undefined : parseChord(binding.chord);
  if (parsed === undefined || !parsed.ok || typeof parsed.press[2] !== "string") {
    throw new Error(`the workflows screen binds no chord to ${commandId}`);
  }
  const [modifiers, , code] = parsed.press;
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        code,
        key: code,
        bubbles: true,
        ctrlKey: modifiers.includes("Control"),
        metaKey: modifiers.includes("Meta"),
        altKey: modifiers.includes("Alt"),
        shiftKey: modifiers.includes("Shift"),
      }),
    );
    await crossMacrotaskBoundary();
  });
}

/** Register the workflows screen's commands under its real chords on `document`. */
function installWorkflowChords(): () => void {
  const registry = new CommandRegistry();
  for (const command of createWorkflowCommands({
    nextWaiting: nextWaitingTarget,
    answerThisRun: answerThisRunTarget,
  })) {
    registry.register(command);
  }
  const table = new KeybindingTable({ registry, readContext: () => ({ onWorkflows: true }) });
  table.setBindings(WORKFLOW_KEY_BINDINGS);
  return table.install(document);
}

afterEach(cleanup);
// A command acts in the window used last; the test's document stands in for it.
beforeEach(() => publishCommandWindow(() => document));

describe("the workflows screen's chords", () => {
  it("leaves `Answer this run` to a text field, and from anywhere else approves the waiting step", async () => {
    const mounted = await mountWorkflowsScreen({
      route: workflowRunsRoute(WORKFLOW_RUN_IDS.waitingApproval),
    });
    const dispose = installWorkflowChords();
    await advanceScenarioUntil(mounted.engine, () => {
      expect(screen.getByRole("button", { name: "Approve" })).toBeDefined();
    });
    // Closed, so the press has no answer on screen and must open the step before it can approve.
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("button", { name: "Approve" }), { key: "Escape" });
      await crossMacrotaskBoundary();
    });
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    const field = document.createElement("input");
    document.body.append(field);
    const approvals = (): number =>
      mounted.calls.filter((call) => call.method === "workflow.gateResolve").length;

    await pressChordOf("workflows.answerThisRun", field);
    expect(approvals()).toBe(0);

    await pressChordOf("workflows.answerThisRun", document.body);
    expect(
      mounted.calls.filter((call) => call.method === "workflow.gateResolve").at(-1)?.params,
    ).toMatchObject({ workflowRunId: WORKFLOW_RUN_IDS.waitingApproval, decision: "approved" });
    await advanceScenarioUntil(mounted.engine, () => {
      expect(screen.getByText(/^Approved at /u)).toBeDefined();
    });
    expect(approvals()).toBe(1);
    dispose();
    mounted.unmount();
  });

  it("submits a form pressed while it is still being read once it has been read", async () => {
    const mounted = await mountWorkflowsScreen({
      route: workflowRunsRoute(WORKFLOW_RUN_IDS.waitingForm),
    });
    const dispose = installWorkflowChords();
    await advanceScenarioUntil(mounted.engine, () => {
      expect(mounted.calls.some((call) => call.method === "workflow.humanFormRead")).toBe(true);
    });
    expect(screen.queryByText("Write the release notes for this version.")).toBeNull();

    await pressChordOf("workflows.answerThisRun", document.body);
    // The form's required fields are empty, so the submit it waited for says so in place.
    await advanceScenarioUntil(mounted.engine, () => {
      expect(screen.getAllByText("This field is required.").length).toBeGreaterThan(0);
    });
    dispose();
    mounted.unmount();
  });
});
