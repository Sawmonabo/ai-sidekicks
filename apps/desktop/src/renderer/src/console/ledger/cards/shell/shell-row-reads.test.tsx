// The reasoning read the shell's rows make, over a real bridge whose answer a case
// decides.
//
// `bridgeAnswering` rather than a hand-built port, for `child-run-expansion.test.ts`'
// reason: the hook reaches the console's own call door, so a stand-in would prove the
// case answers itself rather than that a refusal off the wire reaches the state a
// surface renders.
//
// TWO SUBJECTS, AND THEY ARE DIFFERENT FACTS. What a SECOND press does — the read
// stored its refusal and then admitted no second press, so a transport that was down
// for one moment took the read away for the row's whole life — and what an answer for
// a row that has moved on does, which is nothing.
//
// A `.tsx` FILE FOR A `.ts` MODULE, because the wrapper `renderHook` mounts is a
// component and the hook resolves its bridge from context — there is no way to drive
// it that does not render one.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RunId } from "@ai-sidekicks/contracts";

import {
  bridgeAnswering,
  type BridgeUnderTest,
} from "../../../bridge/fixture/call-plane/bridge.test-support.js";
import { settle } from "../../../core/settle.test-support.js";
import { bridgeFailingUntilCleared, callsTo, inBridge } from "./shell-hook-bridges.test-support.js";
import { useReasoningSurfaceRead } from "./shell-row-reads.js";

const SAMPLE_RUN_ID = "019b79ee-0280-740e-8110-d1a4c1150091" as RunId;
/** A second run, for the cases about a row re-addressed while a read is in flight. */
const OTHER_RUN_ID = "019b79ee-0280-740e-8110-d1a4c1150092" as RunId;
const REASONING_READ = "timeline.reasoningSurfaceRead";

/** One `ReasoningSurfaceReadResponse` on the arm that carries no entries. */
const UNAVAILABLE_REASONING: Record<string, unknown> = { availability: "unavailable" };

describe("useReasoningSurfaceRead — a refusal is retryable and an answer is not", () => {
  it("holds the door's own refusal rather than discarding it", async () => {
    const { held } = bridgeFailingUntilCleared(REASONING_READ, UNAVAILABLE_REASONING);
    const { result } = renderHook(() => useReasoningSurfaceRead(SAMPLE_RUN_ID), {
      wrapper: inBridge(held),
    });

    act(() => {
      result.current.expand();
    });
    await settle();

    expect(result.current.reading.status).toBe("refused");
  });

  it("issues a second read when a refused one is asked again", async () => {
    // THE DEFECT, EXERCISED. The guard admitted `not-asked` alone, so a read refused by
    // a transport that was down for one moment could never be taken again — and the
    // control was hidden in that state, so there was nothing on screen to press either.
    const { held, recover } = bridgeFailingUntilCleared(REASONING_READ, UNAVAILABLE_REASONING);
    const { result } = renderHook(() => useReasoningSurfaceRead(SAMPLE_RUN_ID), {
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

  it("negative control: a read that answered is not asked again", async () => {
    // Without this, admitting a refusal would have been written as admitting anything
    // settled — and a second press would re-ask a question whose answer is on screen,
    // for a page this surface holds no continuation cursor to extend.
    const { held, recover } = bridgeFailingUntilCleared(REASONING_READ, UNAVAILABLE_REASONING);
    recover();
    const { result } = renderHook(() => useReasoningSurfaceRead(SAMPLE_RUN_ID), {
      wrapper: inBridge(held),
    });

    act(() => {
      result.current.expand();
    });
    await settle();
    act(() => {
      result.current.expand();
    });
    await settle();

    expect(callsTo(held, REASONING_READ)).toBe(1);
  });

  it("negative control: a row with no run attribution asks nothing", async () => {
    const { held, recover } = bridgeFailingUntilCleared(REASONING_READ, UNAVAILABLE_REASONING);
    recover();
    const { result } = renderHook(() => useReasoningSurfaceRead(undefined), {
      wrapper: inBridge(held),
    });

    act(() => {
      result.current.expand();
    });
    await settle();

    expect(callsTo(held, REASONING_READ)).toBe(0);
    expect(result.current.reading.status).toBe("not-asked");
  });
});

/** What a case holds a scripted reasoning read with, and the act that answers it. */
interface HeldReasoningRead {
  readonly held: BridgeUnderTest;
  /** Let the read this bridge is holding answer. */
  readonly release: () => void;
}

/**
 * A bridge whose reasoning read answers only when the case says so.
 *
 * The window between the press and the reply is the whole subject below — a row
 * re-addressed at another run while its answer is on the wire — and it is not
 * observable without a reply the case releases.
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

describe("useReasoningSurfaceRead — the row moves while the answer is on the wire", () => {
  it("never lands one run's reasoning on a row addressed at another", async () => {
    // THE DEFECT, EXERCISED. The read carried no signal, so a row re-addressed at a
    // second run went on parsing the FIRST run's answer and folded it into the state
    // the surface renders — a reasoning surface belonging to a run nobody was looking
    // at, presented as this one's. Re-addressing the line abandons the read, so the
    // reply installs nothing.
    const { held, release } = bridgeHoldingReasoningRead();
    const { result, rerender } = renderHook((runId: RunId) => useReasoningSurfaceRead(runId), {
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

  it("negative control: the same held read lands when the row stays put", async () => {
    const { held, release } = bridgeHoldingReasoningRead();
    const { result } = renderHook((runId: RunId) => useReasoningSurfaceRead(runId), {
      initialProps: SAMPLE_RUN_ID,
      wrapper: inBridge(held),
    });

    act(() => {
      result.current.expand();
    });
    release();
    await settle();

    expect(result.current.reading.status).toBe("read");
  });
});
