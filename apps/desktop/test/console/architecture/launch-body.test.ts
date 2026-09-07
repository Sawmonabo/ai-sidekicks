// The one phase of a launched-console test that used to be bounded by nothing.
//
// `launchConsole` is held to a deadline and `close()` is raced against a ceiling,
// and between them ran the caller's own body with no allowance at all. The
// end-to-end tier's timeout was a 60 000 ms literal; a launch is entitled to
// 45 000 ms of it and cleanup reserves 10 000 ms more, so a body declaring three
// 10 000 ms polls — which `e2e/frame-boot.test.ts`'s scheme-persistence case does
// — could be killed by vitest mid-poll. Everything a reader needs then goes at
// once: the poll's own message, the cleanup, and the Electron the cleanup would
// have closed.
//
// Reachable without an Electron, which is the point of the shape under test:
// `BodyAllowance` takes its clock as a constructor argument and `withBoundedBody`
// takes the close alone, so a body that overruns while a close records itself is
// two object literals. The arithmetic that keeps the allowance inside its tier is
// a different subject and is `launch-deadline.test.ts`'s; the close these cases
// assert still runs is `bounded-cleanup.test.ts`'s.
//
// THE SAME ARITHMETIC ONE LAYER IN, which is why the palette's opening is here
// rather than in a file of its own. `console-launch-body`'s derivation counts a
// palette opening as ONE ten-second phase and `openPalette` performs two waits
// inside it, so "what does the second wait get" is this allowance's own question
// asked about a step. It is driven through the real helper against a scripted
// window on the stopped clock the cases above already use, because a case proving
// the second wait gets the REMAINDER cannot be made to wait one out.

import type { Page } from "@playwright/test";
import { describe, expect, it } from "vitest";

import { BodyAllowance, IN_WINDOW_STEP_TIMEOUT_MS, withBoundedBody } from "../launch-body.js";
import { BODY_ALLOWANCE_MS, ENDURANCE_BODY_ALLOWANCE_MS } from "../launch-budgets.js";
import { LaunchDeadline } from "../launch-deadline.js";
import { openPalette } from "../palette-interaction.js";

/** An allowance short enough that exhausting it costs the suite nothing. */
const TEST_ALLOWANCE_MS = 200;

/** A close that records it was reached, the way the real one records its verdict. */
function recordingClose(): { readonly closed: () => boolean; readonly close: () => Promise<void> } {
  let wasClosed = false;
  return {
    closed: () => wasClosed,
    close: () => {
      wasClosed = true;
      return Promise.resolve();
    },
  };
}

/** A clock a case moves by hand, so an allowance is checked without waiting it out. */
function stoppedClock(startMs: number): { advance: (byMs: number) => void; now: () => number } {
  let current = startMs;
  return {
    advance: (byMs: number) => {
      current += byMs;
    },
    now: () => current,
  };
}

describe("body allowance — what is left, and what an overrun says", () => {
  it("hands a body what is LEFT rather than the whole allowance", () => {
    // The figure a body passes to its own polls. Handing back the whole
    // allowance after half of it had gone would let a poll outlast the bound
    // that is supposed to contain it.
    const clock = stoppedClock(1_000);
    const allowance = new BodyAllowance(30_000, clock.now);
    expect(allowance.allowanceMs).toBe(30_000);
    expect(allowance.remainingMs()).toBe(30_000);
    clock.advance(20_000);
    expect(allowance.remainingMs()).toBe(10_000);
  });

  it("never reports zero, which Playwright would read as no timeout at all", () => {
    const clock = stoppedClock(1_000);
    const allowance = new BodyAllowance(5_000, clock.now);
    clock.advance(500_000);
    expect(allowance.remainingMs()).toBe(1);
  });

  it("gives a wait the smaller of its own bound and what is left", () => {
    // Both directions, because each loses a different sentence. While the
    // allowance is long the wait keeps its own bound, so a stalled step reports
    // as a stalled step rather than as a body that ran long; once the allowance
    // is the shorter figure the wait takes THAT, so it cannot run past the
    // allowance and let the enclosing race replace its message with the generic
    // overrun.
    const clock = stoppedClock(1_000);
    const allowance = new BodyAllowance(30_000, clock.now);
    expect(allowance.boundedMs(10_000)).toBe(10_000);
    clock.advance(25_000);
    expect(allowance.boundedMs(10_000)).toBe(5_000);
  });

  it("never hands a wait zero, however spent the allowance is", () => {
    // The floor `remainingMs` carries has to survive the minimum, for the same
    // reason it exists: `timeout: 0` is no timeout at all to Playwright, so an
    // exhausted allowance would convert an overrun into an unbounded wait.
    const clock = stoppedClock(1_000);
    const allowance = new BodyAllowance(5_000, clock.now);
    clock.advance(500_000);
    expect(allowance.boundedMs(10_000)).toBe(1);
  });

  it("lets a body that settles in time through untouched", async () => {
    await expect(
      new BodyAllowance(TEST_ALLOWANCE_MS).settle(() => Promise.resolve("asserted")),
    ).resolves.toBe("asserted");
  });

  it("fails an overrunning body with the harness's own sentence naming the bound", async () => {
    // THE FINDING. What a reader used to get here was "test timed out in
    // 60000ms", which names neither the phase that was slow nor the allowance it
    // overran — and arrived after the close had already been skipped.
    await expect(
      new BodyAllowance(TEST_ALLOWANCE_MS).settle(() => new Promise<void>(() => undefined)),
    ).rejects.toThrow(
      new RegExp(
        `test body did not settle within the ${String(TEST_ALLOWANCE_MS)} ms allowance`,
        "u",
      ),
    );
  });

  it("lets a body's own failure through rather than reporting it as an overrun", async () => {
    // The body's assertion is the failure that explains the run. A sentence
    // about a clock over the top of it is the inversion this module stops.
    const assertionFailure = new Error("the scheme did not change");
    await expect(
      new BodyAllowance(TEST_ALLOWANCE_MS).settle(() => Promise.reject(assertionFailure)),
    ).rejects.toBe(assertionFailure);
  });
});

describe("body allowance — the close runs whichever way the body went", () => {
  it("closes after a body that succeeded, and returns its value", async () => {
    const application = recordingClose();
    const value = await withBoundedBody(application, new BodyAllowance(TEST_ALLOWANCE_MS), () =>
      Promise.resolve(42),
    );
    expect(value).toBe(42);
    expect(application.closed()).toBe(true);
  });

  it("closes after a body that OVERRAN, so no Electron is left alive", async () => {
    // The half of the finding that costs a later launch rather than a reader: a
    // body killed by vitest never reached its cleanup, so the process it would
    // have closed survived into every launch after it.
    const application = recordingClose();
    await expect(
      withBoundedBody(
        application,
        new BodyAllowance(TEST_ALLOWANCE_MS),
        () => new Promise<void>(() => undefined),
      ),
    ).rejects.toThrow(/did not settle within the .* ms allowance/u);
    expect(application.closed(), "the close was skipped after an overrun").toBe(true);
  });

  it("words the overrun as the allowance even when the clock disagrees with the timer", async () => {
    // THE RACE THIS CASE PINS, and why the case above is not enough on its own.
    //
    // The bounding `setTimeout` fires against libuv's loop clock while the wording
    // decision used to be re-derived from `Date.now()` — two independent readings of
    // "has the budget gone", which disagree. Measured on the authoring machine at a
    // 5 ms budget: the timer fired with `Date.now()` still one millisecond SHORT of
    // the expiry instant in 55 of 4 000 trials, 1.4 %. In those runs the overrun was
    // reported in the deadline's words rather than the allowance's, and the case
    // above failed on a runner and passed on every re-run — which is what it did.
    //
    // A STOPPED clock is that skew taken to its limit and made deterministic: the
    // timer still fires, and the second reading says the budget is untouched. Before
    // the fix this produced the deadline's sentence every time rather than one run in
    // seventy, so this case fails on the pre-fix shape by construction rather than by
    // luck. The allowance's own path is now what settles a body that overran, and it
    // knows it fired because the deadline SAYS so, not because a clock agrees.
    const application = recordingClose();
    const frozen = stoppedClock(1_000);
    await expect(
      withBoundedBody(
        application,
        new BodyAllowance(TEST_ALLOWANCE_MS, frozen.now),
        () => new Promise<void>(() => undefined),
      ),
    ).rejects.toThrow(
      new RegExp(
        `test body did not settle within the ${String(TEST_ALLOWANCE_MS)} ms allowance`,
        "u",
      ),
    );
    expect(application.closed(), "the close was skipped after an overrun").toBe(true);
  });

  it("still lets a body's own failure through when the deadline has spent its budget", async () => {
    // The other direction, and the reason the decision cannot simply be "reword
    // whatever comes out". A body that fails on its own AFTER the allowance is gone
    // must still report its own assertion: an expiry the deadline never raised is not
    // this harness's failure to describe.
    const spent = stoppedClock(1_000);
    const allowance = new BodyAllowance(TEST_ALLOWANCE_MS, spent.now);
    const assertionFailure = new Error("the scheme did not change");
    spent.advance(TEST_ALLOWANCE_MS * 2);
    await expect(allowance.settle(() => Promise.reject(assertionFailure))).rejects.toBe(
      assertionFailure,
    );
  });

  it("negative control: the same wrapper that timed one body out passes a faster one", async () => {
    // Without this the case above is ambiguous between "the allowance expired"
    // and "the wrapper rejects everything".
    const application = recordingClose();
    const allowance = new BodyAllowance(TEST_ALLOWANCE_MS);
    await expect(
      withBoundedBody(
        application,
        allowance,
        () =>
          new Promise<string>((settle) => {
            setTimeout(() => {
              settle("asserted");
            }, TEST_ALLOWANCE_MS / 4);
          }),
      ),
    ).resolves.toBe("asserted");
    expect(application.closed()).toBe(true);
  });
});

/** What a palette that opened but has not taken focus reports, as the reader names it. */
const UNFOCUSED_READING = "present-unfocused";

/** What the opening phase has left for the focus poll in the control below. */
const LEFT_FOR_THE_POLL_MS = 300;

/** The sentence `openPalette` gives when focus never arrived, matched by its distinctive half. */
const FOCUS_DIAGNOSTIC = /never moved focus into its input/u;

/** What one scripted window is told to do, and the clock its dialog wait spends. */
interface PaletteWindowScript {
  /** How much of the opening phase the dialog wait consumes before it resolves. */
  readonly dialogSpendMs: number;
  /** What every focus read reports — the palette's state for the whole poll. */
  readonly focusReading: string;
  /** The stopped clock the dialog wait advances, so no case waits a phase out. */
  readonly advanceClock: (byMs: number) => void;
}

/**
 * A window that answers `openPalette`'s three questions and records what it was asked.
 *
 * A stand-in for the PAGE and never for the helper, which is imported real. It
 * supplies the two facts a Chromium supplies too slowly to assert about — a
 * dialog that appears after some of the phase has gone, an input that never takes
 * focus — plus the reading no Playwright API exposes: the timeout a wait received.
 */
class PaletteStubWindow {
  readonly #script: PaletteWindowScript;
  #dialogTimeoutMs: number | null = null;
  #focusReads = 0;

  constructor(script: PaletteWindowScript) {
    this.#script = script;
  }

  /** The timeout the dialog wait was handed — the phase, before anything had spent it. */
  get dialogTimeoutMs(): number | null {
    return this.#dialogTimeoutMs;
  }

  /** How many times the focus reading was taken, so no assertion passes over an unrun poll. */
  get focusReads(): number {
    return this.#focusReads;
  }

  readonly keyboard = {
    press: (): Promise<void> => Promise.resolve(),
  };

  getByRole(): { readonly waitFor: (options: { readonly timeout: number }) => Promise<void> } {
    return {
      waitFor: (options: { readonly timeout: number }): Promise<void> => {
        this.#dialogTimeoutMs = options.timeout;
        this.#script.advanceClock(this.#script.dialogSpendMs);
        return Promise.resolve();
      },
    };
  }

  evaluate(): Promise<string> {
    this.#focusReads += 1;
    return Promise.resolve(this.#script.focusReading);
  }

  /** The cast every Playwright stand-in in this package makes at its boundary. */
  asPage(): Page {
    return this as unknown as Page;
  }
}

describe("palette opening — two waits, one phase of the body allowance", () => {
  it("hands the dialog wait the whole phase, and returns the input once focus lands", async () => {
    // The ordinary run, and the non-vacuity every case below rests on: the
    // helper still opens, still reads focus, and still returns the combobox.
    const clock = stoppedClock(1_000);
    const consoleWindow = new PaletteStubWindow({
      dialogSpendMs: 2_000,
      focusReading: "focused",
      advanceClock: clock.advance,
    });
    const allowance = new BodyAllowance(BODY_ALLOWANCE_MS, clock.now);

    await expect(
      openPalette({ window: consoleWindow.asPage(), bodyAllowance: allowance }, clock.now),
    ).resolves.toBeDefined();

    expect(
      consoleWindow.dialogTimeoutMs,
      "the dialog wait was not handed the whole opening phase",
    ).toBe(IN_WINDOW_STEP_TIMEOUT_MS);
    expect(consoleWindow.focusReads).toBeGreaterThanOrEqual(1);
  });

  it("fails on the focus reading INSIDE the phase when the dialog spent all of it", async () => {
    // THE FINDING. Two waits each declaring `IN_WINDOW_STEP_TIMEOUT_MS` is a
    // palette opening entitled to twenty seconds against a row that budgets ten,
    // so an opening that is slow but in bound spent the body's allowance on
    // behalf of every step after it — and the first of those was then killed by
    // the enclosing race with the generic overrun in place of its own sentence.
    // Sharing the phase makes the second wait's remainder zero, so the failure is
    // the focus diagnostic and it arrives inside the ten seconds already paid for.
    const clock = stoppedClock(1_000);
    const consoleWindow = new PaletteStubWindow({
      dialogSpendMs: IN_WINDOW_STEP_TIMEOUT_MS,
      focusReading: UNFOCUSED_READING,
      advanceClock: clock.advance,
    });
    const allowance = new BodyAllowance(BODY_ALLOWANCE_MS, clock.now);

    const startedAt = Date.now();
    await expect(
      openPalette({ window: consoleWindow.asPage(), bodyAllowance: allowance }, clock.now),
    ).rejects.toThrow(FOCUS_DIAGNOSTIC);
    const elapsedMs = Date.now() - startedAt;

    expect(
      consoleWindow.focusReads,
      "the focus poll never ran, so it failed on nothing",
    ).toBeGreaterThanOrEqual(1);
    expect(
      elapsedMs,
      "the focus poll ran past the phase the dialog had already spent — it was handed a second full bound",
    ).toBeLessThan(IN_WINDOW_STEP_TIMEOUT_MS);
  });

  it("negative control: the poll spends the REMAINDER, and a per-wait phase would restore the whole bound", async () => {
    // Two halves of one control. First, the case above is not passing on a poll
    // that never waits: leave the phase 300 ms and the rejection arrives about
    // 300 ms later, so what the poll receives really is what the dialog left.
    // Second, the shape this fix removed, through the same real classes — a phase
    // minted per wait is unspent when the focus poll asks, so it hands back the
    // whole bound again and the pair costs twice what the row pays for.
    const clock = stoppedClock(1_000);
    const consoleWindow = new PaletteStubWindow({
      dialogSpendMs: IN_WINDOW_STEP_TIMEOUT_MS - LEFT_FOR_THE_POLL_MS,
      focusReading: UNFOCUSED_READING,
      advanceClock: clock.advance,
    });
    const allowance = new BodyAllowance(BODY_ALLOWANCE_MS, clock.now);
    // Minted from the same clock at the same instant the call mints its own, so
    // this reads exactly what the helper's phase reads without reaching into it.
    const phaseAsTheCallMintsIt = new LaunchDeadline(IN_WINDOW_STEP_TIMEOUT_MS, clock.now);

    const startedAt = Date.now();
    await expect(
      openPalette({ window: consoleWindow.asPage(), bodyAllowance: allowance }, clock.now),
    ).rejects.toThrow(FOCUS_DIAGNOSTIC);
    const elapsedMs = Date.now() - startedAt;

    expect(phaseAsTheCallMintsIt.remainingMs()).toBe(LEFT_FOR_THE_POLL_MS);
    expect(
      elapsedMs,
      "the focus poll returned without spending the remainder, so the case above proves nothing",
    ).toBeGreaterThanOrEqual(LEFT_FOR_THE_POLL_MS - 50);
    expect(
      allowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
      "the superseded figure is no longer the whole bound, so this control no longer reproduces the overspend",
    ).toBe(IN_WINDOW_STEP_TIMEOUT_MS);
  });
});

describe("body allowance — the registered figures", () => {
  it("gives the endurance tier a longer allowance than the default", () => {
    // Both rows exist for this inequality: a single figure sized for the
    // endurance workload would hand the end-to-end tier a ten-minute patience,
    // and one sized for an end-to-end body would kill the endurance workload
    // nine times over. A default is applied when a tier states nothing.
    expect(new BodyAllowance().allowanceMs).toBe(BODY_ALLOWANCE_MS);
    expect(ENDURANCE_BODY_ALLOWANCE_MS).toBeGreaterThan(BODY_ALLOWANCE_MS);
  });
});
