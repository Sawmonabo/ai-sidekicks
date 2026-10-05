// A pane another screen asks this session for, the way a workflow run's `Open in Review` asks:
// it opens over the saved arrangement once that has landed, never before (a pane opened ahead of
// the read belongs to the previous session and is dropped); a second ask for the same run
// re-points that pane; a later ask opens at once; and a reload restores the comparison asked.

import { cleanup, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { WorkflowRunSnapshotPoint } from "@ai-sidekicks/contracts/gitflow/local";
import type { SessionId } from "@ai-sidekicks/contracts/session/session";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/run";

import { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import { openSessionPane } from "@renderer/store/window/open-session-pane.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import {
  GatedPersistenceAdapter,
  SCENARIO,
  SESSION_ID,
  saveLayout,
  sessionStore,
  workspaceFor,
} from "./SessionScreen.test-support.js";

const START: WorkflowRunSnapshotPoint = { epoch: 1, point: "start" };
const END: WorkflowRunSnapshotPoint = { epoch: 1, point: "end" };
const FIRST_PAUSE: WorkflowRunSnapshotPoint = { epoch: 1, point: "pause", pauseNumber: 1 };

/** Each pane on screen, in order, as its kind and the entity it was opened over. */
function panesOnScreen(container: HTMLElement): readonly unknown[] {
  return [...container.querySelectorAll<HTMLElement>("[data-body]")].map((body) => ({
    kind: body.dataset["body"],
    entity: JSON.parse(body.dataset["entity"] ?? "null") as unknown,
  }));
}

/** Ask for Review over a run in the fixture session, as the run page's doors do. */
function askForRunReview(
  frameStore: WindowStore,
  workflowRunId: string,
  to: WorkflowRunSnapshotPoint,
): void {
  openSessionPane(frameStore, {
    sessionId: SESSION_ID as SessionId,
    address: {
      kind: "diff",
      entity: { kind: "workflow-run", id: workflowRunId as WorkflowRunId, from: START, to },
    },
  });
}

/** The pane the layout shows for Review over one run comparison. */
function runReviewPane(workflowRunId: string, to: WorkflowRunSnapshotPoint): unknown {
  return { kind: "diff", entity: { kind: "workflow-run", id: workflowRunId, from: START, to } };
}

/** The session screen for the fixture session over `store`, in a window store of its own. */
function mountScreen(store: UiStateStore, frameStore: WindowStore): HTMLElement {
  return render(
    workspaceFor(
      { sessionId: SESSION_ID, store: sessionStore() },
      store,
      createFixtureBridge({ scenario: SCENARIO }),
      frameStore,
    ),
  ).container;
}

describe("SessionScreen — a pane another screen asked for", () => {
  it("opens once the arrangement lands, re-points, and a reload restores it", async () => {
    const adapter = new GatedPersistenceAdapter();
    const store = new UiStateStore({ adapter });
    await saveLayout(store, SESSION_ID, ["transcript", "terminal"]);
    adapter.holdReads();
    const frameStore = new WindowStore({ initialRoute: { kind: "sessions" } });
    askForRunReview(frameStore, "run-1", END);
    expect(frameStore.getState().route).toStrictEqual({ kind: "session", sessionId: SESSION_ID });

    const container = mountScreen(store, frameStore);
    // The record is still being read: nothing is opened over a layout that is not there yet.
    expect(panesOnScreen(container)).toStrictEqual([]);

    adapter.releaseReads();
    const transcript = { kind: "transcript", entity: null };
    const terminal = { kind: "terminal", entity: null };
    await waitFor(() => {
      expect(panesOnScreen(container)).toStrictEqual([
        transcript,
        terminal,
        runReviewPane("run-1", END),
      ]);
    });

    // The approval step's door on the same run re-points the pane rather than opening another.
    askForRunReview(frameStore, "run-1", FIRST_PAUSE);
    askForRunReview(frameStore, "run-2", END);
    const arranged = [
      transcript,
      terminal,
      runReviewPane("run-1", FIRST_PAUSE),
      runReviewPane("run-2", END),
    ];
    await waitFor(() => {
      expect(panesOnScreen(container)).toStrictEqual(arranged);
    });
    // Each ask was taken once: nothing is left held to open again.
    expect(frameStore.paneOpenRequests.take(SESSION_ID)).toBeUndefined();

    // A reload: the saved arrangement brings back each run's Review on the points last asked.
    await waitFor(() => {
      expect(JSON.stringify(adapter.asked.at(-1)?.value)).toContain('"toPoint":"pause"');
    });
    cleanup();
    const reloaded = mountScreen(store, new WindowStore({ initialRoute: { kind: "sessions" } }));
    await waitFor(() => {
      expect(panesOnScreen(reloaded)).toStrictEqual(arranged);
    });
  });
});
