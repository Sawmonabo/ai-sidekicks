// The replay ask: what a window with a hole in its log can request, and what it does
// with the answer.
//
// The decision is driven with no React and no bridge, because it is a rule over three
// facts. The hook is driven under a real fixture bridge rather than a stand-in port:
// the claim worth holding is what happens when the wire is not registered, and the
// fixture is the thing that actually refuses it — a scripted port would be this suite
// asserting against its own idea of a refusal.

import { renderHook, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import {
  SidekicksBridgeProvider,
  createFixtureBridge,
  isUnbuiltWireRefusal,
  type ConsoleBridge,
} from "../../../bridge/index.js";
import { LEDGER_QUIET_SCENARIO } from "../../../bridge/scenarios/ledger/ledger-quiet.js";
import {
  ledgerGapFillSubjectKey,
  resolveLedgerGapFill,
  useLedgerGapFill,
  type LedgerGapFillInput,
  type LedgerGapFillRequest,
  type LedgerGapFillState,
} from "./ledger-gap-fill.js";

const SESSION_ID = "session-gap-fill";
const KEPT_CURSOR = "cursor-kept-by-the-last-read";

/** A bridge that counts the replay asks put through it, and puts the real ones. */
function countingBridge(asks: LedgerGapFillRequest[]): ConsoleBridge {
  const bridge = createFixtureBridge({ scenario: LEDGER_QUIET_SCENARIO });
  return {
    ...bridge,
    growth: {
      ...bridge.growth,
      timelineSubscribe: (request) => {
        asks.push(request);
        return bridge.growth.timelineSubscribe(request);
      },
    },
  };
}

/** The hook over inputs the caller can move, under one bridge that outlives the moves. */
function mountFill(
  bridge: ConsoleBridge,
  initialProps: LedgerGapFillInput,
): ReturnType<typeof renderHook<LedgerGapFillState, LedgerGapFillInput>> {
  return renderHook((props: LedgerGapFillInput) => useLedgerGapFill(props), {
    initialProps,
    wrapper: ({ children }: { readonly children?: React.ReactNode }) =>
      createElement(SidekicksBridgeProvider, { bridge, children }),
  });
}

describe("resolveLedgerGapFill", () => {
  it("asks for nothing where no rows are missing", () => {
    expect(
      resolveLedgerGapFill({
        sessionId: SESSION_ID,
        missingFromSequence: undefined,
        keptCursor: KEPT_CURSOR,
      }),
    ).toStrictEqual({ outcome: "whole" });
  });

  it("asks from the hole's own position when a read acknowledged one", () => {
    expect(
      resolveLedgerGapFill({
        sessionId: SESSION_ID,
        missingFromSequence: 7,
        keptCursor: KEPT_CURSOR,
      }),
    ).toStrictEqual({
      outcome: "resumable",
      missingFromSequence: 7,
      request: { sessionId: SESSION_ID, afterCursor: KEPT_CURSOR },
    });
  });

  it("cannot ask at all when nothing has been acknowledged", () => {
    // The negative control for the arm above: the same hole, the position taken away.
    // A console that fell back to a row id here would be asking with a value the
    // contract calls opaque and this console orders nothing by.
    expect(
      resolveLedgerGapFill({
        sessionId: SESSION_ID,
        missingFromSequence: 7,
        keptCursor: undefined,
      }),
    ).toStrictEqual({ outcome: "unanchored", missingFromSequence: 7 });
  });

  it("relays the acknowledged position byte for byte", () => {
    const intent = resolveLedgerGapFill({
      sessionId: SESSION_ID,
      missingFromSequence: 2,
      keptCursor: " cursor with spaces and : colons ",
    });
    expect(intent.outcome === "resumable" && intent.request.afterCursor).toBe(
      " cursor with spaces and : colons ",
    );
  });
});

describe("ledgerGapFillSubjectKey", () => {
  it("is one key per hole, so one ask goes out per hole", () => {
    expect(ledgerGapFillSubjectKey(SESSION_ID, 7)).toBe(ledgerGapFillSubjectKey(SESSION_ID, 7));
    expect(ledgerGapFillSubjectKey(SESSION_ID, 7)).not.toBe(ledgerGapFillSubjectKey(SESSION_ID, 8));
    expect(ledgerGapFillSubjectKey(SESSION_ID, 7)).not.toBe(
      ledgerGapFillSubjectKey("other-session", 7),
    );
  });
});

describe("useLedgerGapFill", () => {
  it("puts no ask for a window with nothing missing", async () => {
    const asks: LedgerGapFillRequest[] = [];
    const fill = mountFill(countingBridge(asks), {
      sessionId: SESSION_ID,
      missingFromSequence: undefined,
      keptCursor: KEPT_CURSOR,
    });

    await waitFor(() => {
      expect(fill.result.current.status).toBe("whole");
    });
    expect(asks).toStrictEqual([]);
  });

  it("puts no ask for a hole it holds no position to ask from", async () => {
    const asks: LedgerGapFillRequest[] = [];
    const fill = mountFill(countingBridge(asks), {
      sessionId: SESSION_ID,
      missingFromSequence: 7,
      keptCursor: undefined,
    });

    await waitFor(() => {
      expect(fill.result.current.status).toBe("unanchored");
    });
    // The negative control for the ask below: a hole alone is not enough to put one.
    expect(asks).toStrictEqual([]);
  });

  it("asks once per hole, and settles on the refusal this build actually gives", async () => {
    const asks: LedgerGapFillRequest[] = [];
    const fill = mountFill(countingBridge(asks), {
      sessionId: SESSION_ID,
      missingFromSequence: 7,
      keptCursor: KEPT_CURSOR,
    });

    await waitFor(() => {
      expect(fill.result.current.status).toBe("unavailable");
    });
    const settled = fill.result.current;
    // The wire is registered and the seam that would carry its request is not, so the
    // honest answer is the port's own "nobody asked" refusal — which is what the
    // surface renders as the `not-checked` kind of nothing rather than as a failure.
    expect(settled.status === "unavailable" && isUnbuiltWireRefusal(settled.refusal)).toBe(true);
    expect(asks).toStrictEqual([{ sessionId: SESSION_ID, afterCursor: KEPT_CURSOR }]);

    // A render that changes nothing about the hole re-asks nothing.
    fill.rerender({ sessionId: SESSION_ID, missingFromSequence: 7, keptCursor: KEPT_CURSOR });
    await waitFor(() => {
      expect(fill.result.current.status).toBe("unavailable");
    });
    expect(asks).toHaveLength(1);
  });

  it("asks again for a second hole, and clears when the store repairs the first", async () => {
    const asks: LedgerGapFillRequest[] = [];
    const fill = mountFill(countingBridge(asks), {
      sessionId: SESSION_ID,
      missingFromSequence: 7,
      keptCursor: KEPT_CURSOR,
    });
    await waitFor(() => {
      expect(asks).toHaveLength(1);
    });

    fill.rerender({ sessionId: SESSION_ID, missingFromSequence: 12, keptCursor: KEPT_CURSOR });
    await waitFor(() => {
      expect(asks).toHaveLength(2);
    });

    // The completed re-pull is what clears the store's cause, and this follows it
    // rather than timing out on its own: the hole is gone, so there is nothing to ask.
    fill.rerender({
      sessionId: SESSION_ID,
      missingFromSequence: undefined,
      keptCursor: KEPT_CURSOR,
    });
    await waitFor(() => {
      expect(fill.result.current.status).toBe("whole");
    });
    expect(asks).toHaveLength(2);
  });
});
