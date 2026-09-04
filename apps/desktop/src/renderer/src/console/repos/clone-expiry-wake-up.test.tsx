// The one wake-up an outstanding clone deadline gets, and the three things that take
// it away.
//
// The defect these cases hold is that the countdown is a DEADLINE wearing an age's
// clothes. The section's instant is the stamp of its last read, so a clone that crossed
// `expiresAt` with no repo event, no window focus, and no reconnect stayed on the
// neutral `scheduled` arm for as long as the sidebar stayed open — never reaching the
// amber warning that says its snapshot refs may already be gone. Everything below drives
// the real hook on the console's own frozen clock and renders the real card from the
// instant it answers with, which is the composition `RepoSection` makes.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConsoleBridge } from "../bridge/index.js";
import { ManualClock } from "../core/index.js";
import { EphemeralCloneCard } from "./EphemeralCloneCard.js";
import { earliestCloneExpiryDeadlineMs, useCloneExpiryInstant } from "./clone-expiry-wake-up.js";
import { CLONE_EXPIRY_COPY, type EphemeralCloneStatusRecord } from "./worktree-model.js";

const READ_AT = Date.parse("2026-01-01T09:00:00.000Z");
const EXPIRES_AT = "2026-01-01T09:30:00.000Z";
const LATER_EXPIRES_AT = "2026-01-01T11:00:00.000Z";
const EXPIRY_MILLISECONDS = Date.parse(EXPIRES_AT) - READ_AT;

function cloneRecord(
  cloneId: string,
  overrides: Partial<EphemeralCloneStatusRecord> = {},
): EphemeralCloneStatusRecord {
  return {
    cloneId,
    workspaceId: "workspace-sidekicks",
    cloneRoot: "/Users/dev/.sidekicks/clones/clone-01",
    branchName: "run-9f2c1a",
    state: "ready",
    cleanupPolicy: "on_run_complete",
    expiresAt: EXPIRES_AT,
    createdAt: "2026-01-01T08:00:00.000Z",
    ...overrides,
  } as EphemeralCloneStatusRecord;
}

/**
 * A bridge that carries nothing but the clock this window runs on.
 *
 * `consoleClockFor` reads the running scenario engine's clock and mints a `RealClock`
 * where there is none, which is the whole surface the hook touches — so the double is
 * that one member rather than a second fixture bridge assembled to reach it.
 */
function bridgeOnClock(clock: ManualClock): ConsoleBridge {
  return { scenarioEngine: { clock } } as unknown as ConsoleBridge;
}

/** The clone list's composition: the hook's instant, handed to the real cards. */
function CloneListProbe(props: {
  readonly records: readonly EphemeralCloneStatusRecord[];
  readonly bridge: ConsoleBridge;
}): React.JSX.Element {
  const nowMilliseconds = useCloneExpiryInstant(props.records, READ_AT, props.bridge);
  return (
    <>
      {props.records.map((record) => (
        <EphemeralCloneCard
          key={record.cloneId}
          record={record}
          nowMilliseconds={nowMilliseconds}
        />
      ))}
    </>
  );
}

describe("clone expiry — the earliest outstanding deadline, and only that one", () => {
  it("takes the soonest deadline still ahead of the instant", () => {
    const deadline = earliestCloneExpiryDeadlineMs(
      [
        cloneRecord("clone-late", { expiresAt: LATER_EXPIRES_AT }),
        cloneRecord("clone-soon", { expiresAt: EXPIRES_AT }),
      ],
      READ_AT,
    );
    expect(deadline).toBe(Date.parse(EXPIRES_AT));
  });

  it("skips a swept row, an unparseable stamp, and a deadline already behind", () => {
    // None of the three is something to wake for: the sweep already ran, the console
    // could not read the stamp, and the card is drawing its elapsed arm as this runs.
    const deadline = earliestCloneExpiryDeadlineMs(
      [
        cloneRecord("clone-swept", { cleanedAt: "2026-01-01T08:30:00.000Z" }),
        cloneRecord("clone-unreadable", { expiresAt: "not a timestamp" }),
        cloneRecord("clone-past", { expiresAt: "2026-01-01T08:45:00.000Z" }),
      ],
      READ_AT,
    );
    expect(deadline).toBeUndefined();
  });
});

describe("clone expiry wake-up — the card reaches its amber arm with no read", () => {
  it("re-stamps at the deadline so the elapsed arm renders", () => {
    // The bug, exercised: nothing re-read, nothing was focused, and no frame arrived —
    // and the row still has to stop saying its disposal is merely scheduled.
    const clock = new ManualClock(READ_AT);
    const { container } = render(
      <CloneListProbe records={[cloneRecord("clone-01")]} bridge={bridgeOnClock(clock)} />,
    );
    expect(container.textContent).toContain(CLONE_EXPIRY_COPY.scheduled);

    act(() => {
      clock.advance(EXPIRY_MILLISECONDS);
    });

    expect(container.textContent).toContain(CLONE_EXPIRY_COPY.elapsed);
  });

  it("wakes once and not on a cadence", () => {
    // One shot per deadline, and with the only deadline behind us the hook holds no
    // timer at all. A repeat here would be the interval polling this family forbids,
    // wearing a one-shot's clothes.
    const clock = new ManualClock(READ_AT);
    render(<CloneListProbe records={[cloneRecord("clone-01")]} bridge={bridgeOnClock(clock)} />);
    act(() => {
      clock.advance(EXPIRY_MILLISECONDS);
    });

    expect(clock.pendingCount).toBe(0);
  });

  it("re-arms to the new earliest when the record set changes", () => {
    const clock = new ManualClock(READ_AT);
    const { container, rerender } = render(
      <CloneListProbe
        records={[cloneRecord("clone-late", { expiresAt: LATER_EXPIRES_AT })]}
        bridge={bridgeOnClock(clock)}
      />,
    );
    // A read lands carrying a clone that is due sooner than the one armed for.
    rerender(
      <CloneListProbe
        records={[
          cloneRecord("clone-late", { expiresAt: LATER_EXPIRES_AT }),
          cloneRecord("clone-soon", { expiresAt: EXPIRES_AT }),
        ]}
        bridge={bridgeOnClock(clock)}
      />,
    );

    act(() => {
      clock.advance(EXPIRY_MILLISECONDS);
    });

    expect(container.textContent).toContain(CLONE_EXPIRY_COPY.elapsed);
    // And the later row is still counting, with its own wake-up armed.
    expect(container.textContent).toContain(CLONE_EXPIRY_COPY.scheduled);
    expect(clock.pendingCount).toBe(1);
  });

  it("holds no timer once the section has unmounted", () => {
    const clock = new ManualClock(READ_AT);
    const { unmount } = render(
      <CloneListProbe records={[cloneRecord("clone-01")]} bridge={bridgeOnClock(clock)} />,
    );
    expect(clock.pendingCount).toBe(1);

    unmount();

    // A timeout that outlived its surface would set state on a component that is gone.
    expect(clock.pendingCount).toBe(0);
  });

  it("negative control: a list with nothing outstanding arms no wake-up at all", () => {
    // Without this, every case above would pass over a hook that armed a timer on any
    // render and re-stamped whenever time moved — which is the poll, not a deadline.
    const clock = new ManualClock(READ_AT);
    const { container } = render(
      <CloneListProbe
        records={[cloneRecord("clone-01", { cleanedAt: "2026-01-01T08:30:00.000Z" })]}
        bridge={bridgeOnClock(clock)}
      />,
    );

    expect(clock.pendingCount).toBe(0);
    act(() => {
      clock.advance(EXPIRY_MILLISECONDS * 4);
    });
    expect(container.textContent).toContain(CLONE_EXPIRY_COPY.reclaimed);
  });
});
