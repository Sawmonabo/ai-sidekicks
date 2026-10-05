// The attention list draws the daemon's grouping as given: its account lines and its run lines,
// in the daemon's order, with no sorting or regrouping of its own. Until the read has answered, or
// once it has failed, it says so and never `Nothing waiting`.

import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  WorkflowRunAttentionListResponseSchema,
  type WorkflowRunAttentionListResponse,
} from "@ai-sidekicks/contracts/workflow/run/records";

import { LOADING_NOTICE_DELAY_MS } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { refuse } from "#renderer/lib/refusal/refusal.js";
import { formatDayClock } from "#renderer/lib/wire/figures.js";
import { RunAttentionSection } from "./RunAttentionSection.js";

// Local calendar instants, so every figure below falls on the same day as now.
const NOW_MS = new Date(2026, 0, 1, 14, 20).getTime();
const RESUME_AT = new Date(2026, 0, 1, 15, 0).toISOString();
const NEWER_WAIT = new Date(2026, 0, 1, 14, 5).toISOString();
const OLDER_WAIT = new Date(2026, 0, 1, 8, 30).toISOString();

/**
 * Two accounts, then two runs whose waits are out of time order, as a daemon may send them:
 * a screen that sorted or regrouped the entries would draw them in another order.
 */
const DAEMON_GROUPING: WorkflowRunAttentionListResponse =
  WorkflowRunAttentionListResponseSchema.parse({
    entries: [
      {
        kind: "account",
        providerAccountId: "pa-0002",
        affectedRunCount: 1,
        waitingSince: OLDER_WAIT,
      },
      {
        kind: "account",
        providerAccountId: "pa-0001",
        affectedRunCount: 3,
        waitingSince: NEWER_WAIT,
        resumeAt: RESUME_AT,
      },
      {
        kind: "run",
        workflowRunId: "019b7a10-0280-75e5-8510-ada11a5a4002",
        workflowName: "Release",
        waitCause: "approval",
        waitingSince: NEWER_WAIT,
      },
      {
        kind: "run",
        workflowRunId: "019b7a10-0280-75e5-8510-ada11a5a4003",
        workflowName: "Weekly notes",
        waitCause: "form",
        waitingSince: OLDER_WAIT,
      },
    ],
    waitingOnPersonCount: 2,
  });

const ACCOUNT_LABELS: Readonly<Record<string, string>> = { "pa-0001": "Work account" };

describe("the attention list", () => {
  it("draws the daemon's account and run lines in the order the daemon gave them", () => {
    render(
      <RunAttentionSection
        state={{ kind: "loaded", value: DAEMON_GROUPING }}
        accountLabel={(providerAccountId) => ACCOUNT_LABELS[providerAccountId]}
        onOpenRun={() => undefined}
        nowMs={NOW_MS}
        clock={new ManualClock(NOW_MS)}
        readAgain={() => undefined}
        answeredCount={0}
      />,
    );

    const lines = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(lines).toStrictEqual([
      // An account no label is known for is named by its id rather than dropped.
      "pa-0002 is spent: 1 run is parked on it. Awaiting resume — no instant is armed.",
      `Work account is spent: 3 runs are parked on it. Resumes ${formatDayClock(RESUME_AT, NOW_MS)}.`,
      `Release · waiting on your approval · since ${formatDayClock(NEWER_WAIT, NOW_MS)}`,
      "Weekly notes · waiting on your answer to a form · since 8:30 AM",
    ]);
  });

  it("never reads `Nothing waiting` before the read answers or once it has failed", () => {
    const clock = new ManualClock(NOW_MS);
    const section = (state: React.ComponentProps<typeof RunAttentionSection>["state"]) => (
      <RunAttentionSection
        state={state}
        accountLabel={() => undefined}
        onOpenRun={() => undefined}
        nowMs={NOW_MS}
        clock={clock}
        readAgain={() => undefined}
        answeredCount={3}
      />
    );
    const { rerender } = render(section({ kind: "not-loaded" }));
    act(() => {
      clock.advance(LOADING_NOTICE_DELAY_MS);
    });
    expect(screen.getByText("Loading what is waiting…")).toBeTruthy();
    expect(screen.queryByText(/Nothing waiting/)).toBeNull();

    rerender(
      section({ kind: "failed", refusal: refuse("daemon", "daemon.unavailable", "Not running.") }),
    );
    expect(screen.getByText("Could not load what is waiting")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText(/Nothing waiting/)).toBeNull();

    rerender(section({ kind: "loaded", value: { entries: [], waitingOnPersonCount: 0 } }));
    expect(screen.getByText("Nothing waiting · you answered 3 runs this afternoon")).toBeTruthy();
  });
});
