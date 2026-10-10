// The `driver.*` request/response JSON-RPC handlers, bound onto the `MethodRegistry` and
// dispatched into the in-daemon `ProviderRegistry`. `driver.subscribeEvents` lives in
// `subscribe.ts`.
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
  DriverInterventionResult,
  InterruptRunParams,
} from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type {
  CompactContextRequest,
  DriverCapabilityReport,
  DriverModeReport,
  DriverModelReport,
  DriverReadParams,
  ListCapabilitiesResult,
  ListModelsRequest,
  ListModelsResult,
  ListModesResult,
  ListProviderCommandsRequest,
} from "@ai-sidekicks/contracts/provider/driver/methods";
import type { EmptyPayload } from "@ai-sidekicks/contracts/method-descriptor";
import type { DriverCompactionResult } from "@ai-sidekicks/contracts/provider/driver/compaction";
import type {
  ProviderCommandBinding,
  ProviderCommandBindingGroup,
  ProviderCommandListResult,
} from "@ai-sidekicks/contracts/provider/driver/commands";
import type { Handler, MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { DRIVER_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/provider/driver/methods";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";

import type { DriverCapabilityCache } from "../../../provider/capability/cache.js";
import type { RunBindingResolution } from "../../../provider/live-run-bindings.js";
import type { ProviderRegistry } from "../../../provider/driver/registry.js";
import { DaemonDomainError } from "../../domain-error.js";
import { RunNotFoundError } from "../../../session/run/refusals.js";

import { registerDescribedMethod } from "../register-described-method.js";
import {
  lookupDriverOrThrow,
  refuseSessionNotFound,
  resolveDriverForRunOrThrow,
  type DriverDispatchDeps,
} from "./resolution.js";

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

// The resolution unions, here and `RunBindingResolution`, never throw: a resolver hands back
// address and liveness as data, and the handler answers each arm with its own refusal after the
// session's access check.

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
  /** Resolves the run to its live binding, as data that never throws. */
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
 * Refuses a steer with attachment references before any driver method runs: nothing downstream
 * resolves an id to bytes (the Codex dispatcher builds `steerRun` without them), so the steer
 * would answer `applied` with them dropped. It names the operation, since no capability flag
 * governs it.
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
    const drivers: DriverCapabilityReport[] = sortedDriverNames(deps.providerRegistry).map(
      (driverName) => deps.capabilityCache.read(driverName),
    );
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
    const drivers = await Promise.all(
      sortedDriverNames(deps.providerRegistry).map(
        async (driverName): Promise<DriverModelReport> => {
          // The roster and lookup disagree only if a driver was removed between them.
          const driver = lookupDriverOrThrow(deps.providerRegistry, driverName);
          return { driverName, models: await driver.listModels() };
        },
      ),
    );
    return { drivers };
  };

  registerDescribedMethod(registry, DRIVER_METHOD_DESCRIPTORS["driver.listModels"], handler);
}

/** Binds `driver.listModes`; a separate method so a caller wanting one axis skips the other. */
export function registerDriverListModes(registry: MethodRegistry, deps: DriverCatalogDeps): void {
  const handler: Handler<DriverReadParams, ListModesResult> = async () => {
    const drivers = await Promise.all(
      sortedDriverNames(deps.providerRegistry).map(
        async (driverName): Promise<DriverModeReport> => {
          const driver = lookupDriverOrThrow(deps.providerRegistry, driverName);
          return { driverName, modes: await driver.listModes() };
        },
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
  const handler: Handler<InterruptRunParams, EmptyPayload> = async (params) => {
    const { driver } = resolveDriverForRunOrThrow(deps, params.runId);
    await driver.interruptRun(params);
    return {};
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
    const { driverName, driver } = resolveDriverForRunOrThrow(deps, params.targetRunId);
    if (params.type === "steer" && (params.payload.attachments?.length ?? 0) > 0) {
      refuseAttachmentDeliveryUnsupported(driverName);
    }
    return driver.applyIntervention(params);
  };

  registerDescribedMethod(registry, DRIVER_METHOD_DESCRIPTORS["driver.applyIntervention"], handler);
}

/**
 * Binds `driver.compactContext`. Refusal order: session mask, `run.not_found`, the live binding,
 * `driver.unavailable`, capability gate, then the driver's result verbatim. The session's one user
 * may compact any run in it, so session access is the whole permission.
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
      throw new RunNotFoundError(params.runId);
    }

    if (resolution.kind === "no-live-binding") {
      refuseNoLiveBinding();
    }

    const driver = lookupDriverOrThrow(deps.providerRegistry, resolution.driverName);
    deps.providerRegistry.checkCapability(resolution.driverName, "context_compaction");
    // The driver's params are binding-addressed; the daemon has already resolved the run.
    return driver.compactContext({
      sessionId: params.sessionId,
      bindingId: resolution.bindingId,
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

    // Admit every binding before any dispatch starts, so a refusal means zero dispatches.
    const admitted = resolution.bindings.map((resolvedBinding) => {
      const driver = lookupDriverOrThrow(deps.providerRegistry, resolvedBinding.driverName);
      deps.providerRegistry.checkCapability(resolvedBinding.driverName, "provider_commands");
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
  };

  registerDescribedMethod(
    registry,
    DRIVER_METHOD_DESCRIPTORS["driver.listProviderCommands"],
    handler,
  );
}
