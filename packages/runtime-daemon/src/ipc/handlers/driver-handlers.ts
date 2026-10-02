// The `driver.*` request/response JSON-RPC handlers, bound onto the `MethodRegistry` and
// dispatched into the in-daemon `ProviderRegistry`. `driver.subscribeEvents` lives in
// `driver-subscribe.ts`.
//
// - Driver authority is local: every handler resolves a driver from the local registry.
// - `createSession`, `resumeSession`, `startRun`, `closeSession` and `respondToRequest` have no
//   verb: orchestration owns the first four, and a person answers an ask through
//   `approval.resolve` or `question.resolve`. A client guessing the name gets `method_not_found`.
// - Session-addressed verbs run the session-access mask first: a session id is the authorization
//   scope before it is an address.
// - Run-addressed verbs take `resolveDriverForRun` as a dependency, because liveness over
//   `runtime_bindings` (1:many per run, superseded rows kept) is judged in one place.

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
  ListModelsRequest,
  ListModelsResult,
  ListModesResult,
  ListProviderCommandsRequest,
  MethodRegistry,
  ProviderCommandBinding,
  ProviderCommandBindingGroup,
  ProviderCommandListResult,
  ProviderName,
  RunId,
  SessionId,
} from "@ai-sidekicks/contracts";
import { DRIVER_METHOD_DESCRIPTORS, JsonRpcErrorCode } from "@ai-sidekicks/contracts";

import type { DriverCapabilityCache } from "../../provider/capability-cache.js";
import {
  DriverCapabilityUnsupportedError,
  DriverUnavailableError,
  type ProviderRegistry,
} from "../../provider/provider-registry.js";
import { DaemonDomainError } from "../domain-error.js";
import { SessionNotFoundError } from "../session-errors.js";

import { registerDescribedMethod } from "./register-described-method.js";
import {
  DRIVER_CAPABILITY_UNSUPPORTED_MESSAGE,
  type ProviderDriver,
} from "../../provider/provider-driver.js";

/** The registry surface a roster read needs; it excludes `checkCapability`, which is a gate. */
type DriverRosterSource = Pick<ProviderRegistry, "listAvailable" | "lookup">;

/** Dependencies for `driver.listCapabilities`. */
export interface DriverListCapabilitiesDeps {
  /** Enumerates the drivers this node has loaded; the reply's roster. */
  readonly providerRegistry: Pick<ProviderRegistry, "listAvailable">;
  /** Serves one driver's report from memory or one durable read; never round-trips a driver. */
  readonly capabilityCache: Pick<DriverCapabilityCache, "read">;
}

/** Dependencies for `driver.listModels` and `driver.listModes`. */
export interface DriverCatalogDeps {
  readonly providerRegistry: DriverRosterSource;
}

/**
 * Dependencies for the two run-addressed verbs. `resolveDriverForRun` names the driver bound to a
 * run, or `undefined` when the run is unknown or not live; the handler does not judge liveness.
 */
export interface DriverDispatchDeps {
  readonly providerRegistry: Pick<ProviderRegistry, "lookup">;
  readonly resolveDriverForRun: (runId: RunId) => ProviderName | undefined;
}

// The resolution unions never throw: a resolver hands back address and liveness as data so the
// handler can put the permission check between them, and a denied caller's answer does not
// vary with binding state.

/** One run's live-binding resolution, scoped to the addressed session. */
type RunBindingResolution =
  | { readonly kind: "unknown-run" }
  | { readonly kind: "no-live-binding" }
  | { readonly kind: "bound"; readonly driverName: ProviderName; readonly bindingId: string };

/**
 * One live binding as the daemon resolves it. `providerAccountId` is the daemon's own record
 * (`null`: no account), the baseline the driver-stamped routing pair is verified against.
 */
interface ResolvedAgentBinding {
  readonly driverName: ProviderName;
  readonly bindingId: string;
  readonly providerAccountId: string | null;
}

/** One agent's live-binding resolution; the `bound` arm is non-empty by type. */
type AgentBindingsResolution =
  | { readonly kind: "unknown-agent" }
  | { readonly kind: "no-live-binding" }
  | {
      readonly kind: "bound";
      readonly bindings: readonly [ResolvedAgentBinding, ...ResolvedAgentBinding[]];
    };

/** Dependencies for `driver.compactContext`. */
export interface DriverCompactContextDeps {
  /** `checkCapability` joins `lookup` here because this verb is capability-gated. */
  readonly providerRegistry: Pick<ProviderRegistry, "lookup" | "checkCapability">;
  /**
   * `true` only when the session exists here and is bound to this node; one answer for both
   * refusals keeps the masked throw byte-identical.
   */
  readonly resolveSessionAccess: (sessionId: SessionId) => boolean;
  /**
   * The run-control permission decision; required so an omitted one fails typecheck. Fail-closed:
   * anything but `"permit"` settles as `not_permitted`.
   */
  readonly evaluateInterveneAction: (sessionId: SessionId, runId: RunId) => "permit" | "deny";
  /** Resolves the run to its live binding, as data; see the note above the unions. */
  readonly resolveRunBinding: (sessionId: SessionId, runId: RunId) => RunBindingResolution;
}

/** Dependencies for `driver.listProviderCommands`. */
export interface DriverListProviderCommandsDeps {
  readonly providerRegistry: Pick<ProviderRegistry, "lookup" | "checkCapability">;
  /** Same contract as `DriverCompactContextDeps.resolveSessionAccess`. */
  readonly resolveSessionAccess: (sessionId: SessionId) => boolean;
  /** Resolves an agent to its live bindings in the session; the wire schema checks the UUID. */
  readonly resolveAgentBindings: (sessionId: SessionId, agentId: string) => AgentBindingsResolution;
}

/**
 * Projects a provider-layer typed error onto its registered wire code and rethrows anything else;
 * it always throws. `capability_unsupported` is `InvalidRequest`: the params resolve and a
 * protocol-state contract fails.
 */
export function translateDriverError(thrown: unknown): never {
  // `detail` is a copy so the mapper's sanitizer cannot mutate the error's own fields.
  if (thrown instanceof DriverUnavailableError) {
    throw new DaemonDomainError(thrown.message, {
      code: thrown.code,
      jsonRpcCode: JsonRpcErrorCode.InternalError,
      detail: { ...thrown.fields },
    });
  }

  if (thrown instanceof DriverCapabilityUnsupportedError) {
    throw new DaemonDomainError(thrown.message, {
      code: thrown.code,
      jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
      detail: { ...thrown.fields },
    });
  }
  throw thrown;
}

async function withDriverErrorTranslation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (thrown) {
    translateDriverError(thrown);
  }
}

/**
 * Resolves the driver bound to a run, or refuses: the address fails first (`run.not_found`), then
 * availability, so a run id that never existed is not reported as a driver problem.
 */
function resolveDriverForRunOrThrow(
  deps: DriverDispatchDeps,
  runId: RunId,
): { readonly driverName: ProviderName; readonly driver: ProviderDriver } {
  // Called once: the resolver reads live binding state, so a second call could disagree.
  const driverName = deps.resolveDriverForRun(runId);
  if (driverName === undefined) {
    refuseRunNotFound(runId);
  }
  const driver = deps.providerRegistry.lookup(driverName);
  if (driver === undefined) {
    // The run names a driver this node has not loaded; reuse the registry's error class.
    translateDriverError(new DriverUnavailableError(driverName));
  }
  return { driverName, driver };
}

/** One throw site, so the run-addressed verbs and `driver.compactContext` cannot drift. */
function refuseRunNotFound(runId: RunId): never {
  throw new DaemonDomainError("Run does not exist or is not accessible", {
    code: "run.not_found",
    jsonRpcCode: JsonRpcErrorCode.InvalidParams,
    detail: { runId },
  });
}

/**
 * The only throw site for the session mask: constant message and no fields, so a session not
 * bound here is indistinguishable from an unknown one.
 */
function refuseSessionNotFound(): never {
  throw new SessionNotFoundError("Session does not exist or is not accessible");
}

function refuseAgentNotFound(agentId: string): never {
  throw new DaemonDomainError("Agent does not exist in the session", {
    code: "agent.not_found",
    jsonRpcCode: JsonRpcErrorCode.InvalidParams,
    detail: { agentId },
  });
}

/**
 * Refuses a target no live binding backs. Built inline because `DriverUnavailableError` carries a
 * `driverId` and there is no driver name here; no `data.fields`, the caller knows its target.
 */
function refuseNoLiveBinding(): never {
  throw new DaemonDomainError("Provider driver is currently unavailable", {
    code: "driver.unavailable",
    jsonRpcCode: JsonRpcErrorCode.InternalError,
  });
}

/**
 * Asserts a resolved driver implements the operation. Neither shipped driver implements every
 * one (both omit `listModes`), and a missing method would be a `TypeError` mapped to `-32603`;
 * `InvalidRequest` tells the caller not to retry. It names an operation because no capability
 * flag governs it.
 */
function requireDriverOperation(
  driver: ProviderDriver,
  driverName: ProviderName,
  operation: keyof ProviderDriver,
): void {
  if (typeof driver[operation] !== "function") {
    throw new DaemonDomainError(DRIVER_CAPABILITY_UNSUPPORTED_MESSAGE, {
      code: "driver.capability_unsupported",
      jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
      detail: { driverId: driverName, operation },
    });
  }
}

/**
 * Refuses a steer with attachment references before any driver method runs: nothing downstream
 * resolves an id to bytes (the Codex dispatcher builds `steerRun` without them), so the steer
 * would answer `applied` with them dropped. Same shape as `requireDriverOperation`.
 */
function refuseAttachmentDeliveryUnsupported(driverName: ProviderName): never {
  throw new DaemonDomainError(
    "Attachment references on a steer cannot be delivered, so the whole intervention is refused " +
      "rather than applied with its attachments dropped. Re-send the steer without attachments.",
    {
      code: "driver.capability_unsupported",
      jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
      detail: { driverId: driverName, operation: "applyIntervention" },
    },
  );
}

/** Sorted, because registration order depends on bootstrap timing and a list must not reorder. */
function sortedDriverNames(
  providerRegistry: Pick<ProviderRegistry, "listAvailable">,
): ProviderName[] {
  return [...providerRegistry.listAvailable()].sort();
}

/**
 * Binds `driver.listCapabilities`, served from the cache with no provider round-trip. A driver the
 * cache cannot substantiate refuses the read: omitting it would look like an unloaded driver.
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

  registerDescribedMethod(registry, DRIVER_METHOD_DESCRIPTORS["driver.listCapabilities"], handler);
}

/**
 * Binds `driver.listModels`: fans out in parallel and fails the whole read if any driver fails,
 * since a partial reply would read as "publishes no models". The request's session is unused.
 */
export function registerDriverListModels(registry: MethodRegistry, deps: DriverCatalogDeps): void {
  const handler: Handler<ListModelsRequest, ListModelsResult> = async () => {
    const drivers = await withDriverErrorTranslation(async () =>
      Promise.all(
        sortedDriverNames(deps.providerRegistry).map(
          async (driverName): Promise<DriverModelReport> => {
            const driver = deps.providerRegistry.lookup(driverName);
            if (driver === undefined) {
              // The roster and lookup disagree only if a driver was removed between them.
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

  registerDescribedMethod(registry, DRIVER_METHOD_DESCRIPTORS["driver.listModels"], handler);
}

/** Binds `driver.listModes`; a separate method so a caller wanting one axis skips the other. */
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

  registerDescribedMethod(registry, DRIVER_METHOD_DESCRIPTORS["driver.listModes"], handler);
}

/**
 * Binds `driver.interruptRun`. The handler answers `{}`, since `undefined` would fail the
 * registry's result parse and report a successful interrupt as an internal error.
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

  registerDescribedMethod(registry, DRIVER_METHOD_DESCRIPTORS["driver.interruptRun"], handler);
}

/**
 * Binds `driver.applyIntervention`. It is not pre-gated by `checkCapability`, so the driver can
 * answer `{ status: "degraded", fallbackAction }`; the attachment guard runs last, after address,
 * availability and operation.
 */
export function registerDriverApplyIntervention(
  registry: MethodRegistry,
  deps: DriverDispatchDeps,
): void {
  const handler: Handler<ApplyInterventionParams, DriverInterventionResult> = async (params) => {
    return withDriverErrorTranslation(async () => {
      const { driverName, driver } = resolveDriverForRunOrThrow(deps, params.targetRunId);
      requireDriverOperation(driver, driverName, "applyIntervention");
      if (params.type === "steer" && (params.payload.attachments?.length ?? 0) > 0) {
        refuseAttachmentDeliveryUnsupported(driverName);
      }
      return driver.applyIntervention(params);
    });
  };

  registerDescribedMethod(registry, DRIVER_METHOD_DESCRIPTORS["driver.applyIntervention"], handler);
}

/**
 * Binds `driver.compactContext`. Refusal order: session mask, `run.not_found`, run-control
 * permission (before liveness so a deny cannot vary with binding state; it answers `refused` as
 * data), `driver.unavailable`, capability gate, then the driver's result verbatim.
 */
export function registerDriverCompactContext(
  registry: MethodRegistry,
  deps: DriverCompactContextDeps,
): void {
  const handler: Handler<CompactContextRequest, DriverCompactionResult> = async (params) => {
    if (!deps.resolveSessionAccess(params.sessionId)) {
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
        // The binding names a driver this node has not loaded.
        throw new DriverUnavailableError(resolution.driverName);
      }
      deps.providerRegistry.checkCapability(resolution.driverName, "context_compaction");
      requireDriverOperation(driver, resolution.driverName, "compactContext");
      // The driver's params are binding-addressed; the daemon has already resolved the run.
      return driver.compactContext({
        sessionId: params.sessionId,
        bindingId: resolution.bindingId,
      });
    });
  };

  registerDescribedMethod(registry, DRIVER_METHOD_DESCRIPTORS["driver.compactContext"], handler);
}

/**
 * Verifies the routing pair on a returned group and each entry against the daemon's own record of
 * the addressed binding. A mismatch fails the read as a plain `Error` (`-32603`) carrying only
 * daemon-owned values.
 */
function verifyDriverStampedRoutingPair(
  group: ProviderCommandBindingGroup,
  expected: ResolvedAgentBinding,
): void {
  const pairMatches = (stamped: ProviderCommandBinding): boolean =>
    stamped.driverName === expected.driverName &&
    stamped.providerAccountId === expected.providerAccountId;

  if (!pairMatches(group.binding)) {
    throw new Error(
      `driver.listProviderCommands: driver "${expected.driverName}" stamped its group ` +
        `with a routing pair that is not the addressed binding's`,
    );
  }
  for (const [entryIndex, entry] of group.entries.entries()) {
    if (!pairMatches(entry.binding)) {
      throw new Error(
        `driver.listProviderCommands: driver "${expected.driverName}" stamped entry ` +
          `${String(entryIndex)} with a routing pair that is not the addressed binding's`,
      );
    }
  }
}

/**
 * Binds `driver.listProviderCommands`. Any admitted caller reads, so no permission check sits in
 * `compactContext`'s refusal order. Every binding is gated before any dispatch, so a refusal
 * means zero dispatches; each driver answers exactly one group and the handler adds nothing.
 */
export function registerDriverListProviderCommands(
  registry: MethodRegistry,
  deps: DriverListProviderCommandsDeps,
): void {
  const handler: Handler<ListProviderCommandsRequest, ProviderCommandListResult> = async (
    params,
  ) => {
    if (!deps.resolveSessionAccess(params.sessionId)) {
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
      // Admit every binding before any dispatch starts, so a refusal means zero dispatches.
      const admitted = resolution.bindings.map((resolvedBinding) => {
        const driver = deps.providerRegistry.lookup(resolvedBinding.driverName);
        if (driver === undefined) {
          throw new DriverUnavailableError(resolvedBinding.driverName);
        }
        deps.providerRegistry.checkCapability(resolvedBinding.driverName, "provider_commands");
        requireDriverOperation(driver, resolvedBinding.driverName, "listProviderCommands");
        return { driver, resolvedBinding };
      });

      // Parallel, since each read is a live provider round-trip; `Promise.all` keeps order. No wire
      // request admits a binding member, so a cross-binding dispatch cannot be expressed.
      const groups: ProviderCommandBindingGroup[] = await Promise.all(
        admitted.map(async ({ driver, resolvedBinding }) => {
          const reply = await driver.listProviderCommands({
            sessionId: params.sessionId,
            bindingId: resolvedBinding.bindingId,
          });
          const [soleGroup] = reply.bindings;
          if (soleGroup === undefined || reply.bindings.length !== 1) {
            // A plain Error (`-32603`): a broken driver contract is not a refusal a caller can act
            // on.
            throw new Error(
              `driver.listProviderCommands: driver "${resolvedBinding.driverName}" answered ` +
                `${String(reply.bindings.length)} groups for one binding (the driver ` +
                `operation contract is exactly one)`,
            );
          }
          verifyDriverStampedRoutingPair(soleGroup, resolvedBinding);
          return soleGroup;
        }),
      );

      return { bindings: groups };
    });
  };

  registerDescribedMethod(
    registry,
    DRIVER_METHOD_DESCRIPTORS["driver.listProviderCommands"],
    handler,
  );
}
