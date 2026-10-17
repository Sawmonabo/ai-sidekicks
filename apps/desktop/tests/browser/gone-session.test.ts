// Where a window says a session is gone, proved on the composed app in Chromium, where layout and
// scrolling are real. A window opened at the address of a session the background service does not
// hold lands on its start screen, whose logo mark is drawn with nothing of it for assistive
// technology, under it the line saying so. A window that steps back to Workflows off a session
// deleted once it had opened says `Session not found` on the control pressed, brought back into
// view inside the step panel's own scroller, and stays on Workflows. A window that steps back to
// Settings says it at the top of the body, and its going at the next press moves nothing there.

import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { page } from "vitest/browser";

import { createFixtureComposition } from "#renderer/app/fixture/composition.js";
import type { BridgeComposition } from "#renderer/services/platform/bridge-context.js";
import { formatRoute } from "#renderer/routing/routes.js";
import { TRANSCRIPT_STATES_SCENARIO_ID } from "#fixtures/scenarios/transcript-states.js";
import { CONCURRENT_STREAMING_SCENARIO_ID } from "#fixtures/scenarios/concurrent-streaming.js";
import { WORKFLOW_FIX_SESSION, WORKFLOW_RUN_IDS } from "#fixtures/data/workflow/run/records.js";
import { renderAppSettled } from "../helpers/app/harness.js";
import { withDaemonCall, type RecordedDaemonCall } from "../helpers/fixture/bridge.js";
import { politeText } from "../helpers/live-region.js";
import { clearMediaEmulation, emulateReducedMotion } from "../helpers/media-emulation.js";
import { SESSIONS_HASH } from "../helpers/mount-app.js";
import { crossMacrotaskBoundary } from "../helpers/macrotask-boundary.js";
import { advanceScenarioUntil, runningScenario } from "../helpers/scenario/manual-clock.js";

/** A session id the background service answers it does not hold. */
const GONE_SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5a4999";

/** The refusal the background service answers for a session it does not hold. */
const SESSION_NOT_FOUND = { code: "session.not_found", message: "That session is gone." };

/** The tier's own viewport, put back after a case that shrinks it. */
const tierViewport = { width: window.innerWidth, height: window.innerHeight };

/**
 * The scenario's composition with its daemon calls answered by `answer` first: a refusal it
 * throws, or `undefined` to let the scenario answer.
 */
function composedAnswering(
  scenarioId: string,
  answer: (call: RecordedDaemonCall) => object | undefined,
): BridgeComposition {
  const fixture = createFixtureComposition(scenarioId);
  return {
    ...fixture,
    createBridge: () => {
      const composed = fixture.createBridge();
      const { bridge } = withDaemonCall(composed.bridge, async (call, passThrough) => {
        const refusal = answer(call);
        if (refusal !== undefined) {
          throw refusal;
        }
        return passThrough();
      });
      return { ...composed, bridge };
    },
  };
}

/** The session a call names, where it names one. */
function sessionIdOf(call: RecordedDaemonCall): string | undefined {
  return (call.params as { readonly sessionId?: string } | undefined)?.sessionId;
}

/** Every missing-target line the window draws. */
function missingTargetLines(appDocument: Document): Element[] {
  return [...appDocument.querySelectorAll(".meridian-missing-target-line")];
}

/** Whether a node of any window's realm is an element. */
function isElement(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE;
}

/** The button whose words are `label`; throws when none is drawn. */
function buttonNamed(appDocument: Document, label: string): HTMLButtonElement {
  const button = [...appDocument.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) {
    throw new Error(`the window drew no ${label} button`);
  }
  return button;
}

afterEach(async () => {
  cleanup();
  window.location.hash = SESSIONS_HASH;
  await page.viewport(tierViewport.width, tierViewport.height);
  await clearMediaEmulation();
});

describe("a window opened at a session the background service does not hold", () => {
  it("lands on the start screen under the logo mark, saying so until the next act", async () => {
    window.location.hash = formatRoute({ kind: "session", sessionId: GONE_SESSION_ID });
    const ownerWindow = await renderAppSettled(
      TRANSCRIPT_STATES_SCENARIO_ID,
      undefined,
      composedAnswering(TRANSCRIPT_STATES_SCENARIO_ID, (call) =>
        sessionIdOf(call) === GONE_SESSION_ID ? SESSION_NOT_FOUND : undefined,
      ),
    );
    const { document } = ownerWindow;
    const goneLine = (): Element | null =>
      document.querySelector(".meridian-session-empty-view .meridian-missing-target-line");

    await advanceScenarioUntil(runningScenario(), () => {
      expect(goneLine()?.textContent).toBe("That session is not here.");
    });
    expect(ownerWindow.location.hash).toBe(SESSIONS_HASH);
    expect(politeText(document.body)).toBe("That session is not here.");
    const mark = document.querySelector(".meridian-session-empty-view .meridian-logo-mark");
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    expect(mark?.getAttribute("role")).toBeNull();
    expect(mark?.childNodes).toHaveLength(0);

    await act(async () => {
      fireEvent.pointerDown(document.body);
      await crossMacrotaskBoundary();
    });
    expect(goneLine()).toBeNull();
    expect(document.querySelector(".meridian-logo-mark")).not.toBeNull();
  });
});

describe("a window stepping back off a session deleted once it had opened", () => {
  it("says so on the Workflows control pressed, brought back into view, staying on Workflows", async () => {
    const runRoute = formatRoute({
      kind: "workflows",
      tab: "runs",
      runId: WORKFLOW_RUN_IDS.processExited,
    });
    window.location.hash = runRoute;
    // Short, so the failed step's acts sit below the fold of the step panel's own scroller; reduced
    // motion, so the reveal lands at once rather than gliding over frames a frame does not paint.
    await page.viewport(1024, 360);
    await emulateReducedMotion();
    // The fix session's first read fails for a passing cause, so the window still moves to it;
    // by its next read it has been deleted.
    let fixSessionReadCount = 0;
    const { document } = await renderAppSettled(
      CONCURRENT_STREAMING_SCENARIO_ID,
      undefined,
      composedAnswering(CONCURRENT_STREAMING_SCENARIO_ID, (call) => {
        if (call.method !== "session.read" || sessionIdOf(call) !== WORKFLOW_FIX_SESSION) {
          return undefined;
        }
        fixSessionReadCount += 1;
        return fixSessionReadCount === 1
          ? { code: "daemon.busy", message: "The background service is busy." }
          : SESSION_NOT_FOUND;
      }),
    );
    const stepScroller = (): HTMLElement | null =>
      document.querySelector<HTMLElement>(".meridian-workflow-step__scroller");
    await advanceScenarioUntil(runningScenario(), () => {
      expect(stepScroller()).not.toBeNull();
    });

    // Every line drawn from the press on, wherever it lands: the step back draws its line once, on
    // the control, never first at the top of the body while the run's page reads.
    const drawnLines: Element[] = [];
    const lineWatch = new MutationObserver((mutations) => {
      for (const added of mutations.flatMap((mutation) => [...mutation.addedNodes])) {
        // The window's own realm made the node, so it is no `Element` of this one.
        if (isElement(added)) {
          drawnLines.push(
            ...(added.matches(".meridian-missing-target-line") ? [added] : []),
            ...added.querySelectorAll(".meridian-missing-target-line"),
          );
        }
      }
    });
    lineWatch.observe(document.body, { childList: true, subtree: true });
    onTestFinished(() => {
      lineWatch.disconnect();
    });

    await act(async () => {
      fireEvent.click(buttonNamed(document, "Fix in a fresh session"));
      await crossMacrotaskBoundary();
    });
    await advanceScenarioUntil(runningScenario(), () => {
      expect(fixSessionReadCount).toBeGreaterThan(1);
      expect(stepScroller()).not.toBeNull();
      expect(missingTargetLines(document).map((line) => line.textContent)).toStrictEqual([
        "Session not found",
      ]);
    });

    // Still on the run's page. Its address is not read: this tier's windows are frames, whose Back
    // walks the page's own history, so the store's test holds the history write.
    expect(document.querySelector(".meridian-workflow-run")).not.toBeNull();
    const acts = document.querySelector<HTMLElement>(".meridian-workflow-step__acts");
    expect(drawnLines).toHaveLength(1);
    expect(acts?.contains(drawnLines[0] ?? null)).toBe(true);
    expect(politeText(document.body)).toBe("Session not found");
    const scroller = stepScroller();
    if (scroller === null || acts === null) {
      throw new Error("the step panel is not drawn");
    }
    // The panel reopened at its top with the acts below its fold, so it scrolled to show them.
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
    const actsBox = acts.getBoundingClientRect();
    const scrollerBox = scroller.getBoundingClientRect();
    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect(actsBox.top).toBeGreaterThanOrEqual(scrollerBox.top);
    expect(actsBox.bottom).toBeLessThanOrEqual(scrollerBox.bottom + 0.5);
  });

  it("says so at the top of Settings, and its going at the next press moves nothing", async () => {
    const settingsRoute = formatRoute({ kind: "settings", page: undefined });
    window.location.hash = settingsRoute;
    const ownerWindow = await renderAppSettled(
      TRANSCRIPT_STATES_SCENARIO_ID,
      undefined,
      composedAnswering(TRANSCRIPT_STATES_SCENARIO_ID, (call) =>
        sessionIdOf(call) === GONE_SESSION_ID ? SESSION_NOT_FOUND : undefined,
      ),
    );
    const { document } = ownerWindow;
    const goneLine = (): Element | null =>
      document.querySelector(".meridian-settings__gone-session .meridian-missing-target-line");

    // Back into a session deleted since: the address change enters it, and its read says gone.
    await act(async () => {
      ownerWindow.location.hash = formatRoute({ kind: "session", sessionId: GONE_SESSION_ID });
      await crossMacrotaskBoundary();
    });
    await advanceScenarioUntil(runningScenario(), () => {
      expect(goneLine()?.textContent).toBe("Session not found");
    });
    expect(ownerWindow.location.hash).toBe(settingsRoute);
    const listPane = document.querySelector<HTMLElement>(".meridian-settings__list-pane");
    if (listPane === null) {
      throw new Error("Settings drew no page list");
    }
    const standing = listPane.getBoundingClientRect();

    await act(async () => {
      fireEvent.pointerDown(listPane);
      await crossMacrotaskBoundary();
    });

    expect(goneLine()).toBeNull();
    const gone = listPane.getBoundingClientRect();
    expect({ top: gone.top, left: gone.left }).toStrictEqual({
      top: standing.top,
      left: standing.left,
    });
  });
});
