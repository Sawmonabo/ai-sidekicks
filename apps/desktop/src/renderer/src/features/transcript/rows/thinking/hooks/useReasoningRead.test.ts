// The reasoning read over a real bridge whose answer a case decides: a second press after a
// refusal, and an answer arriving for a row that has moved on.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RunId } from "@ai-sidekicks/contracts/provider-driver";

import { bridgeAnswering, type BridgeUnderTest } from "@test/helpers/fixture-bridge.js";
import { settle } from "@test/helpers/settle.js";
import { bridgeFailingUntilCleared, callsTo, inBridge } from "./useReasoningRead.test-support.js";
import { useReasoningRead } from "./useReasoningRead.js";

const SAMPLE_RUN_ID = "019b79ee-0280-740e-8110-d1a4c1150091" as RunId;
/** A second run, for the cases about a row re-addressed while a read is in flight. */
const OTHER_RUN_ID = "019b79ee-0280-740e-8110-d1a4c1150092" as RunId;
const REASONING_READ = "timeline.reasoningSurfaceRead";

/** One `ReasoningSurfaceReadResponse` on the arm that carries no entries. */
const UNAVAILABLE_REASONING: Record<string, unknown> = { availability: "unavailable" };

describe("useReasoningRead — a refusal is retryable and an answer is not", () => {
  it("holds the daemon call's own refusal rather than discarding it", async () => {
    const { held } = bridgeFailingUntilCleared(REASONING_READ, UNAVAILABLE_REASONING);
    const { result } = renderHook(() => useReasoningRead(SAMPLE_RUN_ID), {
      wrapper: inBridge(held),
    });

    act(() => {
      result.current.expand();
    });
    await settle();

    expect(result.current.reading.status).toBe("refused");
  });

  it("issues a second read when a refused one is asked again", async () => {
    // A read refused by a briefly down transport can be asked again, so the guard admits a
    // refused reading as well as one never asked.
    const { held, recover } = bridgeFailingUntilCleared(REASONING_READ, UNAVAILABLE_REASONING);
    const { result } = renderHook(() => useReasoningRead(SAMPLE_RUN_ID), {
      wrapper: inBridge(held),
    });

    act(() => {
      result.current.expand();
    });
    await settle();
    expect(result.current.reading.status).toBe("refused");

    recover();
    act(() => {
      result.current.expand();
    });
    await settle();

    expect(callsTo(held, REASONING_READ)).toBe(2);
    expect(result.current.reading.status).toBe("read");
  });
});

/** What a case holds a scripted reasoning read with, and the act that answers it. */
interface HeldReasoningRead {
  readonly held: BridgeUnderTest;
  /** Let the read this bridge is holding answer. */
  readonly release: () => void;
}

/**
 * A bridge whose reasoning read answers only when the case says so, to observe the window
 * between the press and the reply.
 */
function bridgeHoldingReasoningRead(): HeldReasoningRead {
  let releaseReply = (): void => undefined;
  const untilReleased = new Promise<void>((resolve) => {
    releaseReply = resolve;
  });
  const held = bridgeAnswering(async (call, passThrough) => {
    if (call.method !== REASONING_READ) {
      return passThrough();
    }
    await untilReleased;
    return UNAVAILABLE_REASONING;
  });
  return {
    held,
    release: () => {
      releaseReply();
    },
  };
}

describe("useReasoningRead — the row moves while the answer is on the wire", () => {
  it("never lands one run's reasoning on a row addressed at another", async () => {
    // Without the signal, a row re-addressed at a second run would fold the first run's answer
    // into its state, presenting one run's reasoning as another's.
    const { held, release } = bridgeHoldingReasoningRead();
    const { result, rerender } = renderHook((runId: RunId) => useReasoningRead(runId), {
      initialProps: SAMPLE_RUN_ID,
      wrapper: inBridge(held),
    });

    act(() => {
      result.current.expand();
    });
    rerender(OTHER_RUN_ID);
    release();
    await settle();

    expect(result.current.reading.status).toBe("reading");
  });
});
