// The workflows screen under the window's route: away from the Runs tab it reads only the runs
// count, `Next waiting` walks the runs owed an answer and never claims nothing is waiting before it
// knows, the runs a sitting answered, on their pages or on a session's question card, are counted
// beside `Nothing waiting`, and the runs table's filters narrow the table alone, come back after a
// reload, and keep working, saying so, when the store fails.

import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WORKFLOW_REPLY_QUESTION, WORKFLOW_RUN_IDS } from "#fixtures/data/workflow/run/records.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { advanceScenarioUntil } from "#test/helpers/scenario-manual-clock.js";
import { workflowRunsRoute } from "#renderer/routing/readers.js";
import { WORKFLOW_NOTICE_STREAM } from "#renderer/services/daemon/session/event/session-event-streams.js";
import {
  PersistenceAdapterError,
  type StoredRecord,
} from "#renderer/store/persistence/persistence-adapter.js";
import { refusePersistence } from "#renderer/store/persistence/refusals.js";
import { MemoryPersistenceAdapter } from "#renderer/store/persistence/memory-persistence-adapter.js";
import { UiStateStore } from "#renderer/store/persistence/ui-state-store.js";
import {
  attentionOf,
  isRunsTableRead,
  mountWorkflowsScreen,
  navigate,
  nextWaitingControl,
  openRunId,
  press,
} from "./WorkflowsScreen.test-support.js";

afterEach(cleanup);

describe("the workflows screen — away from the Runs tab", () => {
  it("reads only the runs count, and opens the rest once the Runs tab is drawn", async () => {
    const streamsOpened: string[] = [];
    const mounted = await mountWorkflowsScreen({
      route: { kind: "workflows" },
      openStream: (passThrough, _handler, _request, _onEnded, event) => {
        streamsOpened.push(event);
        return passThrough();
      },
    });
    const methodsAsked = () => new Set(mounted.calls.map((call) => call.method));
    await advanceScenarioUntil(mounted.engine, () => {
      expect(document.querySelector(".meridian-workflows-tabs__count")).not.toBeNull();
    });
    // Nothing on screen draws what is waiting, the saved workflows, the accounts or the stream.
    expect(methodsAsked()).toStrictEqual(new Set(["workflow.runList"]));
    expect(streamsOpened).not.toContain(WORKFLOW_NOTICE_STREAM);

    await navigate(mounted, workflowRunsRoute(undefined));
    await advanceScenarioUntil(mounted.engine, () => {
      expect(nextWaitingControl().textContent).toMatch(/^Next waiting \(\d+\)$/u);
    });
    expect(methodsAsked()).toContain("workflow.runAttentionList");
    expect(streamsOpened).toContain(WORKFLOW_NOTICE_STREAM);
  });
});

describe("the workflows screen — `Next waiting`", () => {
  it("walks the runs owed an answer, skipping the open one, to `Nothing waiting`", async () => {
    // The runs still owed an answer; a run leaves once it is dealt with.
    let owed: readonly string[] = [WORKFLOW_RUN_IDS.waitingApproval, WORKFLOW_RUN_IDS.waitingForm];
    const mounted = await mountWorkflowsScreen({
      route: workflowRunsRoute(undefined),
      answer: async (call, passThrough) => {
        const reply = await passThrough();
        return call.method === "workflow.runAttentionList" ? attentionOf(reply, owed) : reply;
      },
    });
    await advanceScenarioUntil(mounted.engine, () => {
      expect(nextWaitingControl().textContent).toBe("Next waiting (2)");
    });

    await press("Next waiting (2)");
    expect(openRunId(mounted)).toBe(WORKFLOW_RUN_IDS.waitingApproval);
    // From a run's own page the count is of the others, and the open run is never next.
    expect(nextWaitingControl().textContent).toBe("Next waiting (1)");
    await press("Next waiting (1)");
    expect(openRunId(mounted)).toBe(WORKFLOW_RUN_IDS.waitingForm);

    owed = [];
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await crossMacrotaskBoundary();
    });
    await advanceScenarioUntil(mounted.engine, () => {
      expect(nextWaitingControl().textContent).toBe("Nothing waiting");
    });
    expect(nextWaitingControl().disabled).toBe(true);
  });

  it("never reads `Nothing waiting` while what is waiting is unread, and says why on a run's page", async () => {
    let isAttentionRefused = true;
    const mounted = await mountWorkflowsScreen({
      route: workflowRunsRoute(WORKFLOW_RUN_IDS.succeeded),
      answer: async (call, passThrough) => {
        if (call.method === "workflow.runAttentionList" && isAttentionRefused) {
          throw new Error("The background service dropped the read.");
        }
        return passThrough();
      },
    });
    // Before the read answers, the control names no count and offers nothing to open.
    expect(nextWaitingControl().textContent).toBe("Next waiting");
    expect(nextWaitingControl().disabled).toBe(true);

    await advanceScenarioUntil(mounted.engine, () => {
      expect(
        document.querySelector(".meridian-workflows-strip .meridian-refusal")?.textContent,
      ).toContain("The background service is not answering.");
    });
    expect(nextWaitingControl().textContent).toBe("Next waiting");
    expect(nextWaitingControl().disabled).toBe(true);

    isAttentionRefused = false;
    await act(async () => {
      fireEvent.click(
        within(document.querySelector<HTMLElement>(".meridian-workflows-strip")!).getByRole(
          "button",
          { name: "Try again" },
        ),
      );
      await crossMacrotaskBoundary();
    });
    await advanceScenarioUntil(mounted.engine, () => {
      expect(nextWaitingControl().textContent).toMatch(/^Next waiting \(\d+\)$/u);
    });
    expect(document.querySelector(".meridian-workflows-strip .meridian-refusal")).toBeNull();
  });
});

describe("the workflows screen — what this sitting answered", () => {
  it("counts a run answered on its page once, beside `Nothing waiting`", async () => {
    // Nothing is owed a person once the approval is answered.
    let owed: readonly string[] = [WORKFLOW_RUN_IDS.waitingApproval];
    const mounted = await mountWorkflowsScreen({
      route: workflowRunsRoute(WORKFLOW_RUN_IDS.waitingApproval),
      answer: async (call, passThrough) => {
        const reply = await passThrough();
        return call.method === "workflow.runAttentionList" ? attentionOf(reply, owed) : reply;
      },
    });
    await advanceScenarioUntil(mounted.engine, () => {
      expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    });

    owed = [];
    await press("Approve");
    await advanceScenarioUntil(mounted.engine, () => {
      expect(screen.getByText(/^Approved at /u)).toBeTruthy();
    });
    await navigate(mounted);

    await advanceScenarioUntil(mounted.engine, () => {
      expect(document.querySelector(".meridian-workflows-attention__nothing")?.textContent).toMatch(
        /^Nothing waiting · you answered 1 run this (morning|afternoon|evening)$/u,
      );
    });
  });

  it("counts a run answered on a session's question card while the list is open", async () => {
    let owed: readonly string[] = [WORKFLOW_RUN_IDS.waitingReply];
    const mounted = await mountWorkflowsScreen({
      route: workflowRunsRoute(undefined),
      answer: async (call, passThrough) => {
        const reply = await passThrough();
        return call.method === "workflow.runAttentionList" ? attentionOf(reply, owed) : reply;
      },
    });
    await advanceScenarioUntil(mounted.engine, () => {
      expect(nextWaitingControl().textContent).toBe("Next waiting (1)");
    });

    owed = [];
    // The session's card answers the run's question through the same daemon, off this screen.
    await act(async () => {
      void mounted.bridge.daemon.call("question.resolve", {
        questionId: WORKFLOW_REPLY_QUESTION.questionId,
        answers: [{ kind: "typed", text: "needs-triage" }],
      });
      await crossMacrotaskBoundary();
    });
    await advanceScenarioUntil(mounted.engine, () => {
      expect(document.querySelector(".meridian-workflows-attention__nothing")?.textContent).toMatch(
        /^Nothing waiting · you answered 1 run this (morning|afternoon|evening)$/u,
      );
    });
  });
});

describe("the workflows screen — the runs table's filters", () => {
  it("narrow the table and never what is waiting above it", async () => {
    const mounted = await mountWorkflowsScreen({ route: workflowRunsRoute(undefined) });
    const attentionLines = (): (string | null)[] =>
      Array.from(
        document.querySelectorAll(".meridian-workflows-attention__entry"),
        (entry) => entry.textContent,
      );
    await advanceScenarioUntil(mounted.engine, () => {
      expect(attentionLines().length).toBeGreaterThan(0);
      expect(screen.getByRole("columnheader", { name: "Started by" })).toBeTruthy();
    });
    const linesBefore = attentionLines();

    // Every line above waits on a person or an account; a succeeded-only table holds none of them.
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Status"), { target: { value: "succeeded" } });
      await crossMacrotaskBoundary();
    });
    await advanceScenarioUntil(mounted.engine, () => {
      expect(mounted.calls.filter(isRunsTableRead).at(-1)?.params).toMatchObject({
        status: ["succeeded"],
      });
      // The succeeded runs' answer is drawn, not the one it replaces.
      expect(
        document.querySelector(".meridian-workflows-runs__list")?.getAttribute("aria-busy"),
      ).toBe("false");
    });
    expect(attentionLines()).toStrictEqual(linesBefore);
  });

  it("comes back after a reload with the filters it was left on", async () => {
    const adapter = new MemoryPersistenceAdapter();
    const first = await mountWorkflowsScreen({
      route: workflowRunsRoute(undefined),
      uiStateStore: new UiStateStore({ adapter }),
    });
    await advanceScenarioUntil(first.engine, () => {
      expect(screen.getByRole("columnheader", { name: "Started by" })).toBeTruthy();
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Status"), { target: { value: "failed" } });
      await crossMacrotaskBoundary();
    });
    first.unmount();

    const reloaded = await mountWorkflowsScreen({
      route: workflowRunsRoute(undefined),
      uiStateStore: new UiStateStore({ adapter }),
    });

    await advanceScenarioUntil(reloaded.engine, () => {
      expect(screen.getByLabelText<HTMLSelectElement>("Status").value).toBe("failed");
      expect(reloaded.calls.filter(isRunsTableRead).at(-1)?.params).toMatchObject({
        status: ["failed"],
      });
    });
  });

  it("draws and filters when the store refuses, saying the filters were not read or kept", async () => {
    const mounted = await mountWorkflowsScreen({
      route: workflowRunsRoute(undefined),
      uiStateStore: new UiStateStore({ adapter: new FailingPersistenceAdapter() }),
    });
    // The saved filters could not be read: that is said at once, never taken for none saved.
    await advanceScenarioUntil(mounted.engine, () => {
      expect(screen.getByRole("columnheader", { name: "Started by" })).toBeTruthy();
      expect(
        document.querySelector(".meridian-workflows-runs .meridian-refusal")?.textContent,
      ).toContain("Could not read what you last set here, so this view starts from its defaults.");
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Status"), { target: { value: "failed" } });
      await crossMacrotaskBoundary();
    });

    await advanceScenarioUntil(mounted.engine, () => {
      expect(mounted.calls.filter(isRunsTableRead).at(-1)?.params).toMatchObject({
        status: ["failed"],
      });
      expect(document.querySelector(".meridian-workflows-runs .meridian-refusal")).not.toBeNull();
    });
    expect(screen.getByLabelText<HTMLSelectElement>("Status").value).toBe("failed");
  });
});

/** A store whose every read and write throws, as a store whose database went away does. */
class FailingPersistenceAdapter extends MemoryPersistenceAdapter {
  public override read(): Promise<StoredRecord | undefined> {
    return Promise.reject(DATABASE_GONE);
  }

  public override write(): Promise<void> {
    return Promise.reject(DATABASE_GONE);
  }
}

/** What the failing store throws. */
const DATABASE_GONE = new PersistenceAdapterError(
  refusePersistence("adapter-unavailable", "the database went away"),
);
