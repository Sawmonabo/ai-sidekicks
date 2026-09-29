// What each bound driver DECLARED, read once per bridge and shared by every surface.
//
// `driver.listCapabilities` answers with one report per driver, each naming itself, and it is
// addressed at the node rather than at a run or a session, so the answer is a property of the
// bridge and not of the surface that asked. The runs controls gate Rewind and Steer on it and
// the composer gates the compaction control on it; a read held by either would make the
// other's copy a second read of one wire.
//
// SO THE READ LIVES HERE, AND IT IS PERFORMED ONCE. The cache below is keyed by the bridge and
// is a `WeakMap`, so a window that closes takes its entry with it and a test's fixture bridge
// is never the next test's cached reply. `useDriverCapabilities` and
// `useDriverCapabilityRepairRead` beside it are the two entry points.
//
// A FAILED READ IS SAID OUT LOUD. A rejection and an unreadable reply both SETTLE, carrying
// the daemon's own refusal on the readout for the surfaces to render: the flags stay absent,
// which keeps the gating fail-closed, and the reason travels with them. A reply naming NO
// driver is not a refusal: it is an answered read whose answer is that this node has no driver
// to declare anything.
//
// AND NO SETTLEMENT IS TERMINAL FOR A BRIDGE. One read serves every surface, and refresh goes
// through `lib/reads/refresh-scheduler.ts`'s `RefreshScheduler` on exactly the three admitted
// refresh reasons: subscribe, window focus, and reconnect. There is no interval and no retry
// loop; a refusal is re-asked at the next reason. A settled readout stays on screen while the
// next read is in flight, because the not-loaded state is entered once and never re-entered on
// a refresh: a control that vanished and came back on every window focus would be a worse
// reading than a slightly stale one.

import type { Refusal } from "@renderer/lib/refusal.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  type ReadTriggerTarget,
} from "@renderer/store/reads/read-triggers.js";
import { RefreshScheduler, type RefreshReason } from "@renderer/lib/reads/refresh-scheduler.js";
import { type ReadRound } from "@renderer/lib/reads/read-scope.js";
import type {
  DeclaredDriverFlags,
  DriverCapabilityReadout,
} from "@renderer/store/driver-capabilities/driver-capability-readout.js";
import { callDaemon } from "../daemon/daemon-reply.js";
import { resolveBridgeClock } from "../platform/hooks/useClock.js";
import { type ConsoleBridge } from "../platform/platform-bridge.js";

/** No run has a named binding yet. Frozen so no caller writes one in place. */
const NO_RUN_BINDINGS: ReadonlyMap<string, string> = new Map<string, string>();

/** The declarations a failed read carries: none. */
const NO_DECLARATIONS: ReadonlyMap<string, DeclaredDriverFlags> = new Map<
  string,
  DeclaredDriverFlags
>();

/**
 * One bridge's reading, everyone waiting on it, and the scheduler that refreshes it.
 *
 * A class with private fields rather than a mutable record, because the three are
 * one invariant: the readout is what the scheduler's last completed read settled,
 * the listeners are told exactly when that happens, and the scheduler is the only
 * thing that may put a call on the wire. A caller that could move one without the
 * others is how a latch gets reintroduced.
 */
class BridgeCapabilityRead implements ReadTriggerTarget {
  /**
   * Nothing in a session's timeline says this node's declarations changed.
   *
   * A driver declares its capabilities at the node, and the events a session
   * appends are about that session's runs — so the empty set here is a claim and
   * not an omission: this reading goes stale when the window has been away or the
   * connection was repaired, and never because a run ended.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = NO_TRIGGERING_EVENT_KINDS;
  readonly #bridge: ConsoleBridge;
  readonly #scheduler: RefreshScheduler;
  readonly #listeners = new Set<() => void>();
  #readout: DriverCapabilityReadout | undefined;

  public constructor(bridge: ConsoleBridge) {
    this.#bridge = bridge;
    this.#scheduler = new RefreshScheduler({
      // The fixture's frozen clock wherever a scenario is playing and the real one
      // otherwise, resolved once per bridge — the frozen clock is the only clock the
      // renderer reads in fixture mode.
      clock: resolveBridgeClock(bridge),
      perform: async (_reasons, round) => {
        await this.#read(round);
      },
      // A read that fails is already recorded as the readout's own refusal, so
      // re-throwing here would surface the same fact a second time as an unhandled
      // rejection.
      onError: () => undefined,
    });
  }

  /** The settled readout, or `undefined` until the first read answers. */
  public get readout(): DriverCapabilityReadout | undefined {
    return this.#readout;
  }

  /**
   * Ask for a read.
   *
   * Coalesced by the scheduler, so the four surfaces that mount together on one
   * session still cost one call — which is the property the old latch was reaching
   * for, obtained without making the answer permanent.
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
   * Take the node's declarations, on the round the scheduler opened for this read.
   *
   * BOTH HALVES OF THE ROUND ARE USED AND THEY ANSWER DIFFERENT QUESTIONS. The signal
   * goes to the call door, where it stops an abandoned read before its reply is
   * parsed; `settle` guards what reaches the readout, so a round this line has already
   * replaced installs nothing and wakes no watcher. Publishing an abandoned read's
   * refusal would be the worse failure of the two — every surface holding this reading
   * would render "nothing is waiting for it" as though the node had refused.
   */
  async #read(round: ReadRound): Promise<void> {
    // One branch, because the door has already collapsed the three ways a read can
    // fail into one: a request the registry would not admit, a rejection carrying the
    // daemon's own code, and a reply the registered shape does not accept all arrive
    // as a refusal with its code intact. A refused read declares NOTHING — the flags
    // stay absent, which is the fail-closed direction — and carries why.
    const reply = await callDaemon(
      this.#bridge,
      "driver.listCapabilities",
      {},
      { signal: round.signal },
    );
    if (reply.status === "refused") {
      round.settle(() => {
        this.#settle(refusedReadout(reply.refusal));
      });
      return;
    }
    const flagsByDriverName = new Map<string, DeclaredDriverFlags>();
    for (const report of reply.value.drivers) {
      flagsByDriverName.set(report.driverName, report.capabilities.flags);
    }
    // A reply naming no driver settles with no entries and no refusal: nothing
    // failed, and this node declares nothing.
    round.settle(() => {
      this.#settle({
        flagsByDriverName,
        driverNameByRunId: NO_RUN_BINDINGS,
        readRefusal: undefined,
      });
    });
  }

  #settle(readout: DriverCapabilityReadout): void {
    this.#readout = readout;
    for (const listener of this.#listeners) {
      listener();
    }
  }
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
 * The one reading per bridge, and everything that shares it.
 *
 * A class with a private field rather than a module-level map, per this package's
 * structure rules — and a `WeakMap` rather than a `Map` because the key is a live
 * object: an entry outlives nothing, a closed window's bridge is collectable, and a
 * test's fixture bridge cannot serve a later test its reply.
 */
class DriverCapabilityReadCache {
  readonly #readingByBridge = new WeakMap<ConsoleBridge, BridgeCapabilityRead>();

  public reading(bridge: ConsoleBridge): BridgeCapabilityRead {
    const held = this.#readingByBridge.get(bridge);
    if (held !== undefined) {
      return held;
    }
    const created = new BridgeCapabilityRead(bridge);
    this.#readingByBridge.set(bridge, created);
    return created;
  }
}

/** The window's one cache. Keyed by bridge, so a second window shares nothing. */
export const driverCapabilityReads: DriverCapabilityReadCache = new DriverCapabilityReadCache();
