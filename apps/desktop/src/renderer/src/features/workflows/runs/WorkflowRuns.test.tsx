// The runs section, drawn from the read state its caller supplies.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { WorkflowRunListEntry } from "@renderer/services/wire-shapes/workflow-projection.js";
import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import {
  PROBE_RUNS,
  VERSION_INCIDENT_TRIAGE_LATEST,
  VERSION_RELEASE_CHECKS_LATEST,
  VERSION_SHIP_PIPELINE_LATEST,
  VERSION_SHIP_PIPELINE_PINNED,
  settle,
} from "../workflows-probe.test-support.js";
import type { WorkflowRunDirectoryState } from "./hooks/useWorkflowRunDirectory.js";
import { WorkflowRuns } from "./WorkflowRuns.js";

/** The definition each pinned version belongs to, and that definition's newest version. */
const DEFINITION_OF_VERSION: Readonly<
  Record<string, { readonly name: string; readonly latestWorkflowVersionId: string }>
> = {
  [VERSION_RELEASE_CHECKS_LATEST]: {
    name: "Release checks",
    latestWorkflowVersionId: VERSION_RELEASE_CHECKS_LATEST,
  },
  [VERSION_SHIP_PIPELINE_LATEST]: {
    name: "Ship pipeline",
    latestWorkflowVersionId: VERSION_SHIP_PIPELINE_LATEST,
  },
  [VERSION_SHIP_PIPELINE_PINNED]: {
    name: "Ship pipeline",
    latestWorkflowVersionId: VERSION_SHIP_PIPELINE_LATEST,
  },
  [VERSION_INCIDENT_TRIAGE_LATEST]: {
    name: "Incident triage",
    latestWorkflowVersionId: VERSION_INCIDENT_TRIAGE_LATEST,
  },
};

/** The four probe runs as an enumeration answers with them: definition facts included. */
const RUN_ENTRIES: readonly WorkflowRunListEntry[] = PROBE_RUNS.map((run) => {
  const definition = DEFINITION_OF_VERSION[run.workflowVersionId];
  if (definition === undefined) {
    throw new Error(`no definition is paired with run ${run.workflowRunId}`);
  }
  return {
    ...run,
    definitionName: definition.name,
    definitionLatestWorkflowVersionId: definition.latestWorkflowVersionId,
  };
});

/**
 * The same runs as a daemon that sent no definition facts would answer.
 *
 * Cast because the entry type requires the name: the projection tolerates its absence,
 * and this is the one way to reach that arm.
 */
const RUNS_WITHOUT_DEFINITION_FACTS = PROBE_RUNS as unknown as readonly WorkflowRunListEntry[];

function served(runs: readonly WorkflowRunListEntry[]): WorkflowRunDirectoryState {
  return { status: "served", runs };
}

function renderRuns(directory: WorkflowRunDirectoryState): {
  readonly container: HTMLElement;
  readonly rerender: () => void;
} {
  const element = (
    <LiveAnnouncerProvider>
      <WorkflowRuns directory={directory} />
    </LiveAnnouncerProvider>
  );
  const { container, rerender } = render(element);
  return {
    container,
    rerender: () => {
      rerender(element);
    },
  };
}

function rowLabels(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-run-row__name")].map(
    (name) => name.textContent ?? "",
  );
}

/** Every run row's own identity, which the meta line carries whatever the label says. */
function rowRunIds(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-run-row__meta")].map(
    (meta) => meta.querySelector(".meridian-figure--wire")?.textContent ?? "",
  );
}

/** The one running run, which is also the newest by its start. */
const NEWEST_RUN = PROBE_RUNS.find((candidate) => candidate.state === "running");
if (NEWEST_RUN === undefined) {
  throw new Error("the probe runs hold no running run");
}

function politeAnnouncement(container: HTMLElement): string {
  const region = container.querySelector<HTMLElement>('[data-live-region="polite"]');
  if (region === null) {
    throw new Error("no polite live region was mounted");
  }
  return region.textContent ?? "";
}

describe("the runs the session holds", () => {
  it("draws every run the enumeration served, newest first", async () => {
    const { container } = renderRuns(served(RUN_ENTRIES));
    await settle();

    expect(rowLabels(container)).toHaveLength(4);
    // Asserted on the row's own identity rather than its label, which is the
    // definition's name and repeats across runs.
    expect(rowRunIds(container)[0]).toBe(NEWEST_RUN.workflowRunId);
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });

  it("names each run by the definition it was started from", async () => {
    // Without the definition facts every row falls back to an opaque run id, which is
    // not the thing a person is looking for.
    const { container } = renderRuns(served(RUN_ENTRIES));
    await settle();

    expect(rowLabels(container)).toStrictEqual([
      "Release checks",
      "Ship pipeline",
      "Incident triage",
      "Ship pipeline",
    ]);
  });

  it("marks the run pinned to a version its definition has moved past", async () => {
    // The frozen pin is an inequality between the run's pinned version and the
    // definition's newest, and only the enumeration carries the second.
    const { container } = renderRuns(served(RUN_ENTRIES));
    await settle();

    const frozen = [...container.querySelectorAll(".meridian-run-row")].filter((row) =>
      row.textContent?.includes("Frozen on an older version"),
    );
    expect(frozen).toHaveLength(1);
    expect(container.querySelector(".meridian-run-list__summary")?.textContent).toContain(
      "Frozen pins",
    );
  });

  it("negative control: entries without the definition facts fall back to ids and no mark", async () => {
    // The three claims above rest on the join being real. Without the two members the
    // list must draw opaque ids, and a frozen state reported as unknown, not guessed.
    const { container } = renderRuns(served(RUNS_WITHOUT_DEFINITION_FACTS));
    await settle();

    expect(rowLabels(container)).toStrictEqual(rowRunIds(container));
    expect(container.textContent).not.toContain("Frozen on an older version");
    expect(container.querySelector(".meridian-run-list__summary")?.textContent).not.toContain(
      "Frozen pins",
    );
  });

  it("negative control: an enumeration with no runs draws the empty absence", async () => {
    // Served-and-empty is a real answer: the list says there are none rather than that
    // nothing was asked.
    const { container } = renderRuns(served([]));
    await settle();

    expect(rowLabels(container)).toHaveLength(0);
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
  });
});

describe("what the runs section says out loud", () => {
  it("announces the settlement once, with what it read", async () => {
    const { container, rerender } = renderRuns(served(RUN_ENTRIES));
    await settle();

    expect(politeAnnouncement(container)).toBe("Runs in this session: 4.");

    rerender();
    await settle();

    // Negative control: the same settlement re-rendered says nothing further. A
    // repeat would talk over the section it just described.
    expect(politeAnnouncement(container)).toBe("Runs in this session: 4.");
  });
});
