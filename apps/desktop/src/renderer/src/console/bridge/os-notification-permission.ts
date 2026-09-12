// Whether this machine's operating system will let the shell raise a notification.
//
// ONE READING FOR ONE WIRE, AND IT USED TO BE TWO. The notification centre and the
// notifications settings page ask the same machine the same question, and each had
// built its own probe against its own growth-slate row — two rows and two operations
// for one shell capability, which is a fixture that can answer one surface and refuse
// the other about the same machine at the same moment. `shellNotificationPermissionRead`
// is the wire, its row is `notification-permission-read`, and this module is the only
// caller of it.
//
// HERE RATHER THAN IN EITHER CONSUMER, on `quotas/provider-quota-feed.ts`' reason: the
// answer is the NODE's and not a session's or a page's, the two consumers are view
// families and a view family may not import its sibling, and `store/` sits below
// `bridge/` in the console's family DAG precisely so a store cannot reach a wire. So
// the read lives at the bridge, where both reach it through one door.
//
// WHAT THIS PUBLISHES IS THE ANSWER AND NOT A VERDICT. The three wire arms are carried
// through unfolded, because the two consumers fold them differently and both are right:
// the centre asks "will an emission reach anybody", for which `not-determined` is a yes
// — the first emission is what raises the system's own consent flow — while the page
// says something different for each of the three, and a machine nobody has asked yet is
// not a machine that said no. A fold performed here would have to pick one of them.
//
// AND IT IS RE-READ, BECAUSE THE ANSWER MOVES UNDERNEATH IT. Granting the permission
// happens outside this application, so the person leaves the window and comes back —
// which is exactly what `store/read/read-triggers.ts` calls a window trigger. Read once and
// never again, a window on a fresh install maps `not-determined` forever: the first
// banner raised the prompt, the person declined it, and both surfaces went on saying
// the machine was willing.
//
// THE PROBES OVERLAP, WHICH IS EXACTLY THE CASE THAT WAS WRONG. Mount, focus and
// reconnect arrive within a few hundred milliseconds of each other and their replies
// come back in whatever order the host answers in. A trigger that published
// unconditionally let an older `denied` land after a newer `granted` and put the stale
// answer back — until some later trigger happened to fire, which on a machine nobody
// touches is never.
//
// SO IT IS ORDERED TWICE OVER, AND BOTH HALVES ARE THE SUBSTRATE'S. Every trigger
// reaches `store/read/refresh-scheduler.ts`, which coalesces the burst into one call and serializes
// what it performs, so the ordinary case never has two probes out at all. And every
// settlement is measured against `store/read/generation-latch.ts` under one key, so a reply
// from a round something superseded — a probe still travelling when the surface was
// left, or one the host answered out of order — installs nothing. The scheduler alone
// would not be enough: it orders the calls it FIRES and says nothing about a reply that
// outlives its own round.

import { useCallback, useSyncExternalStore } from "react";

import { Emitter, type ConsoleClock, type Unsubscribe } from "../core/index.js";
import {
  GenerationLatch,
  NO_TRIGGERING_EVENT_KINDS,
  RefreshScheduler,
  useSubjectScopedResource,
  useSubjectScopedState,
  useWindowReadTriggers,
  type ReadTriggerTarget,
  type RefreshReason,
  type SubjectScopedDisposal,
} from "../store/index.js";
import { consoleClockFor, type ConsoleBridge } from "./console-bridge.js";

/**
 * What this machine answered, or that it could not be asked.
 *
 * `unread` is a state of its own rather than an absence folded into `unavailable`:
 * the probe has not answered yet, which is neither a permission nor a refusal, and a
 * surface drawn from either of those would speak for a machine nobody has asked.
 *
 * The `read` arm carries the wire's own member name, so the three arms are not
 * re-spelled between `GrowthNotificationPermission` and what a surface narrows on.
 */
export type OsNotificationPermissionReading =
  | { readonly kind: "unread" }
  | { readonly kind: "read"; readonly state: "granted" | "denied" | "not-determined" }
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
 * published cell, on this package's state rules: what it owns is a
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

  /** What a surface renders from. One held value, so its identity is stable. */
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
      const outcome = await this.#bridge.growth.shellNotificationPermissionRead({});
      round.settle(() => {
        this.#publish(
          outcome.status === "served"
            ? { kind: "read", state: outcome.value.state }
            : { kind: "unavailable" },
        );
      });
    } catch {
      // A machine that will not answer is exactly the state a surface exists to
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

/** How a probe whose bridge moved is retired, declared once at module scope. */
const OS_PERMISSION_READ_DISPOSAL: SubjectScopedDisposal<OsNotificationPermissionRead> = {
  dispose: (read) => {
    read.dispose();
  },
  isClosed: (read) => read.isDisposed,
};

/**
 * Watch this machine's permission, re-read whenever it can have changed.
 *
 * KEYED ON THE BRIDGE AND NOT ON A SESSION OR A PARTICIPANT, because the subject is
 * the machine: two surfaces open in one window ask one question, and a bridge swapped
 * underneath — the fixture's scenario switch — re-addresses the holder during the
 * render that first sees the new one.
 *
 * The clock is resolved from the BRIDGE rather than from `useConsoleClock`, which
 * reads the provider: a settings page is handed a bridge directly by its board, and
 * reaching for the provider would make the clock a second, stricter requirement than
 * the bridge the caller already has. Pinned rather than read per call because the live
 * arm of `consoleClockFor` MINTS — the reading it gives is the same either way, and
 * holding one is what keeps a scheduler armed on a clock that does not change
 * underneath it.
 */
export function useOsNotificationPermission(
  bridge: ConsoleBridge,
): OsNotificationPermissionReading {
  const { value: clock } = useSubjectScopedState(bridge, undefined, () => consoleClockFor(bridge));
  const { value: read } = useSubjectScopedResource(
    bridge,
    undefined,
    () => new OsNotificationPermissionRead({ bridge, clock }),
    OS_PERMISSION_READ_DISPOSAL,
  );
  useWindowReadTriggers(read, bridge.transportReconnect);
  const subscribeToRead = useCallback(
    (onStoreChange: () => void) => read.subscribe(onStoreChange),
    [read],
  );
  const takeReadSnapshot = useCallback(() => read.snapshot(), [read]);
  return useSyncExternalStore(subscribeToRead, takeReadSnapshot, takeReadSnapshot);
}
