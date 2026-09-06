// Which daemon methods the console calls, and the registered shapes each one
// carries in both directions.
//
// WHY A REGISTRY AND NOT A PARSE AT EACH CALL SITE. `SidekicksBridge.daemon.call`
// is one generic door: a branded method name in, `unknown` out, until Plan-007
// lands its own method-to-result mapping. Every caller therefore has to widen the
// signature and then narrow the reply, and a caller that widens and forgets to
// narrow gets a fulfilled promise carrying `unknown` — which reads as success. The
// console has already shipped that mistake in three independent shapes: a reply
// cast to the response type with no parse at all, a mutation typed `void` whose
// registered reply carries members the surface needed, and a per-family helper that
// parsed correctly and had to be written a third time to do it. One table, keyed by
// method name, is what makes the parse unskippable rather than merely available.
//
// THE SET IS CLOSED, AND IT IS CLOSED TWICE OVER. `ConsoleDaemonMethodContract`
// enumerates the methods; `CONSOLE_DAEMON_METHOD_BINDINGS` is annotated as a total
// map over that enumeration's keys, so a method named in one and not the other does
// not compile — a missing key is a missing-property error and a stray key is an
// excess-property error on the object literal. That is deliberately a COMPILE-time
// claim: a registry that answered `undefined` for an unknown method would push the
// failure to whichever surface called it first, at runtime, on the one path nobody
// exercises.
//
// WHAT IS IN THE SET, STATED AS AN ADMISSION RULE. A method belongs here when a
// console surface calls it, `@ai-sidekicks/contracts` publishes BOTH its request and
// its response shape, and `Plan-023`'s growth slate does not claim it. All three
// conjuncts do work. Without the second there is nothing to parse against and the
// registry would be inventing shapes. Without the third the console would hold two
// answers for one method — `session.read` has published payloads AND a growth row,
// because the row bundles it with a directory read no document registers at all, so
// it stays the growth port's and is deliberately absent here. That disjointness is
// asserted, not asserted-by-convention: `daemon-reply-registry.test.ts` holds this
// table against the growth ledger's own `expectedWireMethod` column.
//
// A method whose wire the corpus has not registered belongs to the growth port next
// door (`growth-port.ts`), which refuses by name and says who owes the wire. The two
// seams and the line between them are described in `daemon-reply.ts`'s header.
//
// WHAT IS NOT IN THE SET. Subscriptions. `daemon.subscribe` names a stream rather
// than a call and answers with an unsubscribe handle, so it has no reply to bind;
// which names are streams and what each carries is `session-event-streams.ts`'s
// table, and duplicating those names here would be a second answer to a question
// that already has one.

import {
  DriverAckResultSchema,
  DriverCompactionResultSchema,
  DriverReadParamsSchema,
  InterruptRunParamsSchema,
  ListCapabilitiesResultSchema,
  ListModelsResultSchema,
  ListProviderCommandsRequestSchema,
  ProviderCommandListResultSchema,
  CompactContextRequestSchema,
  ChannelListRequestSchema,
  ChannelListResponseSchema,
  ExecutionModeSelectRequestSchema,
  ExecutionModeSelectResponseSchema,
  InterventionRequestPayloadSchema,
  InterventionRequestResponseSchema,
  InviteRevokeResponseSchema,
  InviteRevokeSchema,
  MembershipUpdateResponseSchema,
  MembershipUpdateSchema,
  PresenceReadRequestSchema,
  PresenceReadResponseSchema,
  ProviderAccountListRequestSchema,
  ProviderAccountListResponseSchema,
  ProviderAccountProbeRequestSchema,
  ProviderAccountProbeResponseSchema,
  QueueItemCancelRequestSchema,
  QueueItemCancelResponseSchema,
  QueueItemCreateRequestSchema,
  QueueItemCreateResponseSchema,
  QueueItemListRequestSchema,
  QueueItemListResponseSchema,
  RepoMountReadRequestSchema,
  RepoMountReadResponseSchema,
  RunControlAckSchema,
  RunPauseRequestSchema,
  RunResumeRequestSchema,
  SessionCreateRequestSchema,
  SessionCreateResponseSchema,
  SessionJoinRequestSchema,
  SessionJoinResponseSchema,
  WorkspaceExecutionModeCapabilitiesReadRequestSchema,
  WorkspaceExecutionModeCapabilitiesReadResponseSchema,
  WorkspaceListRequestSchema,
  WorkspaceListResponseSchema,
  WorktreeStatusReadRequestSchema,
  WorktreeStatusReadResponseSchema,
} from "@ai-sidekicks/contracts";

import type { ZodType } from "@ai-sidekicks/contracts";

import type { ConsoleDaemonMethodContract } from "./daemon-method-contract.js";

/** One registered daemon method the console calls. The console's whole call set. */
export type ConsoleDaemonMethod = keyof ConsoleDaemonMethodContract;

/** What the console sends for one method. */
export type DaemonRequestOf<MethodName extends ConsoleDaemonMethod> =
  ConsoleDaemonMethodContract[MethodName]["request"];

/** What the corpus registers as that method's reply. */
export type DaemonResponseOf<MethodName extends ConsoleDaemonMethod> =
  ConsoleDaemonMethodContract[MethodName]["response"];

/**
 * The two schemas one method is bound to.
 *
 * BOTH directions, because both are places a shape can be wrong and only one of
 * them costs a round trip to find out. A request the daemon would refuse is refused
 * here instead, before anything is sent; a reply the contract does not admit is a
 * refusal rather than a value nobody checked.
 *
 * Typed against the contracts package's re-exported `ZodType` rather than an import
 * from `zod`, which is what lets every module above this one stay free of the
 * dependency — the property the lint rule in `apps/desktop/eslint.config.mjs`
 * enforces.
 */
export interface DaemonMethodBinding<TRequest, TResponse> {
  readonly requestSchema: ZodType<TRequest>;
  readonly responseSchema: ZodType<TResponse>;
}

/** The registry's shape: one binding per method, no method without one. */
export type ConsoleDaemonMethodBindings = {
  readonly [MethodName in ConsoleDaemonMethod]: DaemonMethodBinding<
    DaemonRequestOf<MethodName>,
    DaemonResponseOf<MethodName>
  >;
};

/**
 * Bind one method's two schemas, frozen.
 *
 * A factory rather than eighteen object literals so the table below reads as a
 * table, and so the freeze is not something a row can forget. Frozen because this
 * is a registry and not a builder: a module that could re-point
 * `CONSOLE_DAEMON_METHOD_BINDINGS["run.pause"].requestSchema` at start-up would be
 * able to change what the console will send on a method without touching either the
 * method's own row or the contract that owns the shape.
 */
function bindDaemonMethod<TRequest, TResponse>(
  requestSchema: ZodType<TRequest>,
  responseSchema: ZodType<TResponse>,
): DaemonMethodBinding<TRequest, TResponse> {
  return Object.freeze({ requestSchema, responseSchema });
}

/**
 * The method-to-schema table — the code-side mirror of the corpus's own registry.
 *
 * The annotation is what makes this exhaustive in BOTH directions: a method added
 * to `ConsoleDaemonMethodContract` is a missing-property error here until it is
 * bound, and a row for a method the contract does not name is an excess-property
 * error. Pairing the wrong schema with a method is a type error too, because the
 * annotation fixes each row's request and response types from the method key.
 */
export const CONSOLE_DAEMON_METHOD_BINDINGS: ConsoleDaemonMethodBindings = Object.freeze({
  "run.queueCreate": bindDaemonMethod(QueueItemCreateRequestSchema, QueueItemCreateResponseSchema),
  "run.queueList": bindDaemonMethod(QueueItemListRequestSchema, QueueItemListResponseSchema),
  "run.queueCancel": bindDaemonMethod(QueueItemCancelRequestSchema, QueueItemCancelResponseSchema),
  "run.pause": bindDaemonMethod(RunPauseRequestSchema, RunControlAckSchema),
  "run.resume": bindDaemonMethod(RunResumeRequestSchema, RunControlAckSchema),
  "run.intervene": bindDaemonMethod(
    InterventionRequestPayloadSchema,
    InterventionRequestResponseSchema,
  ),
  "driver.interruptRun": bindDaemonMethod(InterruptRunParamsSchema, DriverAckResultSchema),
  "driver.compactContext": bindDaemonMethod(
    CompactContextRequestSchema,
    DriverCompactionResultSchema,
  ),
  "driver.listProviderCommands": bindDaemonMethod(
    ListProviderCommandsRequestSchema,
    ProviderCommandListResultSchema,
  ),
  "driver.listCapabilities": bindDaemonMethod(DriverReadParamsSchema, ListCapabilitiesResultSchema),
  "driver.listModels": bindDaemonMethod(DriverReadParamsSchema, ListModelsResultSchema),
  "repo.mountRead": bindDaemonMethod(RepoMountReadRequestSchema, RepoMountReadResponseSchema),
  "repo.workspaceList": bindDaemonMethod(WorkspaceListRequestSchema, WorkspaceListResponseSchema),
  "repo.executionModeCapabilitiesRead": bindDaemonMethod(
    WorkspaceExecutionModeCapabilitiesReadRequestSchema,
    WorkspaceExecutionModeCapabilitiesReadResponseSchema,
  ),
  "repo.executionModeSelect": bindDaemonMethod(
    ExecutionModeSelectRequestSchema,
    ExecutionModeSelectResponseSchema,
  ),
  "repo.worktreeStatusRead": bindDaemonMethod(
    WorktreeStatusReadRequestSchema,
    WorktreeStatusReadResponseSchema,
  ),
  "session.create": bindDaemonMethod(SessionCreateRequestSchema, SessionCreateResponseSchema),
  "session.join": bindDaemonMethod(SessionJoinRequestSchema, SessionJoinResponseSchema),
  "channel.list": bindDaemonMethod(ChannelListRequestSchema, ChannelListResponseSchema),
  "membership.update": bindDaemonMethod(MembershipUpdateSchema, MembershipUpdateResponseSchema),
  "presence.read": bindDaemonMethod(PresenceReadRequestSchema, PresenceReadResponseSchema),
  "invite.revoke": bindDaemonMethod(InviteRevokeSchema, InviteRevokeResponseSchema),
  "providerAccount.list": bindDaemonMethod(
    ProviderAccountListRequestSchema,
    ProviderAccountListResponseSchema,
  ),
  "providerAccount.probe": bindDaemonMethod(
    ProviderAccountProbeRequestSchema,
    ProviderAccountProbeResponseSchema,
  ),
});

/**
 * Every method string in the registry, as data.
 *
 * `Object.keys` of the frozen table above rather than a second list, so the census
 * a test walks and the table a call resolves through cannot disagree. The narrowing
 * is sound because the table's keys ARE `ConsoleDaemonMethod` by annotation.
 */
export const CONSOLE_DAEMON_METHODS: readonly ConsoleDaemonMethod[] = Object.freeze(
  Object.keys(CONSOLE_DAEMON_METHOD_BINDINGS) as ConsoleDaemonMethod[],
);

/**
 * The binding for one method name known only at runtime, or `undefined`.
 *
 * The one lookup that admits an arbitrary string, and it exists for exactly one
 * caller: the fixture bridge, which is handed a call name by a scenario rather than
 * by a typed call site and has to decide whether the corpus registers a shape for
 * it. Every other consumer reaches the table through `ConsoleDaemonMethod`, where
 * the lookup cannot miss.
 */
export function daemonMethodBindingFor(
  method: string,
): DaemonMethodBinding<unknown, unknown> | undefined {
  return Object.hasOwn(CONSOLE_DAEMON_METHOD_BINDINGS, method)
    ? (CONSOLE_DAEMON_METHOD_BINDINGS[method as ConsoleDaemonMethod] as DaemonMethodBinding<
        unknown,
        unknown
      >)
    : undefined;
}
