// The console's registered daemon call set: which methods, and which shapes.
//
// The declaration half of the reply registry beside it. `daemon-reply-registry.ts`
// owns why the registry exists, how a shape is bound to a method, and the frozen
// table a call resolves through; this owns WHAT IS IN THE SET, which is the half a
// surface's author reads and the half a landing family adds a row to. They are split
// because together they were one file past the package's ceiling, and the seam is the
// one place the two halves do not overlap: nothing here binds a schema, and nothing
// there names a method's shape.

import type {
  ChildRunExpandRequest,
  ChildRunExpandResponse,
  ProviderCommandListResult,
  ListProviderCommandsRequest,
  ListModelsResult,
  ListCapabilitiesResult,
  InterruptRunParams,
  ReasoningSurfaceReadRequest,
  ReasoningSurfaceReadResponse,
  RespondToRequestParams,
  DriverReadParams,
  DriverCompactionResult,
  DriverAckResult,
  CompactContextRequest,
  PresenceReadRequest,
  PresenceReadResponse,
  SessionCreateRequest,
  SessionCreateResponse,
  SessionReadRequest,
  SessionReadResponse,
  TimelineReadRequest,
  TimelineReadResponse,
} from "@ai-sidekicks/contracts";

/**
 * Every registered daemon method a console surface calls, bound to the request it
 * sends and the response the corpus registers for it.
 *
 * Keyed by the method STRING rather than by a symbolic name, so a call site spells
 * the wire's own word and `ConsoleDaemonMethodContract[MethodName]` resolves for a
 * generic parameter. The method strings are quoted verbatim from the payload
 * contracts; nothing here invents one.
 *
 * Grouped by namespace, and within a namespace in the registry table's own row
 * order, so a reader comparing the two reads them top to bottom.
 */
export interface ConsoleDaemonMethodContract {
  // driver — the five client-facing verbs a composer, a run control, or a picker
  // reaches, registered together because they are one plane rather than five
  // decisions. Two of the replies are the empty object and one of the requests is:
  // that is a SHAPE the corpus publishes, so a reply arriving with members is a
  // protocol mismatch this console would otherwise read as a successful stop.
  // `DriverReadParams` is that published empty request and appears on three rows
  // rather than under three aliases, because the corpus registers one params type
  // for every no-argument driver read. `compactContext` is run-addressed and
  // `listProviderCommands` agent-addressed — an agent can hold several live bindings
  // and the daemon fans out, which is why the reply's groups carry the
  // `(driverName, providerAccountId)` each entry was read under — and both replies
  // are unions whose refused and failed arms are DATA a surface branches on rather
  // than rejections it catches. The command enumeration is a live read held for the
  // caller's current target and nothing longer; there is no registry behind it.
  readonly "driver.interruptRun": {
    readonly request: InterruptRunParams;
    readonly response: DriverAckResult;
  };
  readonly "driver.compactContext": {
    readonly request: CompactContextRequest;
    readonly response: DriverCompactionResult;
  };
  readonly "driver.listProviderCommands": {
    readonly request: ListProviderCommandsRequest;
    readonly response: ProviderCommandListResult;
  };
  readonly "driver.listCapabilities": {
    readonly request: DriverReadParams;
    readonly response: ListCapabilitiesResult;
  };
  readonly "driver.listModels": {
    readonly request: DriverReadParams;
    readonly response: ListModelsResult;
  };
  // The answer to a provider-raised ask. The one row whose `response` is `unknown` by
  // contract and deliberately so: the ask's own choice set or the user's free
  // text both travel this member, which is why the input-ask card mints no wire of its
  // own. `DriverAckResult` is the reply — an acknowledgement that the answer reached
  // the driver, never a settlement of the ask, which only the ask's own row may state.
  readonly "driver.respondToRequest": {
    readonly request: RespondToRequestParams;
    readonly response: DriverAckResult;
  };

  // timeline — the run-scoped reasoning surface, whose reply is the CLOSED four-arm
  // availability discriminant. It is here because the corpus registers both shapes:
  // the admission rule the reply registry states is met in all three conjuncts.
  readonly "timeline.reasoningSurfaceRead": {
    readonly request: ReasoningSurfaceReadRequest;
    readonly response: ReasoningSurfaceReadResponse;
  };

  // session and presence — the session plane.
  readonly "session.create": {
    readonly request: SessionCreateRequest;
    readonly response: SessionCreateResponse;
  };
  readonly "session.read": {
    readonly request: SessionReadRequest;
    readonly response: SessionReadResponse;
  };
  readonly "presence.read": {
    readonly request: PresenceReadRequest;
    readonly response: PresenceReadResponse;
  };

  // timeline — the child-run expansion, and the backward read window.
  //
  // The live stream is the store's own subscription rather than a call, so it is not
  // here. The READ is, and only in one direction: a session's stream replays from the
  // position this user was last acknowledged at, so the store's log grows at
  // the tail on its own and has no way at all to reach what came before that
  // position. `beforeCursor` is what asks for it.
  readonly "timeline.childRunExpand": {
    readonly request: ChildRunExpandRequest;
    readonly response: ChildRunExpandResponse;
  };
  /**
   * One bounded window of rows BEFORE a position the console already holds.
   *
   * The forward direction of this same method is deliberately not a caller here: the
   * subscription already delivers it, and a second forward reader would be a second
   * source of truth for a log the reconciler orders. What the ledger's head control
   * sends carries `beforeCursor`, and the reply's own `hasMore` — never a page's
   * fullness and never a cursor's absence — is what says whether rows remain behind
   * it.
   */
  readonly "timeline.read": {
    readonly request: TimelineReadRequest;
    readonly response: TimelineReadResponse;
  };
}
