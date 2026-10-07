// What each bound driver declared, read once per bridge and shared by every view. The answer is
// addressed at the service, not a run or session, so it belongs to the bridge; the cache is a
// `WeakMap` so a closed window's entry and a test's fixture reply are not kept.
// `useDriverCapabilities` and `useDriverCapabilityRepairRead` are the two entry points, and
// `readNextReply` hands the whole report to a read that needs more than the flags.
//
// A rejection or an unreadable reply settles with the daemon's refusal on the readout and the
// flags absent, which keeps gating fail-closed; a reply naming no driver is an answered read, not
// a refusal. No settlement is terminal: `RefreshScheduler` re-reads on the window's refresh
// reasons with no interval or retry loop, and a settled readout stays on screen during the next
// read so a control does not vanish on every window focus.

import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { ListCapabilitiesResult } from "@ai-sidekicks/contracts/provider/driver/methods";

import { RefusalError, type Refusal } from "#renderer/lib/refusal/contract.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  type ReadTriggerTarget,
} from "#renderer/store/reads/triggers.js";
import { RefreshScheduler, type RefreshReason } from "#renderer/lib/reads/refresh/scheduler.js";
import { isReadAbandoned, type ReadRound } from "#renderer/lib/reads/scope.js";
import type {
  DeclaredDriverFlags,
  DriverCapabilityReadout,
} from "#renderer/store/driver-capabilities/readout.js";
import { abandonedReadRefusal, callDaemon, type DaemonReply } from "../daemon/reply.js";
import { type Clock } from "#renderer/lib/clock.js";
import { type PlatformBridge } from "../platform/bridge.js";

/** The reply a settled read carries to everyone waiting on it. */
type CapabilityReply = DaemonReply<ListCapabilitiesResult>;

/** No run has a named binding yet. */
const NO_RUN_BINDINGS: ReadonlyMap<string, ProviderName> = new Map<string, ProviderName>();

/** The declarations a failed read carries: none. */
const NO_DECLARATIONS: ReadonlyMap<ProviderName, DeclaredDriverFlags> = new Map<
  ProviderName,
  DeclaredDriverFlags
>();

/**
 * One bridge's reading, everyone waiting on it, and the scheduler that refreshes it. The three are
 * one invariant: the readout is what the last completed read settled, listeners are told when
 * that happens, and only the scheduler puts a call on the wire.
 */
class BridgeCapabilityRead implements ReadTriggerTarget {
  /**
   * Nothing in a session's transcript says the service's declarations changed: a driver declares at
   * the service and session events are about that session's runs. The reading goes stale when the
   * window has been away or the connection was repaired, never because a run ended.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = NO_TRIGGERING_EVENT_KINDS;
  readonly #bridge: PlatformBridge;
  readonly #scheduler: RefreshScheduler;
  readonly #listeners = new Set<(reply: CapabilityReply) => void>();
  #readout: DriverCapabilityReadout | undefined;

  public constructor(bridge: PlatformBridge, clock: Clock) {
    this.#bridge = bridge;
    this.#scheduler = new RefreshScheduler({
      // The window's clock: the fixture's frozen clock wherever a scenario is playing.
      clock,
      perform: async (_reasons, round) => {
        await this.#read(round);
      },
    });
  }

  /** The settled readout, or `undefined` until the first read answers. */
  public get readout(): DriverCapabilityReadout | undefined {
    return this.#readout;
  }

  /**
   * Asks for a read. The scheduler coalesces requests, so views mounting together on one session
   * cost one call.
   */
  public requestRead(reason: RefreshReason): void {
    this.#scheduler.request(reason);
  }

  /** Watch this bridge's reading. Returns an idempotent unwatch. */
  public watch(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * The whole report the next settled read serves. Rejects with a `RefusalError` carrying the
   * daemon's refusal when that read is refused, and with the abandoned-read refusal once `signal`
   * aborts.
   */
  public readNextReply(signal: AbortSignal): Promise<ListCapabilitiesResult> {
    if (isReadAbandoned(signal)) {
      return Promise.reject(new RefusalError(abandonedReadRefusal()));
    }
    return new Promise<ListCapabilitiesResult>((resolve, reject) => {
      const onSettled = (reply: CapabilityReply): void => {
        this.#listeners.delete(onSettled);
        signal.removeEventListener("abort", onAbandoned);
        if (reply.status === "refused") {
          reject(new RefusalError(reply.refusal));
          return;
        }
        resolve(reply.value);
      };
      const onAbandoned = (): void => {
        this.#listeners.delete(onSettled);
        reject(new RefusalError(abandonedReadRefusal()));
      };
      this.#listeners.add(onSettled);
      signal.addEventListener("abort", onAbandoned, { once: true });
      // A read already armed or in flight answers this caller too, and a request made mid-flight
      // would cost a second call. Otherwise it asks as a mounting view does: a new consumer.
      if (!this.#scheduler.isArmed) {
        this.#scheduler.request("subscribe");
      }
    });
  }

  /**
   * Takes the service's declarations on the round the scheduler opened. The signal goes to
   * `callDaemon` to stop an abandoned read before its reply is parsed; `settle` guards what
   * reaches the readout, so a replaced round installs nothing and its refusal is never published.
   */
  async #read(round: ReadRound): Promise<void> {
    // `callDaemon` collapses every way a read can fail (unsendable request, daemon rejection,
    // unaccepted reply) into a refusal with its code intact. A refused read declares nothing, which
    // is the fail-closed direction.
    const reply = await callDaemon(
      this.#bridge,
      "driver.listCapabilities",
      {},
      { signal: round.signal },
    );
    round.settle(() => {
      this.#settle(reply);
    });
  }

  #settle(reply: CapabilityReply): void {
    this.#readout = readoutOf(reply);
    for (const listener of this.#listeners) {
      listener(reply);
    }
  }
}

/** The flags each driver in a reply declared, or nothing and the refusal for a refused read. */
function readoutOf(reply: CapabilityReply): DriverCapabilityReadout {
  if (reply.status === "refused") {
    return refusedReadout(reply.refusal);
  }
  const flagsByDriverName = new Map<ProviderName, DeclaredDriverFlags>();
  for (const report of reply.value.drivers) {
    flagsByDriverName.set(report.driverName, report.capabilities.flags);
  }
  // A reply naming no driver settles with no entries and no refusal: the service declares nothing.
  return { flagsByDriverName, driverNameByRunId: NO_RUN_BINDINGS, readRefusal: undefined };
}

/** A reading that declares nothing, carrying the reason it declares nothing. */
function refusedReadout(readRefusal: Refusal): DriverCapabilityReadout {
  return {
    flagsByDriverName: NO_DECLARATIONS,
    driverNameByRunId: NO_RUN_BINDINGS,
    readRefusal,
  };
}

/**
 * The one reading per bridge. A `WeakMap` because the key is a live object: a closed window's
 * bridge is collectable and a test's fixture bridge cannot serve a later test its reply.
 */
class DriverCapabilityReadCache {
  readonly #readingByBridge = new WeakMap<PlatformBridge, BridgeCapabilityRead>();

  public reading(bridge: PlatformBridge, clock: Clock): BridgeCapabilityRead {
    const held = this.#readingByBridge.get(bridge);
    if (held !== undefined) {
      return held;
    }
    const created = new BridgeCapabilityRead(bridge, clock);
    this.#readingByBridge.set(bridge, created);
    return created;
  }
}

/** The window's one cache, keyed by bridge so a second window shares nothing. */
export const driverCapabilityReads: DriverCapabilityReadCache = new DriverCapabilityReadCache();
