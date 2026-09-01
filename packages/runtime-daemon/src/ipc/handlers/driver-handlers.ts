// The `driver.*` JSON-RPC handlers — Plan-005 Phase 4, T4.1.
//
// The EIGHT request/response verbs of the client-facing set, bound onto Plan-007's
// `MethodRegistry` and dispatched into the IN-DAEMON `ProviderRegistry` (T2.3).
// The ninth, `driver.subscribeEvents`, is registered by the sibling
// `driver-subscribe.ts` — T4.4 moved that leg out of this module rather than
// leaving a second copy behind, so this file no longer binds it and no longer
// derives the driver event set. That dispatch target is the point rather than an
// implementation detail: I-005-1 holds driver authority LOCAL even when the
// provider endpoint is remote, so every handler here resolves a driver instance
// from the local registry and calls it in this process. Nothing in this module
// can express "execute via the control plane", which is how the invariant
// survives contact with a wire surface.
//
// WHY THE CLIENT-FACING SET IS NINE AND NOT THIRTEEN. `ProviderDriver` carries eighteen operations. Four
// of them — `createSession`, `resumeSession`, `startRun`, `closeSession` — are
// daemon-internal by Plan-005 §Phase 4 decision #2 and are registered NOWHERE:
// they establish, restore, start, or tear down a session-or-run domain object,
// which is orchestration's job, and a client reaching them directly would let a
// caller mint runtime state behind the orchestrator's back. Their absence from
// this file is the enforcement — there is no schema for them at the SDK seam and
// no `register` call here, so a client that guessed the method name gets
// `method_not_found` from the registry substrate. T4.9's two console-parity
// verbs (`driver.compactContext`, `driver.listProviderCommands`) extend THIS
// module (never a second one), taking the set bound here from six to eight: both
// are request/response dispatches, which is the concern this file owns.
// `driver-subscribe.ts` is not a counterexample to that rule but an application
// of it — a subscription allocates per-connection state and owns an ordering
// obligation none of these verbs carry, which is the seam T4.4 draws and the
// same one `session-subscribe.ts` already sits on.
//
// THE TWO CONSOLE-PARITY VERBS ARE SESSION-ADDRESSED, AND AUTHORIZATION RUNS
// FIRST. Unlike the run-addressed verbs — whose run id is globally unique — a
// binding and an agent are only identified within a session, so both requests
// carry the session id, and it is the AUTHORIZATION SCOPE before it is an
// address. A caller who is not an active member of the named session is refused
// `session.not_found` BYTE-IDENTICALLY to a caller naming a session that does
// not exist (one throw site, constant message, no fields), so the refusal is no
// session-existence oracle. Only then does the canonical fixed refusal order
// proceed: `run.not_found` / `agent.not_found` on the second key,
// `driver.unavailable` where no live binding backs the target, and the
// capability gate (`context_compaction` / `provider_commands`) last — every one
// an already-registered code. `driver.compactContext` additionally runs the
// run-control adjudication between the address check and the liveness check,
// and a deny settles on the operation's OWN refused arm (`not_permitted`)
// rather than as a JSON-RPC error: a denied caller was answered, not
// mis-addressed.
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
// `driver.capability_unsupported` (400), `run.not_found` (404), and, on the two
// console-parity verbs, `session.not_found` (404) and `agent.not_found` (404).
// Nothing new is minted; the driver namespace stays closed at its seven codes.
//
// Invariants this module participates in (canonical text in
// `docs/plans/007-local-ipc-and-daemon-control.md §Invariants`):
//   * I-007-6 — duplicate registration is rejected at register-time by the
//     registry, so binding this namespace twice fails loudly at bootstrap.
//   * I-007-7 — schema-validates-before-dispatch. The registry `safeParse`s the
//     request against the T4.2 SDK-seam schema before a handler body runs, and
//     `safeParse`s the result before it reaches the wire.
//   * I-007-8 — sanitized error mapping; see the translation note above.
//   * I-007-9 — dotted-camelCase method names; all eight match the canonical
//     regex.
// I-007-10 (the subscribe-init response precedes the first notify frame) is not
// listed: no method bound here opens a subscription. It moved to
// `driver-subscribe.ts` with the handler that owes it.
//
// Mutating flags: `false` on the three roster reads and on
// `listProviderCommands`, which reads live enumeration state and changes
// nothing; `true` on `interruptRun`, `applyIntervention`, `respondToRequest`,
// and `compactContext`, each of which drives a live run. The flag gates the
// pre-handshake path, so a version-mismatched connection keeps read-only access
// and loses exactly the four verbs that change something.
// `driver.subscribeEvents` is `false` for the same reason the reads are, and
// carries that flag in its own module.
//
// Refs: Plan-005 §Phase 4 / T4.1 + T4.9, `Spec-005 §Capability discovery`,
// `Spec-005 §Interfaces And Contracts`, invariants I-005-1 / I-005-2 /
// I-005-13, CP-007-6 (the `driver.*` namespace registered against Plan-007's
// registry), `docs/architecture/contracts/error-contracts.md §Driver` + §Run +
// §Session + §Agent.

import type {
  ApplyInterventionParams,
  CompactContextRequest,
  DriverAckResult,
  DriverCapabilityReport,
  DriverCompactionResult,
  DriverInterventionResult,
  DriverModeReport,
  DriverModelReport,
  DriverReadParams,
  Handler,
  InterruptRunParams,
  ListCapabilitiesResult,
  ListModelsResult,
  ListModesResult,
  ListProviderCommandsRequest,
  MethodRegistry,
  ProviderCommandBindingGroup,
  ProviderCommandListResult,
  ProviderDriver,
  RespondToRequestParams,
  RunId,
  SessionId,
} from "@ai-sidekicks/contracts";
import {
  ApplyInterventionParamsSchema,
  CompactContextRequestSchema,
  DriverAckResultSchema,
  DriverCompactionResultSchema,
  DriverInterventionResultSchema,
  DriverReadParamsSchema,
  InterruptRunParamsSchema,
  JsonRpcErrorCode,
  ListCapabilitiesResultSchema,
  ListModelsResultSchema,
  ListModesResultSchema,
  ListProviderCommandsRequestSchema,
  ProviderCommandListResultSchema,
  RespondToRequestParamsSchema,
} from "@ai-sidekicks/contracts";

import type { DriverCapabilityCache } from "../../provider/capability-cache.js";
import {
  DriverCapabilityUnsupportedError,
  DriverUnavailableError,
  type ProviderRegistry,
} from "../../provider/provider-registry.js";
import { DaemonDomainError } from "../domain-error.js";
import { SessionNotFoundError } from "../session-errors.js";

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

// --------------------------------------------------------------------------
// T4.9 dependency contracts — the two console-parity verbs
// --------------------------------------------------------------------------
//
// THE RESOLUTION UNIONS NEVER THROW, AND THAT IS A LOAD-BEARING PROPERTY, not a
// style choice. The canonical fixed refusal order puts the run-control
// adjudication BETWEEN the address check (`run.not_found`) and the liveness
// check (`driver.unavailable`), so the resolver has to hand back both facts as
// DATA for the handler to sequence — a resolver that threw `driver.unavailable`
// itself would land liveness ahead of the authorization step and let a denied
// caller's answer vary with binding state. The three-armed union is the same
// liveness seam `resolveDriverForRun` draws (the judgement lives with the
// bootstrap orchestrator's session engine, never in a wire handler), widened by
// the one distinction these session-scoped verbs owe: an address that does not
// resolve versus a resolved address no live binding backs.

/** One run's live-binding resolution, scoped to the addressed session. */
export type RunBindingResolution =
  | { readonly kind: "unknown-run" }
  | { readonly kind: "no-live-binding" }
  | { readonly kind: "bound"; readonly driverName: string; readonly bindingId: string };

/**
 * One agent's live-binding resolution, scoped to the addressed session.
 *
 * The `bound` arm is NON-EMPTY by contract: an agent whose binding list would
 * be empty IS the `no-live-binding` arm, so a handler never has to invent a
 * meaning for a bound-but-empty answer (it would parse as an empty group list,
 * which the result schema rejects as never-empty-on-success).
 */
export type AgentBindingsResolution =
  | { readonly kind: "unknown-agent" }
  | { readonly kind: "no-live-binding" }
  | {
      readonly kind: "bound";
      readonly bindings: ReadonlyArray<{
        readonly driverName: string;
        readonly bindingId: string;
      }>;
    };

/** Dependencies for `driver.compactContext`. */
export interface DriverCompactContextDeps {
  /** `checkCapability` joins `lookup` here: this verb IS pre-gated (contrast
   * `applyIntervention`, whose ADR-011 exclusion is recorded on its binder). */
  readonly providerRegistry: Pick<ProviderRegistry, "lookup" | "checkCapability">;
  /**
   * The membership mask both console-parity verbs run FIRST. Answers whether
   * the transport-bound caller — the node-owner participant under the V1
   * local-transport rule (api-payload-contracts.md §Authenticated Principal
   * And Authorization Model) — is an active member of an EXISTING session.
   * `false` collapses "no such session" and "not a member" into one answer on
   * purpose: the handler's single masked throw site is what makes the two
   * refusals byte-identical, and a resolver that distinguished them would be
   * rebuilding the session-existence oracle the mask exists to remove.
   * Implementor: the bootstrap orchestrator's session engine, off its
   * membership projection (`DaemonSessionSnapshot.memberships`).
   */
  readonly resolveSessionAccess: (sessionId: SessionId) => boolean;
  /**
   * The run-control adjudication, REQUIRED. This MUST be bound to the
   * IDENTICAL `Action::"intervene"` evaluation the `run.pause` / `run.resume`
   * path runs — the Security Architecture permission-matrix run-control row
   * names compaction on that same row, so a second policy here would fork one
   * decision. No Cedar seam exists in the daemon at this task's landing
   * (Plan-012 owns it); this dependency is that seam's named socket rather
   * than a fabricated engine, and it is REQUIRED rather than optional so a
   * bootstrap that forgot to wire it fails typecheck instead of silently
   * refusing every compaction at runtime. The handler is fail-closed against a
   * broken implementor besides: every answer except the literal `"permit"`
   * settles as the operation's own `not_permitted` refusal.
   */
  readonly evaluateInterveneAction: (sessionId: SessionId, runId: RunId) => "permit" | "deny";
  /** The liveness seam — see the union's own doctrine above. */
  readonly resolveRunBinding: (sessionId: SessionId, runId: RunId) => RunBindingResolution;
}

/** Dependencies for `driver.listProviderCommands`. */
export interface DriverListProviderCommandsDeps {
  readonly providerRegistry: Pick<ProviderRegistry, "lookup" | "checkCapability">;
  /** Same contract as `DriverCompactContextDeps.resolveSessionAccess`; the
   * production wiring binds ONE implementation to both. */
  readonly resolveSessionAccess: (sessionId: SessionId) => boolean;
  /**
   * The agent-to-live-bindings fan-out seam. `agentId` is `string` because the
   * canonical `AgentId` brand homes in Plan-016's unshipped `orchestration.ts`
   * — the wire schema UUID-validates the value, and the member narrows to the
   * brand when that module ships (see the contracts-side note on
   * `ListProviderCommandsRequest`).
   */
  readonly resolveAgentBindings: (sessionId: SessionId, agentId: string) => AgentBindingsResolution;
}

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
export function translateDriverError(thrown: unknown): never {
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
    refuseRunNotFound(runId);
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
 * Refuse a run address that does not resolve. ONE throw site for the code, so
 * the run-addressed verbs and `driver.compactContext` cannot drift on its
 * message, numeric, or detail shape.
 */
function refuseRunNotFound(runId: RunId): never {
  throw new DaemonDomainError("Run does not exist or is not accessible", {
    code: "run.not_found",
    jsonRpcCode: JsonRpcErrorCode.InvalidParams,
    httpStatus: 404,
    detail: { runId },
  });
}

/**
 * Refuse a session the caller may not see — ONE throw site, and the singularity
 * is the security property. Both console-parity verbs route their membership
 * mask through this function with a constant message and NO fields, so
 * `buildSessionNotFoundData` emits `{ type }` alone and a non-member's refusal
 * is byte-for-byte the unknown-session refusal: the verb cannot be used to
 * probe which sessions exist. The message is the registered description for
 * `session.not_found` verbatim.
 */
function refuseSessionNotFound(): never {
  throw new SessionNotFoundError("Session does not exist or is not accessible");
}

/**
 * Refuse an agent address that does not resolve within the addressed session.
 * Mirrors `refuseRunNotFound` member for member; `agent.not_found` registers
 * `agentId` as its one `data.fields` entry.
 */
function refuseAgentNotFound(agentId: string): never {
  throw new DaemonDomainError("Agent does not exist in the session", {
    code: "agent.not_found",
    jsonRpcCode: JsonRpcErrorCode.InvalidParams,
    httpStatus: 404,
    detail: { agentId },
  });
}

/**
 * Refuse a resolved target that no live binding backs.
 *
 * Constructed inline rather than through `DriverUnavailableError` because that
 * class's fields carry a `driverId` — and on this arm there IS no driver name:
 * the target holds no live binding at all. The envelope carries NO
 * `data.fields` either, deliberately: naming the target (`runId` / `agentId`)
 * would mint a new fields shape on a registered code whose contract row
 * documents none (every other producer emits `{ driverId }`), and it would
 * tell the caller nothing — the caller addressed that exact target in the
 * request this refusal answers, and JSON-RPC id correlation already binds the
 * two. Message and numerics mirror the registered `driver.unavailable` row and
 * the `translateDriverError` projection exactly.
 */
function refuseNoLiveBinding(): never {
  throw new DaemonDomainError("Provider driver is currently unavailable", {
    code: "driver.unavailable",
    jsonRpcCode: JsonRpcErrorCode.InternalError,
    httpStatus: 503,
  });
}

/**
 * Assert a resolved driver actually implements the operation about to be called.
 *
 * NOT defensive programming. Both drivers this repo ships are deliberately
 * narrowed (`Pick`-typed) to the operations their phase has built, and two of
 * the nine client-facing verbs — `listModes` and `respondToRequest` — are
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
 * Bind `driver.compactContext`.
 *
 * THE REFUSAL ORDER IS THE CANONICAL FIXED ONE, and every step earns its
 * position. The membership mask runs first (one throw site — see
 * `refuseSessionNotFound` — so a non-member and an unknown session are
 * byte-identical). The address check runs second: a member is told the run id
 * does not resolve (`run.not_found`) before anything about drivers, per the
 * resolver doctrine on `resolveDriverForRunOrThrow`. The run-control
 * adjudication runs third, deliberately BEFORE liveness, so a denied caller
 * gets the same answer whether or not a binding happens to be live at that
 * instant — role-determined refusals stay stable across mutable state (the PTY
 * session-attach precedent in api-payload-contracts.md) — and a deny settles on
 * the operation's OWN `refused` arm as `not_permitted`, never as a JSON-RPC
 * error, because the result union is the contract's encoding of exactly this
 * outcome. Liveness runs fourth (`driver.unavailable`), the capability gate
 * fifth — a declaring-false driver refuses `driver.capability_unsupported`
 * BEFORE any dispatch — and the driver call last, its discriminated
 * `DriverCompactionResult` answered verbatim: `refused` and `failed` are data a
 * caller branches on, never re-shaped into throws.
 */
export function registerDriverCompactContext(
  registry: MethodRegistry,
  deps: DriverCompactContextDeps,
): void {
  const handler: Handler<CompactContextRequest, DriverCompactionResult> = async (params) => {
    // Fail-closed comparison: only the literal `true` admits, so a broken
    // resolver answering `undefined` refuses rather than proceeding.
    if (deps.resolveSessionAccess(params.sessionId) !== true) {
      refuseSessionNotFound();
    }

    const resolution = deps.resolveRunBinding(params.sessionId, params.runId);
    if (resolution.kind === "unknown-run") {
      refuseRunNotFound(params.runId);
    }

    if (deps.evaluateInterveneAction(params.sessionId, params.runId) !== "permit") {
      return { status: "refused", reason: "not_permitted" };
    }

    if (resolution.kind === "no-live-binding") {
      refuseNoLiveBinding();
    }

    return withDriverErrorTranslation(async () => {
      const driver = deps.providerRegistry.lookup(resolution.driverName);
      if (driver === undefined) {
        // The binding names a driver this node has not loaded — the same state
        // `resolveDriverForRunOrThrow` reports with the registry's own class.
        throw new DriverUnavailableError(resolution.driverName);
      }
      deps.providerRegistry.checkCapability(resolution.driverName, "context_compaction");
      requireDriverOperation(driver, resolution.driverName, "compactContext");
      // The DRIVER param shape (`CompactContextParams`) is binding-addressed;
      // the run id was the wire's addressing key and stops here — the daemon
      // resolved it, so the driver never re-derives what "this run's binding"
      // means.
      return driver.compactContext({
        sessionId: params.sessionId,
        bindingId: resolution.bindingId,
      });
    });
  };

  registry.register(
    "driver.compactContext",
    CompactContextRequestSchema,
    DriverCompactionResultSchema,
    handler,
    { mutating: true },
  );
}

/**
 * Bind `driver.listProviderCommands`.
 *
 * Any active member reads: the enumeration carries offerability data, not an
 * intervention, so no adjudication step sits between the membership mask and
 * the address check — the mask and the fixed order are otherwise identical to
 * `compactContext`'s.
 *
 * EVERY BINDING IS GATED BEFORE ANY IS DISPATCHED. One declaring-false (or
 * unloaded, or operation-less) driver refuses the WHOLE read with zero
 * dispatches: a partial group list would tell a caller the missing binding
 * enumerates nothing, which is the omission-versus-empty confusion I-005-2
 * forbids — the same whole-read rule the roster reads apply to one failed
 * driver. The dispatch phase then fans out in parallel and MERGES BY
 * CONCATENATION: each driver answers exactly one group for its one binding (a
 * different count is a driver contract violation and fails the read as an
 * internal error rather than being silently flattened or padded), and the
 * handler synthesizes nothing — `runId` attribution, entry order, truncation
 * marking, and the routing pair all arrive composed by the driver that owns
 * them. The routing invariant (I-005-13) holds in V1 by UNREPRESENTABILITY
 * rather than by a comparison: no wire request admits a binding member, so a
 * cross-binding dispatch cannot be expressed at all; the pair travels on every
 * entry so the daemon has something to compare on the day a dispatch route
 * lands.
 */
export function registerDriverListProviderCommands(
  registry: MethodRegistry,
  deps: DriverListProviderCommandsDeps,
): void {
  const handler: Handler<ListProviderCommandsRequest, ProviderCommandListResult> = async (
    params,
  ) => {
    if (deps.resolveSessionAccess(params.sessionId) !== true) {
      refuseSessionNotFound();
    }

    const resolution = deps.resolveAgentBindings(params.sessionId, params.agentId);
    if (resolution.kind === "unknown-agent") {
      refuseAgentNotFound(params.agentId);
    }
    if (resolution.kind === "no-live-binding") {
      refuseNoLiveBinding();
    }

    return withDriverErrorTranslation(async () => {
      // Phase 1 — admit every binding SYNCHRONOUSLY, before any dispatch
      // starts. A gate failure inside a parallel fan-out would race dispatches
      // that were already in flight; gating in a plain loop first is what makes
      // "zero dispatches on a refusal" a property rather than a probability.
      const admitted = resolution.bindings.map(({ driverName, bindingId }) => {
        const driver = deps.providerRegistry.lookup(driverName);
        if (driver === undefined) {
          throw new DriverUnavailableError(driverName);
        }
        deps.providerRegistry.checkCapability(driverName, "provider_commands");
        requireDriverOperation(driver, driverName, "listProviderCommands");
        return { driver, driverName, bindingId };
      });

      // Phase 2 — dispatch in parallel (the listModels precedent; each read is
      // a live provider round-trip) and concatenate in resolver order, which
      // `Promise.all` preserves.
      const groups: ProviderCommandBindingGroup[] = await Promise.all(
        admitted.map(async ({ driver, driverName, bindingId }) => {
          const reply = await driver.listProviderCommands({
            sessionId: params.sessionId,
            bindingId,
          });
          const [soleGroup] = reply.bindings;
          if (soleGroup === undefined || reply.bindings.length !== 1) {
            // A plain Error (mapped `-32603`) rather than a driver code: this
            // is a broken driver contract, not a refusal a caller can act on,
            // and flattening extra groups or padding missing ones would forge
            // provenance the shared-envelope doctrine exists to protect.
            throw new Error(
              `driver.listProviderCommands: driver "${driverName}" answered ` +
                `${String(reply.bindings.length)} groups for one binding (the driver ` +
                `operation contract is exactly one)`,
            );
          }
          return soleGroup;
        }),
      );

      return { bindings: groups };
    });
  };

  registry.register(
    "driver.listProviderCommands",
    ListProviderCommandsRequestSchema,
    ProviderCommandListResultSchema,
    handler,
    { mutating: false },
  );
}
