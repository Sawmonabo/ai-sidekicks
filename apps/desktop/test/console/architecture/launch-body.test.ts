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

import { describe, expect, it } from "vitest";

import { BodyAllowance, withBoundedBody } from "../launch-body.js";
import { BODY_ALLOWANCE_MS, ENDURANCE_BODY_ALLOWANCE_MS } from "../launch-budgets.js";

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
