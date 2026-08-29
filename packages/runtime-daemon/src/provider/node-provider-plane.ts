// Node provider plane — the runtime-node lifecycle binder for the provider
// subsystem (Plan-005 Phase 3, T3.12 / P2-9's sanctioned wiring call).
//
// The `CapabilityRefreshScheduler` is a lifecycle owner with two lifecycle
// verbs — `startForNode` on attach, `stopForNode` on detach — and nothing in
// the daemon was calling either. A poll nobody starts is a bounded cadence in
// name only: capability, CLI-floor, and auth state would stay at their
// attach-time readings for the whole node lifetime, so a post-attach logout
// would never surface and a mid-lifetime provider downgrade below the version
// floor would never be detected. This module is the missing call.
//
// It implements the neutral `RuntimeNodeLifecycleObserver` that
// `../node/node-registry.ts` publishes, which is what keeps the dependency
// one-directional: the node-lifecycle owner knows nothing about providers, and
// the provider plane knows about the lifecycle only through a two-method
// interface. The registry calls this class; this class never calls the
// registry.
//
// -- Provider-NEUTRAL by construction -------------------------------------
//
// Nothing here imports a driver module. That is not tidiness: the two driver
// trees deliberately stay import-independent of each other (see either
// `drivers/*/capabilities.ts`), and a binder that imported both to build their
// refresh entries would be the one file that couples them. It would also not
// work — their declaration entry points do not share a shape. Claude's is a
// METHOD on a reporter that closes over a spawned-version reader
// (`ClaudeCapabilityReporter.refreshDeclaration(sink, target)`); Codex's is a
// FREE FUNCTION taking a freshly-taken in-band version reading
// (`refreshCodexCapabilities(sink, { sessionId, nodeId, reading })`). Both also
// need a session-scoped declare target that only the caller has.
//
// So the composition helper below takes the narrowest common thunk — a zero-arg
// `refreshDeclaration` closure the caller builds from whichever entry point its
// driver has — and binds only the leg that IS uniform across drivers: the
// zero-turn `probeAuth()`, which `ProviderDriver` declares flaglessly for every
// driver. The bootstrap that eventually owns the object graph therefore makes
// one composition call per driver and hands the result to this plane.
//
// -- What the read surface is for ------------------------------------------
//
// `getAuthState` is the ADMISSION-side read. Run admission refuses a run whose
// driver is not probing `authenticated` — `driver.not_authenticated`, 409,
// fail-closed for `indeterminate` too — before any billed turn is spent. That
// admission seam is not built yet; when it is, it consumes THIS accessor rather
// than probing the provider itself, because a probe at admission time would
// spend a provider round trip per run and would answer a different question
// than the cadence's last reading did. An absent record (never polled, or the
// node's records dropped at detach) reads `undefined`, which admission treats
// as not-authenticated — the fail-closed direction.
//
// `shutdown` is here for the same reason: the daemon shutdown path gets ONE
// call on the plane rather than reaching through it for the scheduler.
//
// Refs: Plan-005 §Phase 3 / T3.12 (P2-9), `Spec-005 §Resolved Questions and V1
// Scope Decisions` (the bounded refresh cadence per runtime node),
// `Spec-005 §Required Behavior` (run admission against a driver not probing
// `authenticated`), `docs/architecture/contracts/error-contracts.md §Driver`.

import type { ProviderDriver } from "@ai-sidekicks/contracts";

import type {
  RuntimeNodeLifecycleContext,
  RuntimeNodeLifecycleObserver,
} from "../node/node-registry.js";

import type {
  CapabilityRefreshDriverEntry,
  CapabilityRefreshScheduler,
  DriverAuthStateRecord,
  FlooredDriverName,
} from "./capability-refresh.js";
import type { DeclareDriverCapabilitiesResult } from "./driver-capabilities-writer.js";

/**
 * The scheduler seam, structurally the real class narrowed to the four methods
 * this plane drives.
 *
 * A `Pick` of the concrete class rather than a hand-written port interface —
 * the same reasoning the driver capability modules record for their writer
 * seam: a mirror keeps compiling against a signature that has since moved,
 * while a `Pick` turns that drift into a compile error here. It also lets a
 * test drive this plane with a recording double without constructing a
 * scheduler and its required diagnostics emitter.
 */
export type NodeCapabilityRefreshScheduler = Pick<
  CapabilityRefreshScheduler,
  "startForNode" | "stopForNode" | "getAuthState" | "shutdown"
>;

export interface NodeProviderPlaneDependencies {
  readonly scheduler: NodeCapabilityRefreshScheduler;
  /**
   * The node's refresh entries, resolved AT ATTACH from the lifecycle context.
   *
   * A resolver rather than a fixed array because an entry is node-scoped in
   * substance, not just in key: its `refreshDeclaration` closes over the
   * session-scoped declare target the capability event is appended to. A
   * constant set of drivers is expressed as a closure ignoring its argument;
   * the reverse — recovering the session from a fixed array — is not
   * expressible at all.
   *
   * Deliberately NOT wrapped in a try/catch here: a resolver that throws is a
   * bootstrap wiring fault, and the registry's own observer containment already
   * keeps that fault from failing the registration while reporting it. Catching
   * it a second time here would start a node with an empty driver set, which
   * looks exactly like a healthy node whose polls find nothing to do.
   */
  readonly resolveDriverEntries: (
    context: RuntimeNodeLifecycleContext,
  ) => readonly CapabilityRefreshDriverEntry[];
}

/**
 * Binds runtime-node attach/detach to the capability-refresh cadence, and
 * exposes the plane's admission-side auth read.
 *
 * `implements RuntimeNodeLifecycleObserver` is load-bearing rather than
 * decorative: the registry accepts any structurally-matching object, so the
 * explicit clause is what makes a drift in the observer contract a compile
 * error in THIS file rather than a silently-unregistered subscriber.
 */
export class NodeProviderPlane implements RuntimeNodeLifecycleObserver {
  readonly #scheduler: NodeCapabilityRefreshScheduler;
  readonly #resolveDriverEntries: (
    context: RuntimeNodeLifecycleContext,
  ) => readonly CapabilityRefreshDriverEntry[];

  constructor(dependencies: NodeProviderPlaneDependencies) {
    this.#scheduler = dependencies.scheduler;
    this.#resolveDriverEntries = dependencies.resolveDriverEntries;
  }

  /**
   * Attach: start this node's bounded refresh cadence.
   *
   * `startForNode` is idempotent per node (a re-attach replaces the previous
   * timer rather than stacking a second one), so a duplicate registration
   * notification cannot double the poll rate.
   */
  onNodeRegistered(context: RuntimeNodeLifecycleContext): void {
    this.#scheduler.startForNode({
      nodeId: context.nodeId,
      drivers: this.#resolveDriverEntries(context),
    });
  }

  /**
   * Detach: stop the cadence and drop the node's auth records.
   *
   * Dropping the records is the scheduler's detach semantics and is why this
   * call is not optional — a retained `authenticated` reading would let a
   * later admission decision rest on credentials probed under a node
   * registration that no longer exists.
   */
  onNodeDetached(context: RuntimeNodeLifecycleContext): void {
    this.#scheduler.stopForNode(context.nodeId);
  }

  /**
   * The admission-side read of one driver's latest probe result on one node.
   *
   * Signature mirrors the scheduler's exactly, `driverName: string` included:
   * narrowing it to the floored driver union here would refuse a lookup the
   * scheduler itself would answer, and admission arrives holding whatever
   * driver id the run named.
   */
  getAuthState(nodeId: string, driverName: string): DriverAuthStateRecord | undefined {
    return this.#scheduler.getAuthState(nodeId, driverName);
  }

  /** Daemon shutdown: clear every node's timer (no timer leaks). */
  shutdown(): void {
    this.#scheduler.shutdown();
  }
}

/**
 * What one driver contributes to a node's refresh entry.
 *
 * `driver` is the registered `ProviderDriver`, narrowed to the one operation
 * this composition binds — a `Pick` for the same drift-detection reason as the
 * scheduler seam above, and narrowed because a plane that held the whole driver
 * would invite a second call path into it.
 */
export interface CapabilityRefreshEntryComposition {
  /** Canonical driver id — the scheduler's auth-record key. */
  readonly driverName: FlooredDriverName;
  readonly driver: Pick<ProviderDriver, "probeAuth">;
  /**
   * The caller-built re-declaration thunk, already bound to its write sink and
   * its session-scoped target. Supplied as a closure because the two drivers'
   * declaration entry points share no signature — see the module header.
   */
  readonly refreshDeclaration: () => Promise<DeclareDriverCapabilitiesResult>;
}

/**
 * Compose one `CapabilityRefreshDriverEntry` — the single call a bootstrap
 * makes per driver per node.
 *
 * The probe leg is wrapped in an arrow rather than passed as
 * `composition.driver.probeAuth`: an unbound method reference loses its `this`
 * and every driver implementation is a class holding transport state.
 */
export function composeCapabilityRefreshDriverEntry(
  composition: CapabilityRefreshEntryComposition,
): CapabilityRefreshDriverEntry {
  return {
    driverName: composition.driverName,
    refreshDeclaration: composition.refreshDeclaration,
    probeAuth: () => composition.driver.probeAuth(),
  };
}
