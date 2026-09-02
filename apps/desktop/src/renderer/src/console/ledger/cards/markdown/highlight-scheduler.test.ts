// Where a block is tokenised, where the answer is kept, and what happens when it cannot
// be tokenised at all.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CODE_HIGHLIGHT_SOURCE_BYTE_CAP, CODE_WORKER_THRESHOLD_BYTES } from "../card-bounds.js";
import type { HighlightRequestMessage, HighlightResponseMessage } from "./highlight-protocol.js";
import {
  HIGHLIGHT_DECLINE_REASONS,
  CodeHighlightScheduler,
  type HighlightOutcome,
} from "./highlight-scheduler.js";

const schedulers: CodeHighlightScheduler[] = [];

/**
 * What a request that never answers looks like to a test.
 *
 * A hung promise is otherwise indistinguishable from a slow one, and a suite that
 * waited for the runner's own timeout would take five seconds to report the defect and
 * would report it as "timed out" rather than as "never settled".
 */
const NEVER_SETTLED = "never-settled";
const NEVER_SETTLED_MILLISECONDS = 50;

function neverSettledAfter(milliseconds: number): Promise<typeof NEVER_SETTLED> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(NEVER_SETTLED);
    }, milliseconds);
  });
}

function scheduler(byteCap?: number): CodeHighlightScheduler {
  const created =
    byteCap === undefined ? new CodeHighlightScheduler() : new CodeHighlightScheduler(byteCap);
  schedulers.push(created);
  return created;
}

afterEach(() => {
  for (const created of schedulers.splice(0)) {
    created.dispose();
  }
});

describe("tokenising a small block", () => {
  it("returns lines whose tokens carry family references and never colours", () => {
    const created = scheduler();
    return created.requestTokens("const answer = 1;\n", "typescript").then((outcome) => {
      expect(outcome.status).toBe("highlighted");
      if (outcome.status !== "highlighted") {
        return;
      }
      const references = outcome.lines
        .flat()
        .map((token) => token.colorReference)
        .filter((reference): reference is string => reference !== undefined);
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references) {
        expect(reference).toMatch(/^var\(--meridian-code-[a-z]+\)$/u);
      }
    });
  });

  it("serves the second request for one block from the cache", async () => {
    const created = scheduler();
    const first = await created.requestTokens("const a = 1;\n", "typescript");
    expect(created.cachedTokens("const a = 1;\n", "typescript")).not.toBeUndefined();
    const second = await created.requestTokens("const a = 1;\n", "typescript");
    expect(first.status).toBe("highlighted");
    expect(second.status).toBe("highlighted");
    if (first.status === "highlighted" && second.status === "highlighted") {
      expect(second.lines).toBe(first.lines);
    }
  });

  it("keys the cache on the language as well as the source", async () => {
    // The same text tokenises differently under two grammars; a key that dropped the
    // language would serve a JSON block's tokens for a YAML one.
    const created = scheduler();
    await created.requestTokens("a: 1\n", "yaml");
    expect(created.cachedTokens("a: 1\n", "yaml")).not.toBeUndefined();
    expect(created.cachedTokens("a: 1\n", "json")).toBeUndefined();
  });

  it("negative control: nothing is cached before it is asked for", () => {
    // Without this, a `cachedTokens` that answered with an empty array would make every
    // cache assertion above vacuous.
    expect(scheduler().cachedTokens("never requested\n", "typescript")).toBeUndefined();
  });
});

describe("declining to tokenise", () => {
  it("refuses a block past the source cap by name", async () => {
    const created = scheduler();
    const oversized = "x".repeat(CODE_HIGHLIGHT_SOURCE_BYTE_CAP + 1);
    const outcome = await created.requestTokens(oversized, "typescript");
    expect(outcome.status).toBe("declined");
    if (outcome.status === "declined") {
      expect(outcome.reason).toBe("source-too-large");
    }
  });

  it("names every refusal from its own closed set", async () => {
    const created = scheduler();
    const overThreshold = "y".repeat(CODE_WORKER_THRESHOLD_BYTES + 1);
    const outcome = await created.requestTokens(overThreshold, "typescript");
    if (outcome.status === "declined") {
      expect(HIGHLIGHT_DECLINE_REASONS).toContain(outcome.reason);
    } else {
      expect(outcome.lines.length).toBeGreaterThan(0);
    }
  });

  it("holds its cache inside a stated bound", async () => {
    const created = scheduler(512);
    await created.requestTokens("const a = 1;\n", "typescript");
    const stats = created.cacheStats();
    expect(stats.byteCap).toBe(512);
    expect(stats.retainedByteCount).toBeLessThanOrEqual(512);
  });
});

/**
 * A `Worker` the test drives, standing in for the realm's own.
 *
 * The scheduler's off-thread path is unreachable otherwise: `happy-dom` supplies no
 * module worker, so every large block declines before a message is ever posted and the
 * error path — the one this suite is about — has no way to be entered. The fake answers
 * exactly the three members `highlight-scheduler.ts` uses, so it cannot pass a test the
 * real seam would fail by supplying something the scheduler never asks for.
 */
class FakeHighlightWorker {
  public static latest: FakeHighlightWorker | undefined;

  public readonly postedRequests: HighlightRequestMessage[] = [];
  public terminateCount = 0;

  readonly #listenersByType = new Map<string, ((event: unknown) => void)[]>();

  public constructor() {
    FakeHighlightWorker.latest = this;
  }

  public addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.#listenersByType.get(type) ?? [];
    listeners.push(listener);
    this.#listenersByType.set(type, listeners);
  }

  public postMessage(request: HighlightRequestMessage): void {
    this.postedRequests.push(request);
  }

  public terminate(): void {
    this.terminateCount += 1;
  }

  /** The thread died. What the browser dispatches, with nothing the scheduler reads. */
  public dispatchError(): void {
    this.#dispatch("error", {});
  }

  /** One answered request, as the worker's protocol carries it. */
  public dispatchResponse(response: HighlightResponseMessage): void {
    this.#dispatch("message", { data: response });
  }

  #dispatch(type: string, event: unknown): void {
    for (const listener of this.#listenersByType.get(type) ?? []) {
      listener(event);
    }
  }
}

describe("a worker that dies", () => {
  const globalWorkerKey = "Worker";
  let originalWorkerConstructor: unknown;

  beforeEach(() => {
    originalWorkerConstructor = Reflect.get(globalThis, globalWorkerKey);
    FakeHighlightWorker.latest = undefined;
    Reflect.set(globalThis, globalWorkerKey, FakeHighlightWorker);
  });

  afterEach(() => {
    if (originalWorkerConstructor === undefined) {
      Reflect.deleteProperty(globalThis, globalWorkerKey);
      return;
    }
    Reflect.set(globalThis, globalWorkerKey, originalWorkerConstructor);
  });

  function overThresholdSource(fill: string): string {
    return fill.repeat(CODE_WORKER_THRESHOLD_BYTES + 1);
  }

  it("settles the block it was holding as an unavailable worker", async () => {
    const created = scheduler();
    const answered = created.requestTokens(overThresholdSource("a"), "typescript");
    const worker = FakeHighlightWorker.latest;
    expect(worker?.postedRequests).toHaveLength(1);
    worker?.dispatchError();
    const outcome = await answered;
    expect(outcome.status).toBe("declined");
    if (outcome.status === "declined") {
      expect(outcome.reason).toBe("worker-unavailable");
    }
  });

  it("lets the dead thread go rather than holding it for the next block", async () => {
    const created = scheduler();
    const answered = created.requestTokens(overThresholdSource("b"), "typescript");
    const worker = FakeHighlightWorker.latest;
    worker?.dispatchError();
    await answered;
    expect(worker?.terminateCount).toBe(1);
  });

  it("declines a later block instead of posting to a thread that is gone", async () => {
    // The whole defect, in one assertion: before the fix a request arriving after the
    // failure registered a settle nobody could ever call and posted to a terminated
    // worker, so this promise never settled at all and the caller's closure — and its
    // slot in the pending map — was retained for the life of the page.
    const created = scheduler();
    const answered = created.requestTokens(overThresholdSource("c"), "typescript");
    const worker = FakeHighlightWorker.latest;
    worker?.dispatchError();
    await answered;

    const later = created.requestTokens(overThresholdSource("d"), "typescript");
    const settled: HighlightOutcome | typeof NEVER_SETTLED = await Promise.race([
      later,
      neverSettledAfter(NEVER_SETTLED_MILLISECONDS),
    ]);
    expect(settled).not.toBe(NEVER_SETTLED);
    if (settled !== NEVER_SETTLED && settled.status === "declined") {
      expect(settled.reason).toBe("worker-unavailable");
    }
    // Nothing was posted to the dead thread, and no second worker was constructed to
    // take its place: the same instance is still the latest, still holding one request.
    expect(worker?.postedRequests).toHaveLength(1);
    expect(FakeHighlightWorker.latest).toBe(worker);
  });

  it("negative control: a worker that never errors answers exactly as before", async () => {
    // Without this the three assertions above are vacuous — a fake that could never
    // deliver an answer would decline for reasons that have nothing to do with the
    // error path.
    const created = scheduler();
    const answered = created.requestTokens(overThresholdSource("e"), "typescript");
    const worker = FakeHighlightWorker.latest;
    const request = worker?.postedRequests[0];
    expect(request).not.toBeUndefined();
    if (request !== undefined) {
      worker?.dispatchResponse({
        requestId: request.requestId,
        lines: [[{ content: "e", colorReference: undefined }]],
      });
    }
    const outcome = await answered;
    expect(outcome.status).toBe("highlighted");
    expect(worker?.terminateCount).toBe(0);
  });
});
