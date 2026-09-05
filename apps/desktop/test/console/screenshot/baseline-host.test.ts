// The tier's per-file guard, over both host states and both silences.
//
// `baseline-platform.test.ts` beside it drives the pure predicate over the three
// environments a host can declare. What is left for this file is everything that
// predicate is WRAPPED in and that a single machine can only ever see one branch of:
// whether a skip carries the reason it skipped for, whether the announcement is
// latched, and whether a comparing host says nothing rather than saying nothing
// loudly.
//
// So every case constructs the real guard over a host it names, and the only
// stand-in anywhere here is the recording CONTEXT — a stand-in for the guard would
// prove nothing about the code the tier runs.

import { describe, expect, it } from "vitest";

import {
  BaselineComparisonGuard,
  requireCapturedElement,
  screenshotUpdateMode,
  skipOffBaselineHost,
  warnOnceOffBaselineHost,
} from "./baseline-host.js";
import type { ConditionallySkippable } from "./baseline-host.js";
import {
  BASELINE_RUNNER_VARIABLE,
  LOCAL_COMPARISON_OPT_IN,
  LOCAL_COMPARISON_VARIABLE,
  PINNED_BASELINE_RUNNER,
  readBaselineHost,
} from "./baseline-platform.js";

/** The two hosts this guard has branches for, read the way the tier reads one. */
const ON_THE_RUNNER = readBaselineHost({ [BASELINE_RUNNER_VARIABLE]: PINNED_BASELINE_RUNNER });
const ON_A_HOST_THAT_DECLARED_NOTHING = readBaselineHost({});

/** What a case saw the guard ask of its context. */
interface RecordedSkip {
  readonly condition: boolean;
  readonly note: string;
}

/**
 * A context that records rather than skips.
 *
 * A class with a private field, because a case reads what the guard asked AFTER
 * asking it — and the recording has to be the case's own, since two cases in one file
 * share a module-level one.
 */
class RecordingContext implements ConditionallySkippable {
  readonly #asked: RecordedSkip[] = [];

  public skip(condition: boolean, note: string): void {
    this.#asked.push({ condition, note });
  }

  public get asked(): readonly RecordedSkip[] {
    return this.#asked;
  }
}

/** What a case saw the guard write. */
class RecordingWriter {
  readonly #written: string[] = [];

  public readonly write = (message: string): void => {
    this.#written.push(message);
  };

  public get written(): readonly string[] {
    return this.#written;
  }
}

describe("the screenshot tier's baseline guard", () => {
  it("skips off the runner, carrying the reason it skipped for", () => {
    const guard = new BaselineComparisonGuard(ON_A_HOST_THAT_DECLARED_NOTHING);
    const context = new RecordingContext();

    guard.skip(context);

    expect(guard.comparesHere).toBe(false);
    expect(context.asked).toStrictEqual([{ condition: true, note: guard.skipReason }]);
    // Not any sentence: the one that names the runner and the way to ask anyway.
    expect(guard.skipReason).toContain(PINNED_BASELINE_RUNNER);
    expect(guard.skipReason).toContain(LOCAL_COMPARISON_VARIABLE);
  });

  it("negative control: on the runner it asks with the condition false", () => {
    // The branch a developer machine never reaches, and the one that matters most:
    // a guard that skipped unconditionally would satisfy the case above and compare
    // nothing on the one host whose comparisons are the gate.
    const guard = new BaselineComparisonGuard(ON_THE_RUNNER);
    const context = new RecordingContext();

    guard.skip(context);

    expect(guard.comparesHere).toBe(true);
    expect(context.asked).toStrictEqual([{ condition: false, note: guard.skipReason }]);
  });

  it("announces once per file however many suites ask", () => {
    const guard = new BaselineComparisonGuard(ON_A_HOST_THAT_DECLARED_NOTHING);
    const writer = new RecordingWriter();

    guard.announceOnce(writer.write);
    guard.announceOnce(writer.write);
    guard.announceOnce(writer.write);

    expect(writer.written).toStrictEqual([guard.skipReason]);
  });

  it("negative control: a comparing host announces nothing at all", () => {
    // The other silence. A latch that only counted would say an empty something here,
    // and a reader of a green run on the runner would be told the comparisons were
    // skipped when they were the whole point of the run.
    const guard = new BaselineComparisonGuard(ON_THE_RUNNER);
    const writer = new RecordingWriter();

    guard.announceOnce(writer.write);
    guard.announceOnce(writer.write);

    expect(writer.written).toStrictEqual([]);
  });

  it("negative control: two guards latch independently", () => {
    // A latch on the module rather than on the guard would make the second file in a
    // run silent — which is the once-per-RUN claim this module's header refuses, and
    // it is invisible in a single-file run.
    const writer = new RecordingWriter();

    new BaselineComparisonGuard(ON_A_HOST_THAT_DECLARED_NOTHING).announceOnce(writer.write);
    new BaselineComparisonGuard(ON_A_HOST_THAT_DECLARED_NOTHING).announceOnce(writer.write);

    expect(writer.written).toHaveLength(2);
  });
});

describe("the screenshot tier's module-scoped guard", () => {
  it("skips this run's cases through the same guard the suites use", () => {
    // Non-vacuity for the file: every case above drives a constructed guard, and this
    // is the one that proves the module's own binding is wired to the same code and
    // reads THIS run's environment rather than a literal.
    const context = new RecordingContext();

    skipOffBaselineHost(context);

    expect(context.asked).toHaveLength(1);
    expect(context.asked[0]?.note).toContain(PINNED_BASELINE_RUNNER);
    expect(context.asked[0]?.note).toContain(LOCAL_COMPARISON_OPT_IN);
  });

  it("announces without throwing, whichever host this is", () => {
    // Both branches are legitimate here — a run on the runner says nothing, a run
    // anywhere else says one paragraph — so what is asserted is the call, not the
    // count. The count is asserted over named hosts above.
    expect(() => {
      warnOnceOffBaselineHost();
    }).not.toThrow();
  });

  it("reads the run's snapshot-update mode off the running server", () => {
    // The value `frame.test.tsx`'s two guard cases branch on. A mode this module could
    // not read would make both of them vacuous rather than red.
    expect(["none", "new", "all"]).toContain(screenshotUpdateMode);
  });
});

describe("the element a capture is taken of", () => {
  it("returns the element the selector names", () => {
    const container = document.createElement("div");
    const frame = document.createElement("section");
    frame.className = "meridian-frame";
    container.append(frame);

    expect(requireCapturedElement(container, ".meridian-frame")).toBe(frame);
  });

  it("negative control: throws naming the selector rather than returning null", () => {
    // The whole reason this is a helper. `container.querySelector(...)` handed to
    // `toMatchScreenshot` captures nothing and compares clean forever.
    const container = document.createElement("div");

    expect(() => requireCapturedElement(container, ".meridian-frame")).toThrowError(
      /rendered no \.meridian-frame element/,
    );
  });
});
