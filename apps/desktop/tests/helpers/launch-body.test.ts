// The test-body allowance: what a body is handed, what an overrun says, and that the close runs
// whichever way the body went.
//
// Reachable without an Electron: `BodyAllowance` takes its clock as an argument and
// `withBoundedBody` takes the close alone. The arithmetic that keeps the allowance inside its tier
// is `launch-deadline.test.ts`'s; the close itself is `bounded-cleanup.test.ts`'s.
//
// The palette opening is here because `console-launch-body` counts it as one ten-second phase
// while `openPalette` performs two waits inside it, so "what does the second wait get" is this
// allowance's question asked about a step. It is driven through the real helper against a
// scripted window on a stopped clock.

import type { Page } from "@playwright/test";
import { describe, expect, it } from "vitest";

import { BodyAllowance, IN_WINDOW_STEP_TIMEOUT_MS, withBoundedBody } from "./launch-body.js";
import { BODY_ALLOWANCE_MS, ENDURANCE_BODY_ALLOWANCE_MS } from "./launch-budgets.js";
import { LaunchDeadline } from "./launch-deadline.js";
import { openPalette } from "./palette-interaction.js";

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
    // The figure a body passes to its own polls; the whole allowance after half was spent would
    // let a poll outlast its bound.
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
    // Both directions, each losing a different sentence: a long allowance keeps the wait's own
    // bound, so a stalled step reports as itself; a short one caps the wait, so the generic
    // overrun cannot replace its message.
    const clock = stoppedClock(1_000);
    const allowance = new BodyAllowance(30_000, clock.now);
    expect(allowance.boundedMs(10_000)).toBe(10_000);
    clock.advance(25_000);
    expect(allowance.boundedMs(10_000)).toBe(5_000);
  });

  it("never hands a wait zero, however spent the allowance is", () => {
    // The `remainingMs` floor must survive the minimum: `timeout: 0` is no timeout to Playwright.
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
    // A reader must get the harness's sentence naming the bound, not vitest's generic timeout.
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
    // The body's assertion explains the run; a clock sentence over it would invert that.
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
    // A body killed by vitest never reaches its cleanup, so the process it would have closed
    // survives into every later launch.
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
    // The wording decision must not depend on `Date.now()` agreeing with the bounding timer, which
    // fires against libuv's loop clock. Measured at a 5 ms budget, the timer fired with
    // `Date.now()` one millisecond short of expiry in 55 of 4 000 trials, giving the deadline's
    // sentence instead of the allowance's. A stopped clock makes that skew deterministic: the
    // timer fires and the second reading says the budget is untouched.
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
    // A body failing on its own after the allowance is gone still reports its own assertion,
    // since the deadline never raised the expiry; the wording is not applied to whatever comes out.
    const spent = stoppedClock(1_000);
    const allowance = new BodyAllowance(TEST_ALLOWANCE_MS, spent.now);
    const assertionFailure = new Error("the scheme did not change");
    spent.advance(TEST_ALLOWANCE_MS * 2);
    await expect(allowance.settle(() => Promise.reject(assertionFailure))).rejects.toBe(
      assertionFailure,
    );
  });

  it("negative control: the same wrapper that timed one body out passes a faster one", async () => {
    // Guards the case above against a wrapper that rejects everything.
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
 * A window that answers `openPalette`'s three questions and records what it was asked. It stands
 * in for the page, never the helper, and supplies what Chromium supplies too slowly to assert on
 * plus the timeout a wait received, which no Playwright API exposes.
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
    // The ordinary run: the helper still opens, reads focus and returns the combobox.
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
    // Two waits each declaring `IN_WINDOW_STEP_TIMEOUT_MS` would entitle a palette opening to
    // twenty seconds against a row that budgets ten. Sharing the phase leaves the second wait a
    // zero remainder, so the failure is the focus diagnostic, inside the ten seconds already paid.
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
    // Two halves. The poll really waits: leave the phase 300 ms and the rejection arrives about
    // 300 ms later. And a phase minted per wait would be unspent when the focus poll asks, handing
    // back the whole bound and doubling the cost.
    const clock = stoppedClock(1_000);
    const consoleWindow = new PaletteStubWindow({
      dialogSpendMs: IN_WINDOW_STEP_TIMEOUT_MS - LEFT_FOR_THE_POLL_MS,
      focusReading: UNFOCUSED_READING,
      advanceClock: clock.advance,
    });
    const allowance = new BodyAllowance(BODY_ALLOWANCE_MS, clock.now);
    // Minted from the same clock at the same instant as the call's own, so it reads what the
    // helper's phase reads.
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
    // One figure sized for endurance would give the end-to-end tier ten minutes of patience, and
    // one sized for end-to-end would kill the endurance workload.
    expect(new BodyAllowance().allowanceMs).toBe(BODY_ALLOWANCE_MS);
    expect(ENDURANCE_BODY_ALLOWANCE_MS).toBeGreaterThan(BODY_ALLOWANCE_MS);
  });
});
