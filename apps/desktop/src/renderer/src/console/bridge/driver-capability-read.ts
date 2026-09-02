// What each bound driver DECLARED, read once per bridge and shared by every family.
//
// `driver.listCapabilities` answers with one report per driver, each naming itself,
// and it is addressed at the node rather than at a run or a session — so the answer
// is a property of the bridge and not of the surface that asked. Two families need
// it: the runs pane gates Rewind and Steer on it, and the composer's accessory rail
// gates the compaction control on it. Neither may import the other, and a hook
// living in either one would make the other's copy a second read of one wire.
//
// SO THE READ LIVES HERE, AND IT IS PERFORMED ONCE. Both families had their own
// hook, and a session view holding both surfaces put two `driver.listCapabilities`
// calls on the wire for one answer. The cache below is keyed by the bridge and is a
// `WeakMap`, so a window that closes takes its entry with it and a test's fixture
// bridge is never the next test's cached reply.
//
// RETAINED BY DRIVER, NEVER FOLDED. A session may hold runs on more than one driver,
// and an intersection across the reports answers a question nobody asks — "do ALL
// drivers here declare this?" — whose `false` hides a capable driver's control
// because some other driver in the session lacks the flag. The consumers resolve
// their own binding against this readout; this module supplies the readings and
// decides nothing about which control is offered.
//
// FAIL-CLOSED, AND ABSENT IS NOT `false`. An unread, unparseable, or rejected reply
// leaves the readout ABSENT, which every consumer renders as the control being off
// screen — a different fact from a driver having declared the flag absent, and never
// reported as one. The failure raises no banner: no control was pressed, and a
// refusal card for a read nobody asked for is the console reporting its own
// housekeeping.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { ListCapabilitiesResultSchema, type DriverCapabilityFlag } from "@ai-sidekicks/contracts";

import { DRIVER_LIST_CAPABILITIES_METHOD, callDaemon } from "./daemon-calls.js";
import type { ConsoleBridge } from "./console-bridge.js";

/** One driver's declared flags, exactly as its own report carried them. */
export type DeclaredDriverFlags = Readonly<Record<DriverCapabilityFlag, boolean>>;

/** What the capability read answered. Absent until the read answers. */
export interface DriverCapabilityReadout {
  /**
   * One entry per reported driver, keyed by the reply's own `driverName`.
   *
   * Retained, never folded: the reports are separate declarations by separate
   * drivers, and any collapse of them is an answer to a question the surface does
   * not ask.
   */
  readonly flagsByDriverName: ReadonlyMap<string, DeclaredDriverFlags>;
  /**
   * Which driver each run is bound to, for every run a read has named a binding for.
   *
   * Empty today: nothing client-readable pairs a run with its driver on a run-scoped
   * shape. It is a map rather than a derivation so that the read which lands it
   * changes one producer and no consumer.
   */
  readonly driverNameByRunId: ReadonlyMap<string, string>;
}

/** No run has a named binding yet. Frozen so no caller writes one in place. */
const NO_RUN_BINDINGS: ReadonlyMap<string, string> = new Map<string, string>();

/** One bridge's reading, and everyone waiting on it. */
interface CapabilityReadEntry {
  /** The settled readout, or `undefined` while the read is outstanding or failed. */
  readout: DriverCapabilityReadout | undefined;
  /** Whether the one call has been placed. Set before the await, never cleared. */
  hasAsked: boolean;
  readonly listeners: Set<() => void>;
}

/**
 * The one read per bridge, and everything that shares it.
 *
 * A class with private fields rather than module-level maps, per this package's
 * structure rules — and a `WeakMap` rather than a `Map` because the key is a live
 * object: an entry outlives nothing, a closed window's bridge is collectable, and a
 * test's fixture bridge cannot serve a later test its reply.
 */
class DriverCapabilityReadCache {
  readonly #entriesByBridge = new WeakMap<ConsoleBridge, CapabilityReadEntry>();

  /** The settled readout for one bridge, or `undefined`. Stable between changes. */
  public snapshot(bridge: ConsoleBridge): DriverCapabilityReadout | undefined {
    return this.#entriesByBridge.get(bridge)?.readout;
  }

  /** Watch one bridge's reading. */
  public subscribe(bridge: ConsoleBridge, listener: () => void): () => void {
    const entry = this.#entryFor(bridge);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }

  /**
   * Place the read if nobody has.
   *
   * Idempotent on `hasAsked` rather than on the readout, so a read that failed or
   * answered with no driver is still one read: retrying on every mount would put a
   * call on the wire for each surface, which is the state this cache exists to end.
   */
  public ask(bridge: ConsoleBridge): void {
    const entry = this.#entryFor(bridge);
    if (entry.hasAsked) {
      return;
    }
    entry.hasAsked = true;
    void callDaemon(bridge, DRIVER_LIST_CAPABILITIES_METHOD, {})
      .then((reply) => {
        const parsed = ListCapabilitiesResultSchema.safeParse(reply);
        if (!parsed.success || parsed.data.drivers.length === 0) {
          // A reply the registered schema will not accept, and a reply naming no
          // driver, are both readings this console cannot resolve a binding out of.
          // Leaving the readout absent is the fail-closed direction for both.
          return;
        }
        const flagsByDriverName = new Map<string, DeclaredDriverFlags>();
        for (const report of parsed.data.drivers) {
          flagsByDriverName.set(report.driverName, report.capabilities.flags);
        }
        this.#settle(entry, { flagsByDriverName, driverNameByRunId: NO_RUN_BINDINGS });
      })
      .catch(() => {
        // See the header: a failed capability read is an absent readout, not a
        // refusal card for housekeeping nobody asked for.
      });
  }

  #entryFor(bridge: ConsoleBridge): CapabilityReadEntry {
    const existing = this.#entriesByBridge.get(bridge);
    if (existing !== undefined) {
      return existing;
    }
    const created: CapabilityReadEntry = {
      readout: undefined,
      hasAsked: false,
      listeners: new Set(),
    };
    this.#entriesByBridge.set(bridge, created);
    return created;
  }

  #settle(entry: CapabilityReadEntry, readout: DriverCapabilityReadout): void {
    entry.readout = readout;
    for (const listener of entry.listeners) {
      listener();
    }
  }
}

/** The window's one cache. Keyed by bridge, so a second window shares nothing. */
const driverCapabilityReads = new DriverCapabilityReadCache();

/**
 * Read the bound drivers' declared capability flags.
 *
 * Every consumer on one bridge is served by one call. The snapshot is the stored
 * readout object, so `useSyncExternalStore` compares a pointer and a surface that
 * asked second re-renders once, when the answer lands, and never on a poll.
 */
export function useDriverCapabilities(bridge: ConsoleBridge): DriverCapabilityReadout | undefined {
  const subscribe = useCallback(
    (onReadoutChanged: () => void) => driverCapabilityReads.subscribe(bridge, onReadoutChanged),
    [bridge],
  );
  const readSnapshot = useCallback(() => driverCapabilityReads.snapshot(bridge), [bridge]);
  useEffect(() => {
    // In an effect and not in the render body: a render React discards would
    // otherwise put a call on the wire for a surface nobody ever saw.
    driverCapabilityReads.ask(bridge);
  }, [bridge]);
  return useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
}

/**
 * One named driver's declared flags, or `undefined` where the console cannot say.
 *
 * `undefined` covers three genuinely identical situations — the read has not
 * answered, the caller could not name the driver, and the reply named no such driver
 * — because in all three nobody has answered the question for THIS binding.
 */
export function declaredFlagsForDriver(
  readout: DriverCapabilityReadout | undefined,
  driverName: string | undefined,
): DeclaredDriverFlags | undefined {
  if (readout === undefined || driverName === undefined) {
    return undefined;
  }
  return readout.flagsByDriverName.get(driverName);
}
