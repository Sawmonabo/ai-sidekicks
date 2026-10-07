// The attention list draws the daemon's grouping as given: its account lines, each naming its
// account by provider and label, and its run lines, in the daemon's order, with no sorting or
// regrouping of its own. Until the read has answered, or
// once it has failed, it says so and never `Nothing waiting`.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import {
  WorkflowRunAttentionListResponseSchema,
  type WorkflowRunAttentionListResponse,
} from "@ai-sidekicks/contracts/workflow/run/records";

import { LOADING_NOTICE_DELAY_MS } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { refuse } from "#renderer/lib/refusal/contract.js";
import { formatDayClock } from "#renderer/lib/wire/figures.js";
import { RunAttentionSection } from "./RunAttentionSection.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { OUTSIDE_LIVE_REGIONS } from "#test/helpers/live-region.js";
import { spiedAnnouncer } from "#test/helpers/spied-announcer.js";

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
        account: { providerAccountId: "pa-0002", provider: "claude", label: "Personal" },
        affectedRunCount: 1,
        waitingSince: OLDER_WAIT,
      },
      {
        kind: "account",
        account: { providerAccountId: "pa-0001", provider: "codex", label: "Work" },
        affectedRunCount: 3,
        waitingSince: NEWER_WAIT,
        resumeAt: RESUME_AT,
      },
      {
        kind: "run",
        workflowRunId: "019b7a10-0280-75e5-8510-ada11a5a4002",
        workflowName: "Release",
        waitCause: "approval",
        waitingStepName: "Approve the release",
        waitingSince: NEWER_WAIT,
      },
      {
        kind: "run",
        workflowRunId: "019b7a10-0280-75e5-8510-ada11a5a4003",
        workflowName: "Weekly notes",
        waitCause: "form",
        waitingStepName: "Write the notes",
        waitingSince: OLDER_WAIT,
      },
    ],
    waitingOnPersonCount: 2,
  });

describe("the attention list", () => {
  it("draws the daemon's account and run lines in the order the daemon gave them", () => {
    render(
      <RunAttentionSection
        state={{ kind: "loaded", value: DAEMON_GROUPING }}
        onOpenRun={() => undefined}
        nowMs={NOW_MS}
        clock={new ManualClock(NOW_MS)}
        readAgain={() => undefined}
        answeredCount={0}
      />,
      { wrapper: LiveAnnouncerProvider },
    );

    const lines = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(lines).toStrictEqual([
      "1 run waits on the Claude Code account Personal, which is spent.",
      "3 runs wait on the Codex account Work, which is spent until " +
        `${formatDayClock(RESUME_AT, NOW_MS)}.`,
      `Release · waiting on Approve the release · since ${formatDayClock(NEWER_WAIT, NOW_MS)}`,
      "Weekly notes · waiting on Write the notes · since 8:30 AM",
    ]);
  });

  it("never reads `Nothing waiting` before the read answers or once it has failed", () => {
    const clock = new ManualClock(NOW_MS);
    const section = (state: React.ComponentProps<typeof RunAttentionSection>["state"]) => (
      <RunAttentionSection
        state={state}
        onOpenRun={() => undefined}
        nowMs={NOW_MS}
        clock={clock}
        readAgain={() => undefined}
        answeredCount={3}
      />
    );
    const { rerender } = render(section({ kind: "not-loaded" }), {
      wrapper: LiveAnnouncerProvider,
    });
    act(() => {
      clock.advance(LOADING_NOTICE_DELAY_MS);
    });
    expect(
      screen.getByText("Loading what is waiting…", { ignore: OUTSIDE_LIVE_REGIONS }),
    ).toBeTruthy();
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

  it("says the failure again when `Try again` fails the same way", () => {
    // The read stays failed across the retry and settles a new refusal in the same words, so
    // only the new refusal can tell the announcer it is a second failure.
    const clock = new ManualClock(NOW_MS);
    const said = spiedAnnouncer(clock);
    const section = (
      <LiveAnnouncerProvider announcer={said.announcer}>
        <SectionRefusedOnEveryRead clock={clock} />
      </LiveAnnouncerProvider>
    );
    const { rerender } = render(section);
    // A re-render of the same failure is not a new one.
    rerender(section);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    const failure = "Could not load what is waiting. Not running.";
    expect(said.spokenOn("assertive")).toStrictEqual([failure, failure]);
  });
});

/** A read of what is waiting, refused in the same words every time it is asked. */
function refusedRead(): React.ComponentProps<typeof RunAttentionSection>["state"] {
  return { kind: "failed", refusal: refuse("daemon", "daemon.unavailable", "Not running.") };
}

/** The section over a read that `Try again` asks again and that is refused again. */
function SectionRefusedOnEveryRead(props: { readonly clock: ManualClock }): React.JSX.Element {
  const [state, setState] = useState(refusedRead);
  return (
    <RunAttentionSection
      state={state}
      onOpenRun={() => undefined}
      nowMs={NOW_MS}
      clock={props.clock}
      readAgain={() => {
        setState(refusedRead());
      }}
      answeredCount={0}
    />
  );
}
