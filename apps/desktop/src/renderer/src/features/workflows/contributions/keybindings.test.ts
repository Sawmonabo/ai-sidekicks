// `Answer this run` through the window's real keybinding table, on a run waiting on an approval:
// its chord pressed inside a text field is the field's own and answers nothing, and the same chord
// pressed anywhere else, with the step panel closed, opens the waiting step and approves it once
// its answer is offered. On a run waiting on a form, a press made while the form is still being
// read submits it once it has been read. Where an act cannot be taken its command says why and
// its chord does nothing, leaving the key unclaimed and raising no refusal.

import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { WORKFLOW_RUN_IDS } from "#fixtures/data/workflow/run/records.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { advanceScenarioUntil } from "#test/helpers/scenario/manual-clock.js";
import { CommandRegistry } from "#renderer/registries/commands/registry.js";
import { parseChord } from "#renderer/registries/keybindings/chord.js";
import { KeybindingTable } from "#renderer/registries/keybindings/table.js";
import { workflowRunsRoute } from "#renderer/routing/readers.js";
import { createWorkflowCommandTargets, type WorkflowCommandTargets } from "../command-target.js";
import { mountWorkflowsScreen } from "../WorkflowsScreen.test-support.js";
import { createWorkflowCommands } from "./commands.js";
import { WORKFLOW_KEY_BINDINGS } from "./keybindings.js";
import { publishCommandWindow } from "#renderer/registries/commands/command-window.js";

/**
 * Press `commandId`'s chord on `target`, with the modifiers the chord names on this platform, and
 * hand back the key press, which says whether a command claimed it.
 */
async function pressChordOf(commandId: string, target: EventTarget): Promise<KeyboardEvent> {
  const binding = WORKFLOW_KEY_BINDINGS.find((candidate) => candidate.commandId === commandId);
  const parsed = binding === undefined ? undefined : parseChord(binding.chord);
  if (parsed === undefined || !parsed.ok || typeof parsed.press[2] !== "string") {
    throw new Error(`the workflows screen binds no chord to ${commandId}`);
  }
  const [modifiers, , code] = parsed.press;
  const keyPress = new KeyboardEvent("keydown", {
    code,
    key: code,
    bubbles: true,
    cancelable: true,
    ctrlKey: modifiers.includes("Control"),
    metaKey: modifiers.includes("Meta"),
    altKey: modifiers.includes("Alt"),
    shiftKey: modifiers.includes("Shift"),
  });
  await act(async () => {
    target.dispatchEvent(keyPress);
    await crossMacrotaskBoundary();
  });
  return keyPress;
}

/**
 * Register the workflows screen's commands under its real chords on `document`, pressing the acts
 * the mounted screen offers, until the test finishes, whether it passed or not.
 */
function installWorkflowChords(commandTargets: WorkflowCommandTargets): CommandRegistry {
  const registry = new CommandRegistry();
  for (const command of createWorkflowCommands(commandTargets)) {
    registry.register(command);
  }
  const table = new KeybindingTable({ registry, readContext: () => ({ onWorkflows: true }) });
  table.setBindings(WORKFLOW_KEY_BINDINGS);
  onTestFinished(table.install(document));
  return registry;
}

afterEach(cleanup);
// A command acts in the window used last; the test's document stands in for it.
beforeEach(() => publishCommandWindow(() => document));

describe("the workflows screen's chords", () => {
  it("leaves `Answer this run` to a text field, and from anywhere else approves the waiting step", async () => {
    const mounted = await mountWorkflowsScreen({
      route: workflowRunsRoute(WORKFLOW_RUN_IDS.waitingApproval),
    });
    onTestFinished(mounted.unmount);
    installWorkflowChords(mounted.commandTargets);
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
      expect(screen.getByText(/^Approved at/u)).toBeDefined();
    });
    expect(approvals()).toBe(1);
  });

  it("submits a form pressed while it is still being read once it has been read", async () => {
    const mounted = await mountWorkflowsScreen({
      route: workflowRunsRoute(WORKFLOW_RUN_IDS.waitingForm),
    });
    onTestFinished(mounted.unmount);
    installWorkflowChords(mounted.commandTargets);
    await advanceScenarioUntil(mounted.engine, () => {
      expect(mounted.calls.some((call) => call.method === "workflow.humanFormRead")).toBe(true);
    });
    expect(screen.queryByText("Write the release notes for this version.")).toBeNull();

    await pressChordOf("workflows.answerThisRun", document.body);
    // The form's required fields are empty, so the submit it waited for says so in place.
    await advanceScenarioUntil(mounted.engine, () => {
      expect(screen.getAllByText("Fill in this field.").length).toBeGreaterThan(0);
    });
  });

  it("says why an act cannot be taken, and leaves its chord unclaimed with no refusal", async () => {
    const registry = installWorkflowChords(createWorkflowCommandTargets());
    expect(registry.get("workflows.nextWaiting")?.unavailable).toBe("Workflows is not open.");
    expect(registry.get("workflows.answerThisRun")?.unavailable).toBe(
      "No run waiting on you is open.",
    );
    // No refusal sink is published, so a press that raised one would throw here.
    expect((await pressChordOf("workflows.nextWaiting", document.body)).defaultPrevented).toBe(
      false,
    );
    expect((await pressChordOf("workflows.answerThisRun", document.body)).defaultPrevented).toBe(
      false,
    );

    const mounted = await mountWorkflowsScreen({
      route: workflowRunsRoute(WORKFLOW_RUN_IDS.succeeded),
    });
    onTestFinished(mounted.unmount);
    const onScreen = installWorkflowChords(mounted.commandTargets);
    await advanceScenarioUntil(mounted.engine, () => {
      expect(screen.getByRole("heading", { level: 2 })).toBeDefined();
    });
    expect(onScreen.get("workflows.answerThisRun")?.unavailable).toBe(
      "This run is not waiting on you.",
    );
    expect((await pressChordOf("workflows.answerThisRun", document.body)).defaultPrevented).toBe(
      false,
    );
  });
});
