// What the attention surface draws, driven through the projection that folds it.
//
// The cases build `RunListProjection` rather than hand-built entries, on
// `RunList.test.tsx`'s reason: a suite that constructed its own fold would prove the
// markup and leave the seam between the fold and the surface — the part that can
// actually drift — unchecked. What is asserted here is the RENDERING; the fold's own
// arithmetic is `park-attention-fold.test.ts`.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RunList } from "./RunList.js";
import { RunListProjection } from "./run-list-projection.js";
import type { WorkflowPhaseStateRow, WorkflowRunSnapshot } from "./run-list-rows.js";
import { phase, run } from "./run-list-projection.test-support.js";

function renderList(runs: readonly WorkflowRunSnapshot[]): HTMLElement {
  const { container } = render(<RunList projection={new RunListProjection(runs)} />);
  const root = container.firstElementChild;
  if (!(root instanceof HTMLElement)) {
    throw new Error("the list rendered nothing");
  }
  return root;
}

function attentionEntries(root: HTMLElement): readonly HTMLElement[] {
  return [...root.querySelectorAll(".meridian-run-attention__entry")].filter(
    (entry): entry is HTMLElement => entry instanceof HTMLElement,
  );
}

/** Every summary item's text, which is where the badge lives. */
function summaryItems(root: HTMLElement): readonly string[] {
  return [...root.querySelectorAll(".meridian-run-list__summary-item")].map(
    (item) => item.textContent ?? "",
  );
}

function correlatedPark(parkAttentionKey: string): WorkflowPhaseStateRow {
  return phase({
    phaseId: "draft",
    parkReason: "provider-usage-limited",
    parkCause: "The account's window is spent.",
    parkAttentionKey,
  });
}

describe("the run list's park attention surface", () => {
  it("draws one entry for several runs waiting on one account, with the run count", () => {
    const root = renderList([
      run({ workflowRunId: "run-a", phaseStates: [correlatedPark("account-1")] }),
      run({ workflowRunId: "run-b", phaseStates: [correlatedPark("account-1")] }),
    ]);

    const entries = attentionEntries(root);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?.textContent).toContain("Waiting on provider capacity");
    // The key verbatim, in the mono provenance signature every wire value wears.
    expect(entry?.querySelector(".meridian-figure--wire")?.textContent).toBe("account-1");
    expect(entry?.textContent).toContain("Runs affected");
    expect(entry?.querySelector(".meridian-figure--derived")?.textContent).toBe("2");
  });

  it("badges the number of entries and never the number of runs", () => {
    // The two counts answer different questions and are deliberately different
    // numbers: `Parked` is runs, `Waiting on` is causes.
    const root = renderList([
      run({ workflowRunId: "run-a", phaseStates: [correlatedPark("account-1")] }),
      run({ workflowRunId: "run-b", phaseStates: [correlatedPark("account-1")] }),
      run({ workflowRunId: "run-c", phaseStates: [correlatedPark("account-1")] }),
    ]);

    const items = summaryItems(root);
    expect(items).toContain("Parked 3");
    expect(items).toContain("Waiting on 1");
  });

  it("spends amber on a fold whose parks end only when a person ends them", () => {
    const root = renderList([
      run({ workflowRunId: "run-a", phaseStates: [correlatedPark("account-1")] }),
    ]);

    const chip = attentionEntries(root)[0]?.querySelector(".meridian-chip");
    expect(chip?.classList.contains("meridian-chip--attention")).toBe(true);
  });

  it("spends none on a fold the engine armed a resume for", () => {
    const armed = phase({
      phaseId: "draft",
      parkReason: "provider-usage-limited",
      parkCause: "The account's window is spent.",
      parkAttentionKey: "account-1",
      autoResumeAt: "2026-09-01T11:00:00.000Z",
    });
    const root = renderList([run({ workflowRunId: "run-a", phaseStates: [armed] })]);

    const chip = attentionEntries(root)[0]?.querySelector(".meridian-chip");
    expect(chip?.classList.contains("meridian-chip--attention")).toBe(false);
    expect(chip?.classList.contains("meridian-chip--neutral")).toBe(true);
  });

  it("gives an uncorrelated park its own entry, naming the run it belongs to", () => {
    const root = renderList([
      run({
        workflowRunId: "run-a",
        phaseStates: [
          phase({ phaseId: "sign-off", parkReason: "waiting-human", parkCause: "Sign it off." }),
        ],
      }),
    ]);

    const entries = attentionEntries(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.classList.contains("meridian-run-attention__entry--single")).toBe(true);
    expect(entries[0]?.textContent).toContain("run-a");
    // The same park card the run's own row draws, through the same component.
    expect(entries[0]?.querySelector(".meridian-park")).not.toBeNull();
  });

  it("draws nothing at all when nothing is parked", () => {
    const root = renderList([run({ workflowRunId: "run-a" })]);

    expect(root.querySelector(".meridian-run-attention")).toBeNull();
    expect(summaryItems(root).some((item) => item.startsWith("Waiting on"))).toBe(false);
  });

  it("negative control: the surface is absent for the reason claimed, not always", () => {
    // Without this, the case above would pass against a component that rendered
    // nothing under every input — including the parked one it exists to draw.
    const root = renderList([
      run({ workflowRunId: "run-a", phaseStates: [correlatedPark("account-1")] }),
    ]);

    expect(root.querySelector(".meridian-run-attention")).not.toBeNull();
  });
});
