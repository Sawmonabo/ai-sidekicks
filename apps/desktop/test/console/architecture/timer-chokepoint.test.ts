// Every timer in the console is minted through one seam, asserted.
//
// `Spec-023 §Console Design (Meridian)`'s idle-CPU budget is checked by COUNTING
// armed work on the `ConsoleClock` seam — `ManualClock.pendingCount === 0` after
// settle is the console's "no timer fires" claim, and `core/clock.ts` says so in its
// own header. That check is only as good as its premise: it counts what went through
// the seam, and a module that reached for `globalThis.setTimeout` directly is
// invisible to it. So the runtime count answers "how much is armed" and this answers
// "is the count the whole of it", and neither claim subsumes the other.
//
// `apps/desktop` AGENTS.md names the refresh chokepoint and "no `setInterval`" in its
// pre-PR audit, and until this file the only thing standing behind either was a
// reviewer remembering to look. A timer is never introduced deliberately: it arrives
// as three lines in a component that needed something to happen a second from now.
//
// WHAT THE ALLOW-LIST HOLDS, AND WHY IT IS ONE ENTRY. `core/clock.ts` is the seam
// itself — it is where a platform timer is armed, and it mints its own handles so
// cancellation is idempotent across the two independent handle spaces the platform
// keeps. `store/deadline-wake.ts` arms the console's other timer, the wall-clock
// wake-up a deadline row needs, and it takes NO entry here: it arms through
// `ConsoleClock.scheduleTimeout` like every other consumer, which is the whole point.
// An allow-list entry for it would be an exemption nothing needs, and a stale
// exemption is how the next one gets waved through.
//
// THE HONEST LIMIT. This reads text, so it catches the direct call and not an alias
// (`const later = globalThis.setTimeout; later(…)`) or a dynamic reach. The runtime
// counterpart is the one that would catch those, and it exists: the endurance tier
// reads the clock's pending count out of a real renderer. Text is the right
// instrument for the ordinary case because it is the ordinary case that happens.
//
// Test files are excluded by the shared source walk, for the reason the byte-scaling
// chokepoint states for its own: a test that yields a turn with `setTimeout(resolve, 0)`
// is not a console timer, and forbidding it would forbid the tiers that check this.

import { describe, expect, it } from "vitest";

import {
  consoleSourceModules,
  moduleNamed,
  readConsoleSourceModule,
  type ConsoleSourceModule,
} from "../console-source-modules.js";

/**
 * The one module allowed to arm a platform timer.
 *
 * A path rather than a naming convention, so moving the seam is an edit a reviewer
 * sees rather than a rename the gate follows silently.
 */
const CLOCK_SEAM_MODULE = "console/core/clock.ts";

/**
 * How a platform timer is armed, in the forms a call site writes.
 *
 * Each needle carries its open paren, so the word in a comment explaining why a
 * module does NOT arm one is not an offence — `persistence/indexeddb-adapter.ts`
 * says exactly that about itself.
 */
const TIMER_ARMING_FORMS: readonly string[] = [
  "setTimeout(",
  "setInterval(",
  "requestAnimationFrame(",
  "requestIdleCallback(",
];

/**
 * Every way `source` shows it armed a platform timer, or `[]`.
 *
 * A pure function over text so the controls below can drive it with strings whose
 * verdict is known, and the checker is proved to bite without perturbing a module.
 */
function timerArmingSignatures(source: string): readonly string[] {
  return TIMER_ARMING_FORMS.filter((form) => source.includes(form));
}

describe("timer chokepoint — one seam arms every console timer", () => {
  const modules: readonly ConsoleSourceModule[] = consoleSourceModules();

  it("finds a console tree to scan at all", () => {
    // Without this a wrong root would scan nothing and every assertion below would
    // pass over the empty set.
    expect(modules.length).toBeGreaterThan(20);
    expect(modules.map((module) => module.displayPath)).toContain(CLOCK_SEAM_MODULE);
  });

  it("finds at least one armed timer, so the scan is not vacuous", () => {
    // The seam arms one, so a scan reporting none anywhere has stopped reading the
    // tree rather than found a console with no timers in it.
    const arming = modules.filter(
      (module) => timerArmingSignatures(readConsoleSourceModule(module)).length > 0,
    );
    expect(arming.map((module) => module.displayPath)).not.toStrictEqual([]);
  });

  it("no module outside the seam arms one", () => {
    const offenders = modules
      .filter((module) => module.displayPath !== CLOCK_SEAM_MODULE)
      .map((module) => ({
        module: module.displayPath,
        signatures: timerArmingSignatures(readConsoleSourceModule(module)),
      }))
      .filter((entry) => entry.signatures.length > 0)
      .map((entry) => `${entry.module}: ${entry.signatures.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the seam itself trips the check", () => {
    // The clean result above is only meaningful if the needles match real code.
    const seam = moduleNamed(modules, CLOCK_SEAM_MODULE);
    expect(timerArmingSignatures(readConsoleSourceModule(seam))).toContain("setTimeout(");
  });

  it("negative control: the predicate reads calls and not prose", () => {
    // The two sides of the line the header draws, against the predicate rather than
    // against whichever module happens to mention a timer in a comment today.
    expect(
      timerArmingSignatures("// A seam rather than a bare `setTimeout` for the usual reason."),
    ).toStrictEqual([]);
    expect(timerArmingSignatures("const handle = setInterval(tick, 1000);")).toStrictEqual([
      "setInterval(",
    ]);
    expect(timerArmingSignatures("window.requestAnimationFrame(paint);")).toStrictEqual([
      "requestAnimationFrame(",
    ]);
  });

  it("negative control: the wall-clock wake-up needs no exemption", () => {
    // It arms through the seam, which is why it is not on the allow-list. If that
    // ever stopped being true this assertion is what would say so, rather than an
    // allow-list entry quietly appearing beside the seam's.
    const wake = moduleNamed(modules, "console/store/deadline-wake.ts");
    expect(timerArmingSignatures(readConsoleSourceModule(wake))).toStrictEqual([]);
    expect(readConsoleSourceModule(wake)).toContain("clock.scheduleTimeout(");
  });
});
