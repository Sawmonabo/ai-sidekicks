// The `driver.*` JSON-RPC handlers — Plan-005 Phase 4, T4.1.
//
// Seven client-facing methods, bound onto Plan-007's `MethodRegistry` and
// dispatched into the IN-DAEMON `ProviderRegistry` (T2.3). That dispatch target
// is the point rather than an implementation detail: I-005-1 holds driver
// authority LOCAL even when the provider endpoint is remote, so every handler
// here resolves a driver instance from the local registry and calls it in this
// process. Nothing in this module can express "execute via the control plane",
// which is how the invariant survives contact with a wire surface.
//
// WHY SEVEN AND NOT ELEVEN. `ProviderDriver` carries eighteen operations. Four
// of them — `createSession`, `resumeSession`, `startRun`, `closeSession` — are
// daemon-internal by Plan-005 §Phase 4 decision #2 and are registered NOWHERE:
// they establish, restore, start, or tear down a session-or-run domain object,
// which is orchestration's job, and a client reaching them directly would let a
// caller mint runtime state behind the orchestrator's back. Their absence from
// this file is the enforcement — there is no schema for them at the SDK seam and
// no `register` call here, so a client that guessed the method name gets
// `method_not_found` from the registry substrate. T4.9's two console-parity
// verbs (`driver.compactContext`, `driver.listProviderCommands`) extend THIS
// module when they land; they are deliberately not a second handler file.
//
// THE THREE READS ARE NO-ARG AND REPLY PER DRIVER. `driver.listCapabilities`,
// `driver.listModels`, and `driver.listModes` take an empty request — the
// ratified `DriverClient` signature (Plan-005 §Phase 4, T4.3) writes them
// without a parameter while the three run-addressed verbs take one — and answer
// with a GROUP LIST keyed by driver name. A flat merged array would hand a
// caller one arbitrary driver's models with the provenance stripped, and model
// ids collide across providers with no vendor marker to recover it from. The
// rosters are sorted by driver name so the reply is stable across daemon
// restarts, which a renderer that keys list items on position depends on.
//
// THE THREE RUN VERBS ARE RUN-ADDRESSED, AND RESOLUTION IS INJECTED. A run id is
// globally unique, so the wire shapes carry no session selector — a second
// addressing key would have no honest answer when the two disagreed. Turning a
// run id into a driver is a LIVENESS judgement (`runtime_bindings` is 1:many per
// run and retains superseded pre-relaunch rows), and `RuntimeBindingStore`
// deliberately owns no liveness column so that the judgement is made in exactly
// one place. This module therefore takes `resolveDriverForRun` as an injected
// dependency rather than reaching for `findByRun` and picking the newest row —
// picking here would be a wire handler inventing a second definition of "live",
// which is precisely what that store's contract warns against.
//
// ERROR TRANSLATION HAPPENS HERE, AT THE WIRE BOUNDARY. `ProviderRegistry`
// throws `DriverUnavailableError` / `DriverCapabilityUnsupportedError`, both
// plain `Error` subclasses carrying a registered `code` and structured `fields`.
// `mapJsonRpcError` has no branch for either, so left untranslated they would
// reach a client as a bare `-32603` with no `data.type` — indistinguishable from
// a daemon crash. Translating them into `DaemonDomainError` at this seam gives
// them their registered wire projection through the mapper's single generic
// branch WITHOUT editing the shipped provider-layer classes and WITHOUT minting
// a numeric code: the provider layer keeps speaking its own typed errors, and
// the IPC layer owns the projection, which is the layering the rest of the
// daemon already uses.
//
// Every code this module can raise is already registered in
// `docs/architecture/contracts/error-contracts.md` — `driver.unavailable` (503),
// `driver.capability_unsupported` (400), and `run.not_found` (404). Nothing new
// is minted; the driver namespace stays closed at its seven codes.
//
// Invariants this module participates in (canonical text in
// `docs/plans/007-local-ipc-and-daemon-control.md §Invariants`):
//   * I-007-6 — duplicate registration is rejected at register-time by the
//     registry, so binding this namespace twice fails loudly at bootstrap.
//   * I-007-7 — schema-validates-before-dispatch. The registry `safeParse`s the
//     request against the T4.2 SDK-seam schema before a handler body runs, and
//     `safeParse`s the result before it reaches the wire.
//   * I-007-8 — sanitized error mapping; see the translation note above.
//   * I-007-9 — dotted-camelCase method names; all seven match the canonical
//     regex.
//   * I-007-10 — the subscribe-init response precedes the first notify frame.
//     `driver.subscribeEvents` inherits the `session.subscribe` replay-buffer +
//     `setImmediate` construction wholesale; see that file for the full
//     derivation of why a `queueMicrotask` boundary is not sufficient.
//
// Mutating flags: `false` on the three reads and on `subscribeEvents` (opening a
// subscription allocates per-connection IPC state but mutates no domain row);
// `true` on `interruptRun`, `applyIntervention`, and `respondToRequest`, each of
// which drives a live run. The flag gates the pre-handshake path, so a
// version-mismatched connection keeps read-only access and loses exactly the
// three verbs that change something.
//
// Refs: Plan-005 §Phase 4 / T4.1, `Spec-005 §Capability discovery`,
// `Spec-005 §Interfaces And Contracts`, invariants I-005-1 / I-005-2,
// CP-007-6 (the `driver.*` namespace registered against Plan-007's registry),
// `docs/architecture/contracts/error-contracts.md §Driver` + §Run.

import type {
  ApplyInterventionParams,
  DriverAckResult,
  DriverCapabilityReport,
  DriverInterventionResult,
  DriverModeReport,
  DriverModelReport,
  DriverReadParams,
  DriverSubscribeEventsParams,
  Handler,
  InterruptRunParams,
  ListCapabilitiesResult,
  ListModelsResult,
  ListModesResult,
  MethodRegistry,
  ProviderDriver,
  RespondToRequestParams,
  RunId,
  SessionEvent,
  SessionEventType,
  SubscribeAckResponse,
} from "@ai-sidekicks/contracts";
import {
  ApplyInterventionParamsSchema,
  ARTIFACT_PUBLICATION_EVENT_TYPES,
  ASSISTANT_OUTPUT_EVENT_TYPES,
  DriverAckResultSchema,
  DriverInterventionResultSchema,
  DriverReadParamsSchema,
  DriverSubscribeEventsParamsSchema,
  INTERACTIVE_REQUEST_EVENT_TYPES,
  InterruptRunParamsSchema,
  JsonRpcErrorCode,
  ListCapabilitiesResultSchema,
  ListModelsResultSchema,
  ListModesResultSchema,
  RespondToRequestParamsSchema,
  RUN_LIFECYCLE_EVENT_TYPES,
  RUNTIME_NODE_LIFECYCLE_EVENT_TYPES,
  SessionEventSchema,
  SubscribeAckResponseSchema,
  TOOL_ACTIVITY_EVENT_TYPES,
  USAGE_TELEMETRY_EVENT_TYPES,
} from "@ai-sidekicks/contracts";

import type { DriverCapabilityCache } from "../../provider/capability-cache.js";
import {
  DriverCapabilityUnsupportedError,
  DriverUnavailableError,
  type ProviderRegistry,
} from "../../provider/provider-registry.js";
import { DaemonDomainError } from "../domain-error.js";
import type { StreamingPrimitive } from "../streaming-primitive.js";

// --------------------------------------------------------------------------
// Dependency contracts
// --------------------------------------------------------------------------

/**
 * The registry surface a roster read needs. `Pick`ed rather than typed as the
 * whole class so a test double is the two methods it actually calls — and so a
 * handler cannot quietly start using `checkCapability`, which belongs to the
 * pre-dispatch gate and not to a read.
 */
type DriverRosterSource = Pick<ProviderRegistry, "listAvailable" | "lookup">;

/** Dependencies for `driver.listCapabilities`. */
export interface DriverListCapabilitiesDeps {
  /** Enumerates the drivers this node has loaded; the reply's roster. */
  readonly providerRegistry: Pick<ProviderRegistry, "listAvailable">;
  /**
   * The T4.5 read-side cache. `read` serves one driver's client-facing report
   * from memory (or from ONE durable read on a miss) and never round-trips a
   * driver process — which is what makes this method cheap enough for a renderer
   * to call whenever it needs to know which controls to offer.
   */
  readonly capabilityCache: Pick<DriverCapabilityCache, "read">;
}

/** Dependencies for `driver.listModels` and `driver.listModes`. */
export interface DriverCatalogDeps {
  readonly providerRegistry: DriverRosterSource;
}

/**
 * Dependencies for the three run-addressed verbs.
 *
 * `resolveDriverForRun` is the liveness seam. It answers "which driver is
 * currently bound to this run", returning `undefined` when the run is unknown or
 * holds no live binding, and its implementor — the bootstrap orchestrator's
 * session engine, which owns the liveness judgement — is deliberately outside
 * this module. See the file header for why a handler must not make that
 * judgement itself.
 */
export interface DriverDispatchDeps {
  readonly providerRegistry: Pick<ProviderRegistry, "lookup">;
  readonly resolveDriverForRun: (runId: RunId) => string | undefined;
}

/** Dependencies for `driver.subscribeEvents`. */
export interface DriverSubscribeEventsDeps {
  /**
   * The Phase-2 streaming primitive the orchestrator constructed, shared with
   * every other streaming handler so the per-transport reverse-index that
   * `cleanupTransport` walks stays unified.
   */
  readonly streamingPrimitive: StreamingPrimitive;
  /**
   * The upstream driver event source for one run. Returns an unsubscribe handle,
   * which the handler registers via `sub.onCancel` so wire-cancel,
   * transport-disconnect, and internal teardown all detach it.
   *
   * Domain-side setup failures (unknown run, no live binding) MUST throw
   * SYNCHRONOUSLY — the handler's atomicity guard cancels the allocated
   * subscription on a synchronous throw, and a rejection delivered later would
   * orphan the streaming-primitive entry until transport cleanup.
   */
  readonly subscribeToDriverEvents: (
    runId: RunId,
    onEvent: (event: SessionEvent) => void,
  ) => () => void;
}

// --------------------------------------------------------------------------
// The driver event set
// --------------------------------------------------------------------------

// Plan-005 §Phase 4 decision #4 defines `DriverEvent` as the union of seven
// EXISTING event-category types. The union type itself is Plan-006-owned, so
// this module deliberately does not author the name — it derives the SET from
// the per-category arrays that plan already exports, and keeps it module-local
// and unexported.
//
// Derivation rather than a literal list, for the reason every derived set in
// this codebase is derived: a category that grows a new event type joins this
// filter automatically, where a hand-written list would silently start dropping
// a driver event from the stream and look correct while doing it.
//
// The filter is what makes this a stream of DRIVER events rather than of
// whatever the injected source happens to emit. Without it a source wired to a
// session-wide event feed would push approvals, memberships, and audit rows onto
// a subscription a client opened for one run's driver activity — and because
// each of those parses cleanly against `SessionEventSchema`, nothing downstream
// would notice.
const DRIVER_EVENT_TYPES: ReadonlySet<SessionEventType> = new Set<SessionEventType>([
  ...RUN_LIFECYCLE_EVENT_TYPES,
  ...ASSISTANT_OUTPUT_EVENT_TYPES,
  ...TOOL_ACTIVITY_EVENT_TYPES,
  ...INTERACTIVE_REQUEST_EVENT_TYPES,
  ...ARTIFACT_PUBLICATION_EVENT_TYPES,
  ...USAGE_TELEMETRY_EVENT_TYPES,
  ...RUNTIME_NODE_LIFECYCLE_EVENT_TYPES,
]);

// --------------------------------------------------------------------------
// Error translation
// --------------------------------------------------------------------------

/**
 * Project a provider-layer typed error onto its registered wire code, or rethrow
 * anything else untouched.
 *
 * Always throws — the `never` return is what lets a call site write
 * `catch (thrown) { translateDriverError(thrown); }` without the compiler
 * demanding a return after it.
 *
 * The `httpStatus` values mirror the error-contracts table exactly (503 / 400)
 * and are carried for control-plane and observability symmetry; the JSON-RPC
 * seam reads `jsonRpcCode`, not this. `InvalidRequest` for
 * `capability_unsupported` rather than `InvalidParams`: the request is
 * structurally well-formed and its params resolve fine — what fails is a
 * protocol-state contract, which is that numeric's stated meaning, whereas
 * `InvalidParams` is for a supplied id that does not resolve.
 *
 * `fields` is spread into `detail` rather than aliased so the thrown error's own
 * object cannot be mutated by the mapper's sanitizer downstream.
 */
function translateDriverError(thrown: unknown): never {
  if (thrown instanceof DriverUnavailableError) {
    throw new DaemonDomainError(thrown.message, {
      code: thrown.code,
      jsonRpcCode: JsonRpcErrorCode.InternalError,
      httpStatus: 503,
      detail: { ...thrown.fields },
    });
  }

  if (thrown instanceof DriverCapabilityUnsupportedError) {
    throw new DaemonDomainError(thrown.message, {
      code: thrown.code,
      jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
      httpStatus: 400,
      detail: { ...thrown.fields },
    });
  }
  throw thrown;
}

/** Run a driver dispatch with provider-layer errors projected onto the wire. */
async function withDriverErrorTranslation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (thrown) {
    translateDriverError(thrown);
  }
}

/**
 * Resolve the driver instance currently bound to a run, or refuse.
 *
 * Two refusals, in a fixed order that mirrors the one T4.9's console-parity
 * verbs use for their session-addressed shapes: the ADDRESS fails first
 * (`run.not_found`), then availability (`driver.unavailable`). Checking
 * availability first would report a loaded-driver problem for a run id that
 * never existed, sending a caller to fix the wrong thing.
 */
function resolveDriverForRunOrThrow(
  deps: DriverDispatchDeps,
  runId: RunId,
): { readonly driverName: string; readonly driver: ProviderDriver } {
  // Called ONCE per dispatch and its answer carried, rather than re-asked for
  // the name: the resolver reads live binding state, so two calls can disagree
  // and a handler that acted on one answer while reporting the other would
  // attribute a refusal to the wrong driver.
  const driverName = deps.resolveDriverForRun(runId);
  if (driverName === undefined) {
    throw new DaemonDomainError("Run does not exist or is not accessible", {
      code: "run.not_found",
      jsonRpcCode: JsonRpcErrorCode.InvalidParams,
      httpStatus: 404,
      detail: { runId },
    });
  }
  const driver = deps.providerRegistry.lookup(driverName);
  if (driver === undefined) {
    // The run names a driver this node has not loaded. Reusing the registry's
    // own error class rather than constructing a `DaemonDomainError` inline
    // keeps one throw site's worth of drift out of the codes: this is exactly
    // the state `checkCapability` reports the same way.
    translateDriverError(new DriverUnavailableError(driverName));
  }
  return { driverName, driver };
}

/**
 * Assert a resolved driver actually implements the operation about to be called.
 *
 * NOT defensive programming. Both drivers this repo ships are deliberately
 * narrowed (`Pick`-typed) to the operations their phase has built, and two of
 * the seven client-facing verbs — `listModes` and `respondToRequest` — are
 * implemented by NEITHER at the time this handler set lands. `lookup()` returns
 * the full `ProviderDriver` type, so the call typechecks and then throws
 * `TypeError: driver.listModes is not a function` at runtime, which
 * `mapJsonRpcError` collapses to a bare `-32603` — a client told the daemon
 * crashed when what actually happened is a driver that does not offer the
 * operation.
 *
 * `driver.capability_unsupported` (400) is the registered code for that, and it
 * is the honest one on both halves: an operation the driver does not implement
 * IS a capability it does not support, and 400 says "this will not succeed on
 * retry", which is true where a 503 would invite a retry loop against a driver
 * that will never grow the method. It differs from `ProviderRegistry`'s gate in
 * carrying an OPERATION name rather than a `DriverCapabilityFlag`, because no
 * flag governs these two operations — the flag set gates capabilities, not the
 * contract's own method surface.
 */
function requireDriverOperation(
  driver: ProviderDriver,
  driverName: string,
  operation: keyof ProviderDriver,
): void {
  if (typeof driver[operation] !== "function") {
    throw new DaemonDomainError("Requested capability is not supported by the driver", {
      code: "driver.capability_unsupported",
      jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
      httpStatus: 400,
      detail: { driverId: driverName, operation },
    });
  }
}

/**
 * The roster every group-list reply is built over: registered driver names in
 * stable sorted order.
 *
 * Sorted rather than registration-ordered because registration order is a
 * bootstrap accident — it changes with config, with which driver's spawn
 * resolved first, and with nothing a client can observe — so an unsorted reply
 * would reorder a rendered list across restarts for no semantic reason.
 */
function sortedDriverNames(providerRegistry: Pick<ProviderRegistry, "listAvailable">): string[] {
  return [...providerRegistry.listAvailable()].sort();
}

// --------------------------------------------------------------------------
// Handler binders
// --------------------------------------------------------------------------

/**
 * Bind `driver.listCapabilities`.
 *
 * Served entirely from the T4.5 cache: no provider round-trip per call, which is
 * the property that makes a no-arg whole-roster read affordable. A driver the
 * cache cannot substantiate refuses the WHOLE read rather than being silently
 * omitted from the roster — an omitted driver is indistinguishable from one that
 * is not loaded, and reporting "this driver has no capabilities" for one whose
 * capabilities are merely unknown is the failure mode I-005-2 exists to prevent.
 */
export function registerDriverListCapabilities(
  registry: MethodRegistry,
  deps: DriverListCapabilitiesDeps,
): void {
  const handler: Handler<DriverReadParams, ListCapabilitiesResult> = async () => {
    const drivers: DriverCapabilityReport[] = [];
    try {
      for (const driverName of sortedDriverNames(deps.providerRegistry)) {
        drivers.push(deps.capabilityCache.read(driverName));
      }
    } catch (thrown) {
      translateDriverError(thrown);
    }
    return { drivers };
  };

  registry.register(
    "driver.listCapabilities",
    DriverReadParamsSchema,
    ListCapabilitiesResultSchema,
    handler,
    { mutating: false },
  );
}

/**
 * Bind `driver.listModels`.
 *
 * Fans out across the roster in parallel and fails the whole read if any driver
 * fails. A partial reply would be a group list with a group silently missing,
 * which reads to a client as "that driver publishes no models" — a different and
 * false claim, and exactly the omission-versus-empty confusion the output-speed
 * vocabulary doctrine forbids elsewhere in this plan.
 */
export function registerDriverListModels(registry: MethodRegistry, deps: DriverCatalogDeps): void {
  const handler: Handler<DriverReadParams, ListModelsResult> = async () => {
    const drivers = await withDriverErrorTranslation(async () =>
      Promise.all(
        sortedDriverNames(deps.providerRegistry).map(
          async (driverName): Promise<DriverModelReport> => {
            const driver = deps.providerRegistry.lookup(driverName);
            if (driver === undefined) {
              // The roster and the lookup disagree, which can only happen if a
              // driver was removed between the two calls. Reporting it as
              // unavailable is honest and self-correcting: the next read sees
              // the shorter roster.
              throw new DriverUnavailableError(driverName);
            }
            requireDriverOperation(driver, driverName, "listModels");
            return { driverName, models: await driver.listModels() };
          },
        ),
      ),
    );
    return { drivers };
  };

  registry.register("driver.listModels", DriverReadParamsSchema, ListModelsResultSchema, handler, {
    mutating: false,
  });
}

/**
 * Bind `driver.listModes`.
 *
 * Structurally identical to `driver.listModels`; the two stay separate methods
 * because they answer about different axes and a merged one would force a caller
 * that wants one to pay for the other.
 */
export function registerDriverListModes(registry: MethodRegistry, deps: DriverCatalogDeps): void {
  const handler: Handler<DriverReadParams, ListModesResult> = async () => {
    const drivers = await withDriverErrorTranslation(async () =>
      Promise.all(
        sortedDriverNames(deps.providerRegistry).map(
          async (driverName): Promise<DriverModeReport> => {
            const driver = deps.providerRegistry.lookup(driverName);
            if (driver === undefined) {
              throw new DriverUnavailableError(driverName);
            }
            requireDriverOperation(driver, driverName, "listModes");
            return { driverName, modes: await driver.listModes() };
          },
        ),
      ),
    );
    return { drivers };
  };

  registry.register("driver.listModes", DriverReadParamsSchema, ListModesResultSchema, handler, {
    mutating: false,
  });
}

/**
 * Bind `driver.interruptRun`.
 *
 * The driver operation returns `Promise<void>`; the handler answers `{}`. That
 * is not a formality — the registry `safeParse`s every result, and a handler
 * returning `undefined` would fail its own result schema and surface a
 * successful interrupt to the client as an internal error.
 */
export function registerDriverInterruptRun(
  registry: MethodRegistry,
  deps: DriverDispatchDeps,
): void {
  const handler: Handler<InterruptRunParams, DriverAckResult> = async (params) => {
    return withDriverErrorTranslation(async () => {
      const { driverName, driver } = resolveDriverForRunOrThrow(deps, params.runId);
      requireDriverOperation(driver, driverName, "interruptRun");
      await driver.interruptRun(params);
      return {};
    });
  };

  registry.register(
    "driver.interruptRun",
    InterruptRunParamsSchema,
    DriverAckResultSchema,
    handler,
    { mutating: true },
  );
}

/**
 * Bind `driver.applyIntervention`.
 *
 * Deliberately NOT pre-gated by `ProviderRegistry.checkCapability`. ADR-011
 * makes an unsupported intervention DATA rather than an exception: the call must
 * reach the driver so it can answer `{ status: "degraded", fallbackAction }`,
 * and refusing at a gate would replace a usable fallback hint with an error. The
 * registry records the same exclusion on its own side by having no branch for
 * this operation.
 */
export function registerDriverApplyIntervention(
  registry: MethodRegistry,
  deps: DriverDispatchDeps,
): void {
  const handler: Handler<ApplyInterventionParams, DriverInterventionResult> = async (params) => {
    return withDriverErrorTranslation(async () => {
      const { driverName, driver } = resolveDriverForRunOrThrow(deps, params.targetRunId);
      requireDriverOperation(driver, driverName, "applyIntervention");
      return driver.applyIntervention(params);
    });
  };

  registry.register(
    "driver.applyIntervention",
    ApplyInterventionParamsSchema,
    DriverInterventionResultSchema,
    handler,
    { mutating: true },
  );
}

/** Bind `driver.respondToRequest`. Answers `{}` for the same reason as `interruptRun`. */
export function registerDriverRespondToRequest(
  registry: MethodRegistry,
  deps: DriverDispatchDeps,
): void {
  const handler: Handler<RespondToRequestParams, DriverAckResult> = async (params) => {
    return withDriverErrorTranslation(async () => {
      const { driverName, driver } = resolveDriverForRunOrThrow(deps, params.runId);
      requireDriverOperation(driver, driverName, "respondToRequest");
      await driver.respondToRequest(params);
      return {};
    });
  };

  registry.register(
    "driver.respondToRequest",
    RespondToRequestParamsSchema,
    DriverAckResultSchema,
    handler,
    { mutating: true },
  );
}

/**
 * Bind `driver.subscribeEvents`.
 *
 * The wire response is the shared `SubscribeAckResponse` — the opaque
 * `subscriptionId` and nothing else — with events following as
 * `$/subscription/notify` frames. The ordering construction (buffer during the
 * synchronous replay window, flush on a `setImmediate` boundary) is inherited
 * from `session.subscribe` unchanged; that file carries the full derivation of
 * why a chained `queueMicrotask` cannot cross the dispatch response and
 * `setImmediate` can.
 *
 * The per-value schema is `SessionEventSchema` and the driver-category narrowing
 * is applied by this handler before `sub.next`, not by a narrower schema.
 * `DriverEvent` is Plan-006-owned and this module does not author it; filtering
 * at the boundary gets the same guarantee without minting a type this plan does
 * not own.
 */
export function registerDriverSubscribeEvents(
  registry: MethodRegistry,
  deps: DriverSubscribeEventsDeps,
): void {
  const handler: Handler<DriverSubscribeEventsParams, SubscribeAckResponse> = async (
    params,
    ctx,
  ) => {
    if (ctx.transportId === undefined) {
      // Per-connection streaming state needs a transport identity. A missing one
      // is a bootstrap or direct-test-call fault rather than a client protocol
      // violation, so a plain `Error` (mapped to `-32603`) is the honest
      // reporting — the same posture `session.subscribe` takes.
      throw new Error(
        "driver.subscribeEvents: handler requires ctx.transportId (per-connection streaming state requires a transport identity)",
      );
    }

    const sub = deps.streamingPrimitive.createSubscription<SessionEvent>(
      ctx.transportId,
      SessionEventSchema,
    );

    const replayBuffer: SessionEvent[] = [];
    let replayDrained = false;
    try {
      const unsubscribe = deps.subscribeToDriverEvents(params.runId, (event) => {
        // Filter BEFORE buffering, not at flush time: an event that must never
        // reach this stream should not occupy the replay buffer either, and
        // filtering in one place keeps the live-tail and replay paths from
        // drifting apart.
        if (!DRIVER_EVENT_TYPES.has(event.type)) {
          return;
        }
        if (replayDrained) {
          // Live-tail runs on a later turn, outside the reach of the try/catch
          // around setup. An unguarded `StreamingValidationError` here escapes
          // as an uncaught exception and can terminate the daemon; cancel this
          // subscription and keep every other one on the transport alive.
          // TRIPWIRE: replace `console.error` once a structured logger surfaces
          // in the runtime-daemon.
          try {
            sub.next(event);
          } catch (thrown) {
            sub.cancel();
            console.error(
              `[driver.subscribeEvents] live-tail event validation/emission failed for subscriptionId=${sub.subscriptionId}; subscription canceled`,
              thrown,
            );
          }
        } else {
          replayBuffer.push(event);
        }
      });
      sub.onCancel(unsubscribe);
    } catch (thrown) {
      // Atomicity guard: without this the streaming-primitive entry would orphan
      // in both of its maps until the transport closed.
      sub.cancel();
      translateDriverError(thrown);
    }

    setImmediate(() => {
      replayDrained = true;
      try {
        for (const event of replayBuffer) {
          sub.next(event);
        }
      } catch (thrown) {
        sub.cancel();
        console.error(
          `[driver.subscribeEvents] replay event validation/emission failed for subscriptionId=${sub.subscriptionId}; subscription canceled`,
          thrown,
        );
      }
      replayBuffer.length = 0;
    });

    return { subscriptionId: sub.subscriptionId };
  };

  registry.register(
    "driver.subscribeEvents",
    DriverSubscribeEventsParamsSchema,
    SubscribeAckResponseSchema,
    handler,
    { mutating: false },
  );
}
