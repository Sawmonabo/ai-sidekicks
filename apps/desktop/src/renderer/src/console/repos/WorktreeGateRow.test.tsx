// One root, one gate, one sentence said once.
//
// The row is the first console surface to announce a read's settlement, so three of
// the cases below are about the announcement rather than the markup: what is said, and
// what is NOT said on a re-render or a disclosure toggle. Each one reads the rendered
// LIVE REGION rather than spying on `useAnnounce`, because a spy would prove the row
// called something and the region is what a person using a screen reader is actually
// told. The provider runs on a frozen clock, so the standing message is read rather
// than raced against its own hold deadline.

import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConsoleBridge } from "../bridge/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import { ManualClock, refuse } from "../core/index.js";
import { SessionStore } from "../store/index.js";
import { gateSummaryLine } from "./ProposalGateDisclosure.js";
import { WorktreeGateRow } from "./WorktreeGateRow.js";
import { SUBJECT_NOT_ADDRESSABLE, type ProposalGateSubject } from "./proposal-gate-model.js";
import type { ProposalGateReading } from "./proposal-gate-reader.js";
import type { ProposalGateState } from "./proposal-gate-state.js";
import type { WorktreeStatusRecord } from "./worktree-model.js";

const SUBJECT = {
  kind: "worktree",
  workspaceId: "019b7b30-0280-7c11-8420-b1a5c0de2005",
  repoMountId: "019b7b30-0280-7c11-8420-b1a5c0de2003",
  worktreeId: "019b7b30-0280-7c11-8420-b1a5c0de2020",
  executionMode: "worktree",
} as const satisfies ProposalGateSubject;

const ROOT: WorktreeStatusRecord = {
  worktreeId: SUBJECT.worktreeId,
  repoMountId: "019b7b30-0280-7c11-8420-b1a5c0de2003",
  branchName: "feat/rate-limit-wiring",
  fsRoot: "/Users/dev/roots/rate-limit-wiring",
  state: "ready",
  createdBySessionId: "019b7b30-0280-7c11-8420-b1a5c0de2001",
  createdAt: "2026-01-01T09:05:00.700Z",
  updatedAt: "2026-01-01T09:05:00.700Z",
} as WorktreeStatusRecord;

const NOW = Date.parse("2026-01-01T09:06:00.000Z");

/** A bridge whose gate read refuses the way the live bridge refuses it. */
function bridgeAnswering(branchContext: unknown): ConsoleBridge {
  return {
    growth: { gitflowBranchContextRead: async () => branchContext },
  } as unknown as ConsoleBridge;
}

const WIRE_UNREGISTERED = {
  status: "unavailable",
  code: "wire-unregistered",
  origin: "growth-port",
  detail: "Not checked — the branch-context read is not registered yet (Spec-011 owns it).",
};

const SERVED_CONTEXT = {
  status: "served",
  value: {
    branchContext: {
      branchContextId: "019b7b30-0280-7c11-8420-b1a5c0de2301",
      workspaceId: SUBJECT.workspaceId,
      baseBranch: "develop",
      headBranch: "feat/rate-limit-wiring",
      worktreeId: SUBJECT.worktreeId,
    },
  },
};

/** One row inside the window's announcer, on frozen time. */
function row(
  branchContext: unknown,
  overrides: Partial<React.ComponentProps<typeof WorktreeGateRow>> = {},
): React.JSX.Element {
  return (
    <LiveAnnouncerProvider clock={new ManualClock()}>
      <WorktreeGateRow
        record={ROOT}
        subject={SUBJECT}
        unpairedReason={UNPAIRED_REASON}
        bridge={bridgeAnswering(branchContext)}
        sessionStore={new SessionStore({ sessionId: ROOT.createdBySessionId })}
        nowMilliseconds={NOW}
        {...overrides}
      />
    </LiveAnnouncerProvider>
  );
}

/**
 * Render one row and WAIT for the gate's read to settle.
 *
 * Waited on rather than flushed, because the reader runs on the console's refresh
 * scheduler and the scheduler debounces: the first read lands a real interval after
 * the mount, exactly as it does behind the sidebar section. A case that asserted
 * straight after `render` would pin the pre-read frame, which is the wait state and
 * not the answer any of these cases is about.
 */
async function renderRow(
  branchContext: unknown,
  overrides: Partial<React.ComponentProps<typeof WorktreeGateRow>> = {},
): Promise<ReturnType<typeof render>> {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(row(branchContext, overrides));
    await Promise.resolve();
  });
  await settleRead(result.container);
  return result;
}

/** Wait until the gate's collapsed line stops reporting the wait. */
async function settleRead(container: HTMLElement): Promise<void> {
  await waitFor(() => {
    const line = container.querySelector(".meridian-root-gate__line")?.textContent;
    // An unpaired row has no gate at all, and its case asserts that; there is nothing
    // to wait for there, so an absent line settles immediately.
    if (line === "reading" || line === "not checked") {
      throw new Error(`the gate is still reporting \`${line ?? ""}\``);
    }
  });
}

/**
 * A row whose gate was REFUSED, waited on by the refusal rather than by the line.
 *
 * The refused arm settles back onto the same `not checked` line it waits on, so the
 * line cannot say whether the read has happened; the refusal card is what only a
 * settled read produces.
 */
async function renderRefusedRow(): Promise<ReturnType<typeof render>> {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(row(WIRE_UNREGISTERED));
    await Promise.resolve();
  });
  await waitFor(() => {
    if (!result.container.textContent?.includes("wire-unregistered")) {
      throw new Error("the gate has not settled on its refusal yet");
    }
  });
  return result;
}

/** What the polite region is saying — the sentence a screen reader would read out. */
function politeAnnouncement(container: HTMLElement): string {
  return container.querySelector('[data-live-region="polite"]')?.textContent ?? "";
}

/** The interrupting lane, which a gate settlement must never reach. */
function assertiveAnnouncement(container: HTMLElement): string {
  return container.querySelector('[data-live-region="assertive"]')?.textContent ?? "";
}

const UNPAIRED_REASON = "No read names which workspace this root belongs to.";

describe("WorktreeGateRow — the root and the gate under it", () => {
  it("draws the root's own card beside the gate", async () => {
    const { container } = await renderRefusedRow();
    expect(container.querySelector(".meridian-root-card")).not.toBeNull();
    expect(container.textContent).toContain("feat/rate-limit-wiring");
  });

  it("opens collapsed on a line that is a reading, not an invitation", async () => {
    const { container } = await renderRefusedRow();
    const disclosure = container.querySelector("details.meridian-root-gate");
    // Collapsed, and the summary already reports what the read found — the read runs
    // on mount, so the line is an answer rather than a prompt to go and get one.
    expect(disclosure).not.toBeNull();
    expect((disclosure as HTMLDetailsElement).open).toBe(false);
    expect(container.querySelector(".meridian-root-gate__line")?.textContent).toBe("not checked");
  });

  it("puts the port's own refusal beside the arm that carries no message", async () => {
    const { container } = await renderRefusedRow();
    expect(container.textContent).toContain("wire-unregistered");
    expect(container.textContent).toContain("Spec-011 owns it");
  });

  it("reports a served context on the collapsed line", async () => {
    const { container } = await renderRow(SERVED_CONTEXT);
    expect(container.querySelector(".meridian-root-gate__line")?.textContent).toBe(
      "context read, no proposal",
    );
    // The arm carries its own answer, so nothing is put beside it.
    expect(container.querySelector(".meridian-refusal-card")).toBeNull();
  });

  it("asks nothing at all where no read names the workspace to ask under", async () => {
    const { container } = await renderRow(SERVED_CONTEXT, { subject: undefined });
    // The root is still reported; only the question about it is not put — and there is
    // no gate on screen at all, so no reader was constructed and no call was made.
    expect(container.querySelector(".meridian-root-card")).not.toBeNull();
    expect(container.querySelector("details.meridian-root-gate")).toBeNull();
    expect(container.textContent).toContain(UNPAIRED_REASON);
  });
});

describe("WorktreeGateRow — the announcement", () => {
  it("says what the gate settled on, once, politely", async () => {
    const { container } = await renderRow(SERVED_CONTEXT);
    expect(politeAnnouncement(container)).toBe(
      "A branch context was read. No proposal has been prepared yet.",
    );
    // Never the interrupting lane: a gate settling is not a room-wide refusal.
    expect(assertiveAnnouncement(container)).toBe("");
  });

  it("announces the port's own sentence for the arm that has none of its own", async () => {
    const { container } = await renderRefusedRow();
    expect(politeAnnouncement(container)).toBe(WIRE_UNREGISTERED.detail);
  });

  it("negative control: a re-render and a disclosure toggle announce nothing new", async () => {
    // Without this the cases above would pass against a row that announced on every
    // render, which reads to a screen-reader user as the gate settling over and over.
    const { container, rerender } = await renderRow(SERVED_CONTEXT);
    const spokenOnce = politeAnnouncement(container);
    expect(spokenOnce).not.toBe("");

    await act(async () => {
      const disclosure = container.querySelector("details.meridian-root-gate");
      (disclosure as HTMLDetailsElement).open = true;
      rerender(row(SERVED_CONTEXT));
      await Promise.resolve();
    });

    // Still the one message, and nothing queued behind it: a second announcement
    // would have displaced this one in the region.
    expect(politeAnnouncement(container)).toBe(spokenOnce);
  });
});

describe("gateSummaryLine", () => {
  /** A reading on one arm, with nothing beside it. */
  function reading(state: ProposalGateState): ProposalGateReading {
    return {
      state,
      refusal: undefined,
      actionRefusals: new Map(),
      inFlightAction: undefined,
      settlement: undefined,
    };
  }

  it("gives every arm its own line, and none of them a number nothing read", () => {
    expect(gateSummaryLine(reading({ kind: "not-checked" }))).toBe("not checked");
    expect(gateSummaryLine(reading({ kind: "preparing" }))).toBe("reading");
    expect(gateSummaryLine(reading({ kind: "refused", message: "the daemon said no" }))).toBe(
      "refused",
    );
  });

  it("separates a root nobody can ask about from one nobody has asked about yet", () => {
    // Both are `not-checked`, and only one of them will ever become anything else — so
    // a shared line would invite a wait for an answer that is not coming.
    const unaddressable: ProposalGateReading = {
      ...reading({ kind: "not-checked" }),
      refusal: refuse("proposal-gate", SUBJECT_NOT_ADDRESSABLE, "no key for this root"),
    };
    expect(gateSummaryLine(unaddressable)).toBe("not addressable");
  });

  it("negative control: another refusal on the same arm still reads as not checked", () => {
    // Without this the case above would pass against a line that said "not addressable"
    // for every refusal, including the unregistered wire — which IS a question that
    // gets answered once the wire lands.
    const unregistered: ProposalGateReading = {
      ...reading({ kind: "not-checked" }),
      refusal: refuse("growth-port", "wire-unregistered", "not registered yet"),
    };
    expect(gateSummaryLine(unregistered)).toBe("not checked");
  });
});
