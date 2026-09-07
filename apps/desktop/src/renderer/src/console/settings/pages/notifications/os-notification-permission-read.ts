// Whether this machine's operating system will let the shell raise a notification.
//
// ITS OWN READING BECAUSE IT ANSWERS FOR THE MACHINE rather than for a participant:
// it re-reads on the window's own triggers — a person granting the permission does so
// outside this application and comes back to it — and it is addressed by no session
// and no participant. No wire serves it today, which is a row on the growth slate
// rather than a silence: the page says the question could not be put, and never that
// the answer was yes.
//
// THE PROBES OVERLAP, WHICH IS EXACTLY THE CASE THAT WAS WRONG. Granting the
// permission is a trip outside the window and back, so the mount probe, the focus
// probe and the reconnect probe arrive within a few hundred milliseconds of each
// other and their replies come back in whatever order the host answers in. Every one
// of them used to publish unconditionally, so an older `denied` landing after a newer
// `granted` put the stale notice back on screen — and left it there until some later
// trigger happened to fire, which on a machine nobody touches is never.
//
// SO IT IS ORDERED TWICE OVER, AND BOTH HALVES ARE THE SUBSTRATE'S. Every trigger
// reaches `store/scheduling.ts`, which coalesces the burst into one call and
// serializes what it performs, so the ordinary case never has two probes out at all.
// And every settlement is measured against `store/generation-latch.ts` under one key,
// so a reply from a round something superseded — a probe still travelling when the
// page was left, or one the host answered out of order — installs nothing. The
// scheduler alone would not be enough: it orders the calls it FIRES and says nothing
// about a reply that outlives its own round.

import type { ConsoleBridge } from "../../../bridge/index.js";
import { Emitter, type ConsoleClock, type Unsubscribe } from "../../../core/index.js";
import {
  GenerationLatch,
  NO_TRIGGERING_EVENT_KINDS,
  RefreshScheduler,
  type ReadTriggerTarget,
  type RefreshReason,
} from "../../../store/index.js";

/**
 * What this machine answered, or that it could not be asked.
 *
 * `unread` is a state of its own rather than an absence folded into `unavailable`:
 * the probe has not answered yet, which is neither a permission nor a refusal, and a
 * notice drawn from either of those would speak for a machine nobody has asked.
 */
export type OsNotificationPermissionReading =
  | { readonly kind: "unread" }
  | { readonly kind: "read"; readonly status: "granted" | "denied" | "not-determined" }
  | { readonly kind: "unavailable" };

const UNREAD: OsNotificationPermissionReading = Object.freeze({ kind: "unread" });

/** The one key every probe of this machine's permission is taken under. */
const OS_PERMISSION_READ_KEY = "os-notification-permission-read";

export interface OsNotificationPermissionReadOptions {
  readonly bridge: ConsoleBridge;
  /** The clock the scheduler arms on. The fixture's frozen one under a scenario. */
  readonly clock: ConsoleClock;
}

/**
 * One machine's notification permission, kept current by the window's triggers.
 *
 * A class with private fields rather than a memoised trigger target holding a
 * published cell, per `apps/desktop/AGENTS.md` §State and views: what it owns is a
 * scheduler, a single-flight round, and the rule that decides which probe's answer is
 * the one on screen.
 */
export class OsNotificationPermissionRead implements ReadTriggerTarget {
  /**
   * No timeline event refreshes this probe, and the empty set states it.
   *
   * This is the MACHINE's permission. No session event bears on what the operating
   * system allows, and a probe that listened for one would be tying a machine-wide
   * answer to whichever session happened to be open.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = NO_TRIGGERING_EVENT_KINDS;
  readonly #bridge: ConsoleBridge;
  readonly #changes = new Emitter<void>("os notification permission read change");
  readonly #rounds = new GenerationLatch();
  readonly #scheduler: RefreshScheduler;
  #reading: OsNotificationPermissionReading = UNREAD;
  #isDisposed = false;

  public constructor(options: OsNotificationPermissionReadOptions) {
    this.#bridge = options.bridge;
    this.#scheduler = new RefreshScheduler({
      clock: options.clock,
      perform: async () => {
        await this.#probe();
      },
      // The probe turns a rejection into `unavailable` itself and never rejects, so
      // this arm covers a defect in the publish rather than anything the host did. It
      // must exist: without it the scheduler re-throws inside a timer callback, where
      // no surface has a `catch` to render.
      onError: () => undefined,
    });
  }

  /** What the notice renders from. One held value, so its identity is stable. */
  public snapshot(): OsNotificationPermissionReading {
    return this.#reading;
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /** Whether this reading has been disposed. The re-mint its holder takes. */
  public get isDisposed(): boolean {
    return this.#isDisposed;
  }

  /** Ask the machine again. Every window trigger arrives here and none probes. */
  public requestRead(reason: RefreshReason): void {
    if (this.#isDisposed) {
      return;
    }
    this.#scheduler.request(reason);
  }

  /** Terminal. A probe landing after this publishes nothing. */
  public dispose(): void {
    this.#isDisposed = true;
    this.#scheduler.dispose();
    this.#rounds.supersedeAll();
  }

  /**
   * Probe once, and publish only if this round is still the live one.
   *
   * The round is minted here and settles here, so the register holds nothing between
   * probes. What it buys is the guard the scheduler cannot give: an answer arriving
   * after a later probe was taken finds no key naming its serial and installs
   * nothing, so a stale `denied` can no longer overwrite a fresh `granted`.
   */
  async #probe(): Promise<void> {
    const round = this.#rounds.currentClaim(this, OS_PERMISSION_READ_KEY);
    try {
      const outcome = await this.#bridge.growth.attentionOsPermissionRead({});
      round.settle(() => {
        this.#publish(
          outcome.status === "served"
            ? { kind: "read", status: outcome.value.status }
            : { kind: "unavailable" },
        );
      });
    } catch {
      // A machine that will not answer is exactly the state the notice exists to
      // report, and silence would read as "granted" — the one thing this console must
      // not claim on nobody's behalf.
      round.settle(() => {
        this.#publish({ kind: "unavailable" });
      });
    }
  }

  #publish(reading: OsNotificationPermissionReading): void {
    this.#reading = reading;
    this.#changes.emit();
  }
}
