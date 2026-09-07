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
// AND THE RESOLVING IS NEXT DOOR. `driver-capability-readings.ts` owns every pure
// question a surface asks of a readout — which driver a run is bound to, and what
// this build knows about one flag on it. It takes the readout as a parameter and this
// module does not import it, so the wire and the questions asked of its answer stay
// two subjects: one needs a bridge, a frozen clock, and a mounted probe to drive, and
// the other needs a `Map`.
//
// FAIL-CLOSED, AND ABSENT IS NOT `false`. No declaration for a driver leaves every
// control this readout gates off screen — a different fact from a driver having
// declared the flag absent, and never reported as one. `declaredFlagsForDriver`
// answers `undefined` on every such path and no consumer changes its gating.
//
// A FAILED READ IS SAID OUT LOUD. The read used to end in an empty `catch`, and the
// consequence was a session view whose Rewind, Steer, and compaction controls were
// simply not there, with nothing anywhere saying why — indistinguishable, to the
// person looking at it, from a session where no driver declares them. So a rejection
// and an unreadable reply both SETTLE, carrying the daemon's own refusal on the
// readout for the surfaces to render: the flags stay absent, which is what keeps the
// gating fail-closed, and the reason travels with them.
//
// A reply naming NO driver is deliberately not a refusal. It is an answered read
// whose answer is that this node has no driver to declare anything, which is a fact
// and not a failure.
//
// AND NO SETTLEMENT IS TERMINAL FOR A BRIDGE. The read used to be latched: one call
// was placed per bridge and the answer, whatever it was, stood for the life of the
// window. A single transient refusal therefore hid Steer, Rewind, and the compaction
// control until the window was closed and reopened, and a report that was true when
// it landed went on gating controls after a driver was installed, upgraded, or
// removed. So the entry is retained per bridge — one read still serves every family
// — and refresh goes through `store/scheduling.ts`'s `RefreshScheduler`, on exactly
// the reasons `Spec-023 §Rules every console surface obeys` names: subscribe, window
// focus, and reconnect. There is no interval and no retry loop; a refusal is simply
// re-asked at the next reason, like every other read in this console.
//
// WHAT THE REFRESH DOES NOT DO IS RE-ENTER AN ABSENCE. A settled readout stays on
// screen while the next read is in flight, because rule 8's `not-loaded` is entered
// once and never re-entered on a refresh — a control that vanished and came back on
// every window focus would be a worse reading than a slightly stale one.
//
// THE RECONNECT REASON IS A SESSION'S, AND THIS READ IS A NODE'S. Nothing on this
// bridge carries a connection state to watch, so `useDriverCapabilityRepairRead`
// below is a second, deliberately separate entry point for a caller that HOLDS a
// session: the session store's degraded flag clearing is the console's one honest
// reading of "the daemon went away and came back", and that is exactly the transient
// that leaves a stale or refused capability set standing.

import { useCallback, useSyncExternalStore } from "react";
import type { DriverCapabilityFlag } from "@ai-sidekicks/contracts";

import type { ConsoleRefusal } from "../../core/index.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  RefreshScheduler,
  useSessionReadTriggers,
  useWindowReadTriggers,
  type ReadRound,
  type ReadTriggerTarget,
  type RefreshReason,
  type SessionStore,
} from "../../store/index.js";
import { callDaemon } from "../daemon/daemon-reply.js";
import { consoleClockFor, type ConsoleBridge } from "../console-bridge.js";

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
   * Which driver each run is bound to, for every run whose binding is nameable.
   *
   * NOT what `driver.listCapabilities` answers, and it never could be: that read is
   * addressed at the NODE and names no run. This member is joined on by the consumer
   * through `withRunDriverBindings` below, from the session's own projection —
   * `run-driver-binding.ts` owns the join and says where each half comes from. It is
   * empty on the readout the bridge settles, which is the honest reading of a
   * node-scoped answer: that read named no run because it names none.
   */
  readonly driverNameByRunId: ReadonlyMap<string, string>;
  /**
   * Why the declarations could not be read, where they could not be.
   *
   * Present exactly on the two failing terminals — the daemon rejected the read, or
   * answered something the registered schema will not accept. A surface whose
   * controls this readout gates renders it, so a control that is missing because
   * nobody could ask says so rather than looking like a control nothing declares.
   */
  readonly readRefusal: ConsoleRefusal | undefined;
}

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
      // otherwise, resolved once per bridge — §The fixture bridge makes the frozen
      // clock the only clock the renderer reads in fixture mode.
      clock: consoleClockFor(bridge),
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
function refusedReadout(readRefusal: ConsoleRefusal): DriverCapabilityReadout {
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
const driverCapabilityReads = new DriverCapabilityReadCache();

/**
 * Read the bound drivers' declared capability flags.
 *
 * Every consumer on one bridge is served by one reading. The snapshot is the stored
 * readout object, so `useSyncExternalStore` compares a pointer and a surface that
 * asked second re-renders once, when the answer lands, and never on a poll.
 *
 * The two window-scoped refresh reasons are wired here, because both are properties
 * of this window rather than of a session: a surface mounting is `subscribe`, and
 * the window regaining focus is `window-focus`. The session-scoped one is
 * `useDriverCapabilityRepairRead` below. Neither is wired in this module any more —
 * both are the console's one trigger set, so a reading added later cannot ship with
 * a subset of it.
 */
export function useDriverCapabilities(bridge: ConsoleBridge): DriverCapabilityReadout | undefined {
  const reading = driverCapabilityReads.reading(bridge);
  const subscribe = useCallback(
    (onReadoutChanged: () => void) => reading.watch(onReadoutChanged),
    [reading],
  );
  const readSnapshot = useCallback(() => reading.readout, [reading]);
  useWindowReadTriggers(reading);

  return useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
}

/**
 * Re-read this node's declarations when a session's stream is repaired.
 *
 * Separate from the hook above, and deliberately so: `driver.listCapabilities` is
 * addressed at the NODE, and a node-scoped read has no connection state of its own
 * to watch. What the console has is the session store's sticky degraded flag, whose
 * CLEARING says a stream stopped and a completed re-pull has since re-established
 * it — the nearest honest reading of a daemon that went away and came back, which is
 * exactly the transient that leaves a refused or stale capability set standing.
 *
 * A caller that holds a session calls this beside `useDriverCapabilities`; one that
 * does not still re-reads on mount and on focus.
 */
export function useDriverCapabilityRepairRead(
  bridge: ConsoleBridge,
  sessionStore: SessionStore,
): void {
  // The session half alone, deliberately: the window half is already wired by
  // `useDriverCapabilities`, which every caller of this hook also calls, and wiring
  // it twice would put two focus listeners on one window for one reading.
  useSessionReadTriggers(driverCapabilityReads.reading(bridge), sessionStore);
}
