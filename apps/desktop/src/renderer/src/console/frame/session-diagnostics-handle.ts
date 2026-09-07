// What a fixture build lets the endurance tier read about this window's sessions,
// and the property it hangs off.
//
// SPLIT OUT OF `session-event-binder.ts` BECAUSE IT IS THE OTHER JOB THAT FILE WAS
// DOING. The binder owns a lifecycle: which sessions hold a wire subscription, when
// each one opens and closes, and what happens to a delivery that arrives after the
// close. This module owns a PAGE PROPERTY: what shape it carries, that it is installed
// only under the fixture define, and that a second console mounting in the same page
// replaces the first one's handle rather than two binders fighting over one name. The
// two meet at three calls and share no state.
//
// THE READS ARE THE BINDER'S AND THE INSTALLATION IS NOT. This module never composes
// what the handle answers — it is handed a frozen object and puts it on the page — so
// there is no second opinion here about what "bound" or "applied" counts.

import { SESSION_DIAGNOSTICS_FIXTURE_GLOBAL } from "../core/index.js";

/**
 * What a fixture build exposes to the endurance tier, and nothing more.
 *
 * Three reads, no writes and no handles: a tier driving a real window from outside
 * the renderer can ask what is open, what is bound, and how much has flowed, and
 * cannot open a session, close one, or apply an event.
 */
export interface ConsoleSessionDiagnostics {
  /** Sessions the registry currently holds a store for, in open order. */
  openSessionIds: () => readonly string[];
  /**
   * Events this window has put through one session's apply chokepoint.
   *
   * Deliberately NOT the store's timeline length: a store admits nothing until a
   * read gives it a base state, so a timeline reading is zero for every session
   * whose read has not landed, and a diagnostic that reports the same number
   * whether or not the binder exists is worse than no diagnostic at all. This
   * counts admissions to the chokepoint: deliveries the registry accepted for a
   * session's apply queue. It is zero — correctly, and beside `boundSessionIds()`
   * reading empty — on a window whose registry can initialise no store, because
   * that window takes no wire subscription in the first place.
   *
   * Retained after a session closes, so the count FREEZES rather than vanishing.
   * A reading that disappeared on close could not be told apart from a session
   * that never received anything.
   */
  appliedEventCountFor: (sessionId: string) => number;
  /** Sessions the binder currently holds a wire subscription for. */
  boundSessionIds: () => readonly string[];
}

/*
 * The property a fixture build hangs the session diagnostics on.
 *
 * Declared in `core/fixture-globals.ts` and re-exported here, so this installer
 * and the release-absence sweep that proves the handle absent read one string.
 * Re-exported rather than only imported because the tier that reads it reaches
 * this seam by name, so a rename is a compile error there instead of a check
 * that silently starts reading `undefined` and reports nothing forever.
 */
export { SESSION_DIAGNOSTICS_FIXTURE_GLOBAL };

/**
 * One console's claim on the diagnostics property.
 *
 * A class with a private field rather than two free functions over the page object,
 * per `apps/desktop/AGENTS.md`: what is installed is state, one instance belongs to
 * one binder, and the identity check below is only meaningful against a remembered
 * value. A module-level flag would make two consoles in one page share a claim that
 * only one of them made.
 */
export class SessionDiagnosticsHandle {
  #installed: ConsoleSessionDiagnostics | undefined;

  /**
   * Expose the reads to the page under the fixture define, and only there.
   *
   * The same guard, and for the same reason, as the tripwire registry's: the
   * endurance tier drives a real window from outside the renderer, so the only way
   * it can read a binder is through the page, and letting the tier treat an
   * unreachable binder as "nothing to assert" would be a check that passes whether
   * or not the thing it measures exists.
   *
   * `__SIDEKICKS_CONSOLE_FIXTURES__` is a literal at build time, so a release
   * bundle contains neither the property nor the object it would have held.
   */
  public install(diagnostics: ConsoleSessionDiagnostics): void {
    if (__SIDEKICKS_CONSOLE_FIXTURES__) {
      this.#installed = diagnostics;
      (globalThis as Record<string, unknown>)[SESSION_DIAGNOSTICS_FIXTURE_GLOBAL] = diagnostics;
    }
  }

  /**
   * Remove this handle's object, and only this one's.
   *
   * One property, one renderer process — the tripwire registry's posture — so a
   * second console mounted in the same page replaces the first one's object. The
   * identity check is what keeps the teardown of the REPLACED binder from deleting
   * the live one's.
   */
  public remove(): void {
    if (__SIDEKICKS_CONSOLE_FIXTURES__) {
      const page = globalThis as Record<string, unknown>;
      if (
        this.#installed !== undefined &&
        page[SESSION_DIAGNOSTICS_FIXTURE_GLOBAL] === this.#installed
      ) {
        delete page[SESSION_DIAGNOSTICS_FIXTURE_GLOBAL];
      }
      this.#installed = undefined;
    }
  }
}
