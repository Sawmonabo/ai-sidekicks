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
// `compactContext` is addressed by session and carries no binding: the daemon resolves the live
// binding itself instead of trusting the renderer.
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
  DriverInterventionResult,
  InterruptRunParams,
} from "@ai-sidekicks/contracts/provider/driver/intervention";
import type {
  CompactContextRequest,
  DriverReadParams,
  DriverSubscribeEventsParams,
  ListCapabilitiesResult,
  ListModelsRequest,
  ListModelsResult,
  ListModesResult,
} from "@ai-sidekicks/contracts/provider/driver/methods";
import type { EmptyPayload } from "@ai-sidekicks/contracts/method-descriptor";
import type { DriverCompactionResult } from "@ai-sidekicks/contracts/provider/driver/transcript";
import type { DriverEvent } from "@ai-sidekicks/contracts/provider/driver/event";
import { DRIVER_EVENT_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/provider/driver/event";
import { DRIVER_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/provider/driver/methods";

import { callMethod, subscribeMethod, type JsonRpcClient } from "./transport/json-rpc-client.js";
import type { LocalSubscriptionConsumer } from "./transport/contract.js";

/** The request the two no-arg reads send, frozen so no caller can alter what a later call sends. */
const EMPTY_READ_PARAMS: DriverReadParams = Object.freeze({});

/**
 * The client-facing driver surface: six request/response verbs plus `subscribeEvents`.
 *
 * `compactContext` and `applyIntervention` resolve refusals as values: a `refused` or `failed`
 * compaction (including the daemon's `not_permitted`) and a `degraded` intervention are data a
 * caller branches on. Only address, liveness and capability refusals (`session.not_found`,
 * `run.not_found`, `agent.not_found`, `driver.unavailable`, `driver.capability_unsupported`)
 * arrive as `JsonRpcRemoteError`.
 *
 * `interruptRun` resolves the empty `EmptyPayload`, a genuine success value: the daemon answers
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
  interruptRun(params: InterruptRunParams): Promise<EmptyPayload>;

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
   * Open a subscription to one run's driver event stream.
   *
   * The value type is `DriverEvent`, the contracts-owned union over the six driver-event
   * categories, so a caller never has to handle an approval or audit event on a driver stream.
   * The daemon already filters non-driver events, so a refused value means its filter regressed
   * or a peer widened the stream; the subscription then ends in a `value`-phase
   * `JsonRpcSchemaError`.
   *
   * @throws JsonRpcSchemaError when `params` fail the request schema (a bad `runId`), from this
   *   call and before anything is sent, so no daemon state is orphaned.
   */
  subscribeEvents(params: DriverSubscribeEventsParams): LocalSubscriptionConsumer<DriverEvent>;
}

/**
 * Build a `DriverClient` over a daemon transport.
 *
 * The caller owns the `ClientTransport` and the `JsonRpcClient`, and must complete the
 * `daemon.hello` handshake before the first mutating call. The daemon marks `interruptRun`,
 * `applyIntervention` and `compactContext` as mutating and the other three methods as not, so a
 * version-mismatched connection keeps the reads and loses exactly the three verbs that drive a run.
 *
 * The daemon's reply is the return value, unwrapped and unchanged. A daemon-side refusal surfaces
 * as `JsonRpcRemoteError` carrying the registered dotted code.
 */
export function createDaemonProviderClient(client: JsonRpcClient): DriverClient {
  return {
    listCapabilities: () =>
      callMethod(client, DRIVER_METHOD_DESCRIPTORS["driver.listCapabilities"], EMPTY_READ_PARAMS),
    interruptRun: (params) =>
      callMethod(client, DRIVER_METHOD_DESCRIPTORS["driver.interruptRun"], params),
    applyIntervention: (params) =>
      callMethod(client, DRIVER_METHOD_DESCRIPTORS["driver.applyIntervention"], params),
    listModels: (params) =>
      callMethod(client, DRIVER_METHOD_DESCRIPTORS["driver.listModels"], params),
    listModes: () =>
      callMethod(client, DRIVER_METHOD_DESCRIPTORS["driver.listModes"], EMPTY_READ_PARAMS),
    compactContext: (params) =>
      callMethod(client, DRIVER_METHOD_DESCRIPTORS["driver.compactContext"], params),
    subscribeEvents: (params) =>
      subscribeMethod(client, DRIVER_EVENT_METHOD_DESCRIPTORS["driver.subscribeEvents"], params),
  };
}
