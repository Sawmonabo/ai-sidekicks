// The `driver.*` client over the local daemon.
//
// There is one factory and no control-plane variant: driver authority lives in the daemon on the
// node that owns the provider process, so no client can run a provider anywhere else.
//
// The interface declares no operation that creates, resumes, starts or closes a session or run.
// Those belong to orchestration inside the daemon, so a renderer or CLI cannot mint or destroy
// runtime state through this client, and a failed resume has no route to a replacement session. A
// provider's ask is answered through `approval.resolve` or `question.resolve`.
//
// `compactContext` and `listProviderCommands` are addressed by session and carry no binding: the
// daemon resolves the live binding itself instead of trusting the renderer.
//
// Every verb validates its request before the wire write and the daemon's reply before resolving.
// `DriverInterventionResultSchema` is `.strict()`, so a degraded envelope that lost its
// `fallbackAction` or gained an unknown key rejects instead of reaching a caller. Streamed events
// are parsed against `DriverEventSchema`, so a daemon that filters wrongly ends the subscription
// loudly instead of handing a driver consumer an approval or audit row.
//
// Catalog reads answer with a list of groups keyed by driver name, not a flat array: model ids
// collide across providers, and a flat reply would lose which provider published a value.

import type {
  ApplyInterventionParams,
  CompactContextRequest,
  DriverAckResult,
  DriverCompactionResult,
  DriverEvent,
  DriverInterventionResult,
  DriverReadParams,
  DriverSubscribeEventsParams,
  InterruptRunParams,
  ListCapabilitiesResult,
  ListModelsRequest,
  ListModelsResult,
  ListModesResult,
  ListProviderCommandsRequest,
  MethodDescriptor,
  ProviderCommandListResult,
} from "@ai-sidekicks/contracts";
import {
  DRIVER_EVENT_METHOD_DESCRIPTORS,
  DRIVER_METHOD_DESCRIPTORS,
} from "@ai-sidekicks/contracts";

import { JsonRpcSchemaError, type JsonRpcClient } from "./transport/json-rpc-client.js";
import type { LocalSubscriptionConsumer } from "./transport/types.js";

/** The request the two no-arg reads send, frozen so no caller can alter what a later call sends. */
const EMPTY_READ_PARAMS: DriverReadParams = Object.freeze({});

/**
 * The client-facing driver surface: seven request/response verbs plus `subscribeEvents`.
 *
 * `compactContext` and `applyIntervention` resolve refusals as values: a `refused` or `failed`
 * compaction (including the daemon's `not_permitted`) and a `degraded` intervention are data a
 * caller branches on. Only address, liveness and capability refusals (`session.not_found`,
 * `run.not_found`, `agent.not_found`, `driver.unavailable`, `driver.capability_unsupported`)
 * arrive as `JsonRpcRemoteError`.
 *
 * `interruptRun` resolves the empty `DriverAckResult`, a genuine success value: the daemon answers
 * with `{}` because the method registry parses every result and `undefined` would fail its own
 * schema. A refusal never arrives as an empty ack.
 *
 * `applyIntervention` reaches the driver even for an unsupported intervention, so it can answer
 * `degraded` with the daemon's fallback; the daemon does not pre-gate it on the capability flag.
 * Callers must branch on `status`.
 *
 * `subscribeEvents` returns synchronously, unlike `sessionClient.subscribe`, and hands back the
 * raw consumer handle (`next()`, `for await`, idempotent `cancel()`).
 */
export interface DriverClient {
  /**
   * Read every loaded driver's client-facing capability report, served from the
   * daemon's capability cache with no provider round-trip per call.
   *
   * A driver the cache cannot substantiate refuses the whole read instead of being omitted: an
   * omitted driver looks like one that is not loaded, and "no capabilities" for a driver whose
   * capabilities are merely unknown would fail open.
   */
  listCapabilities(): Promise<ListCapabilitiesResult>;

  /** Interrupt the run's in-flight turn. Resolves the empty ack on success. */
  interruptRun(params: InterruptRunParams): Promise<DriverAckResult>;

  /** Apply a `steer` / `interrupt` / `cancel` intervention to a run. */
  applyIntervention(params: ApplyInterventionParams): Promise<DriverInterventionResult>;

  /** Read every loaded driver's model catalog for one session, grouped by driver. */
  listModels(params: ListModelsRequest): Promise<ListModelsResult>;

  /** Read every loaded driver's published mode catalog, grouped by driver. */
  listModes(): Promise<ListModesResult>;

  /**
   * Trigger a user-initiated context compaction on one run's live binding. Resolves the
   * discriminated `DriverCompactionResult`, never a bare ack: both provider mechanisms answer
   * before the work is done, and only the typed compaction evidence settles `applied`. Callers
   * must branch on `status`.
   */
  compactContext(params: CompactContextRequest): Promise<DriverCompactionResult>;

  /**
   * Read the provider command and skill enumeration across one agent's live bindings, grouped per
   * binding with the `(driverName, providerAccountId)` routing pair on every entry. A live read
   * for discovery only: no member of the reply is a dispatch handle.
   */
  listProviderCommands(params: ListProviderCommandsRequest): Promise<ProviderCommandListResult>;

  /**
   * Open a subscription to one run's driver event stream.
   *
   * The value type is `DriverEvent`, the contracts-owned union over the seven driver-event
   * categories, so a caller never has to handle an approval or audit event on a driver stream.
   */
  subscribeEvents(params: DriverSubscribeEventsParams): LocalSubscriptionConsumer<DriverEvent>;
}

/**
 * Build a `DriverClient` over a daemon transport.
 *
 * The caller owns the `ClientTransport` and the `JsonRpcClient`, and must complete the
 * `daemon.hello` handshake before the first mutating call. The daemon marks `interruptRun`,
 * `applyIntervention` and `compactContext` as mutating and the other five methods as not, so a
 * version-mismatched connection keeps the reads and loses exactly the three verbs that drive a run.
 *
 * The daemon's reply is the return value, unwrapped and unchanged. A daemon-side refusal surfaces
 * as `JsonRpcRemoteError` carrying the registered dotted code.
 */
export function createDaemonProviderClient(client: JsonRpcClient): DriverClient {
  return {
    listCapabilities: () =>
      callDriverMethod(
        client,
        DRIVER_METHOD_DESCRIPTORS["driver.listCapabilities"],
        EMPTY_READ_PARAMS,
      ),
    interruptRun: (params) =>
      callDriverMethod(client, DRIVER_METHOD_DESCRIPTORS["driver.interruptRun"], params),
    applyIntervention: (params) =>
      callDriverMethod(client, DRIVER_METHOD_DESCRIPTORS["driver.applyIntervention"], params),
    listModels: (params) =>
      callDriverMethod(client, DRIVER_METHOD_DESCRIPTORS["driver.listModels"], params),
    listModes: () =>
      callDriverMethod(client, DRIVER_METHOD_DESCRIPTORS["driver.listModes"], EMPTY_READ_PARAMS),
    compactContext: (params) =>
      callDriverMethod(client, DRIVER_METHOD_DESCRIPTORS["driver.compactContext"], params),
    listProviderCommands: (params) =>
      callDriverMethod(client, DRIVER_METHOD_DESCRIPTORS["driver.listProviderCommands"], params),
    subscribeEvents: (params) => daemonSubscribeEvents(client, params),
  };
}

// Calls one `driver.*` method by its contract descriptor, so the name and both schemas come from
// the one table the daemon registers from.
function callDriverMethod<RequestType, ResponseType>(
  client: JsonRpcClient,
  descriptor: MethodDescriptor<string, RequestType, ResponseType>,
  params: RequestType,
): Promise<ResponseType> {
  return client.call(
    descriptor.method,
    params,
    descriptor.requestSchema,
    descriptor.responseSchema,
  );
}

/**
 * Open the `driver.subscribeEvents` subscription.
 *
 * Each streamed value is parsed against `DriverEventSchema`. The daemon already filters non-driver
 * events, so the schema only refuses against a daemon whose filter regressed or a peer that widened
 * the stream; the subscription then ends in a `JsonRpcSchemaError` on the `value` phase.
 *
 * Params are validated here because `JsonRpcClient.subscribe` erases them and this function
 * returns its handle synchronously: an unvalidated bad `runId` would give the caller a live-looking
 * handle whose failure only shows at a later `next()`. The refusal is a `JsonRpcSchemaError` on the
 * `params` phase, thrown before any wire write so no daemon state is orphaned.
 */
function daemonSubscribeEvents(
  client: JsonRpcClient,
  params: DriverSubscribeEventsParams,
): LocalSubscriptionConsumer<DriverEvent> {
  const descriptor = DRIVER_EVENT_METHOD_DESCRIPTORS["driver.subscribeEvents"];
  const parsed = descriptor.requestSchema.safeParse(params);
  if (!parsed.success) {
    throw new JsonRpcSchemaError(
      "params",
      `Request params for ${descriptor.method} failed schema validation`,
      parsed.error.issues,
    );
  }

  return client.subscribe<DriverEvent>(descriptor.method, parsed.data, descriptor.emissionSchema);
}
