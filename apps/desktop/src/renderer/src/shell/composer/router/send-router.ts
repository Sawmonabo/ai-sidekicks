// The send router: ONE resolution, and every send path goes through it.
//
// `Spec-023 §Signature Feature Composition Sketches` §The Session Composer: Send
// "resolves to the one wire call the addressed target admits". There is no send
// verb on the wire — a new turn is `run.queueCreate` and a steer is `run.intervene`
// with `type: "steer"` — so Send is a ROUTER, and a second router anywhere in the
// console would be a second answer to "what did that button do".
//
// THREE PROPERTIES ARE STRUCTURAL HERE RATHER THAN CONVENTIONAL.
//
//   1. **Resolution is pure and separate from dispatch.** `resolve` takes text and
//      a target and answers with the request it WOULD send. That is what makes the
//      slash rules, the two-path escape behaviour, and every refusal drivable from
//      a test without a bridge, and it is what lets the surface render the path
//      label ("new turn" / "steer") from the same decision that performs it rather
//      than from a second guess beside it.
//   2. **Every identifier is parsed through the registered schema.** The store
//      holds wire-verbatim strings; `run.queueCreate` and `run.intervene` take
//      branded ids. Parsing here means the console never dispatches a shape the
//      daemon would refuse, and an unparseable id becomes a rendered refusal
//      instead of a rejected round trip.
//   3. **A missing comparand refuses.** `expectedRunVersion` is MANDATORY and
//      fail-closed on the wire (D-004-2). The console has no `run.subscribeState`
//      projection yet, so the comparand is routinely absent — and the answer to an
//      absent stale-replay guard is to refuse, never to send a zero, which would be
//      a guard the caller invented rather than one the daemon verified.
//
// WHAT THIS MODULE DOES NOT DO. It does not decide whether the person MAY send:
// eligibility is the daemon's and reaches the surface as a typed refusal, which
// this module carries through verbatim rather than re-deriving.

import {
  ChannelIdSchema,
  InterruptRunParamsSchema,
  InterventionRequestPayloadSchema,
  QueueItemCreateRequestSchema,
  RunIdSchema,
  SessionIdSchema,
  WorkspaceIdSchema,
  type InterruptRunParams,
  type InterventionRequestPayload,
  type QueueItemCreateRequest,
} from "@ai-sidekicks/contracts";

import type { ConsoleRefusal } from "../../../console/core/index.js";
import type { ConsoleBridge } from "../../../console/bridge/index.js";
import type { ComposerSendPath, ComposerTarget } from "../chips/chip-models.js";
import type { ProviderCatalogEntry } from "../commands/provider-command-catalog.js";
import { LITERAL_SLASH_ESCAPE, readDirectiveName } from "../directive-syntax.js";
import {
  carriedDaemonRefusal,
  composerRefusal,
  unparseableIdentifier,
  type ComposerRefusalCode,
} from "./send-refusals.js";

/** The new-turn arm: a message addressed to a channel. */
export interface ComposerNewTurnResolution {
  readonly outcome: "new-turn";
  readonly request: QueueItemCreateRequest;
}

/** The steer arm: text handed to a run that is already going. */
export interface ComposerSteerResolution {
  readonly outcome: "steer";
  readonly request: InterventionRequestPayload;
}

/**
 * The interception arm: a registered client command.
 *
 * Spec-017's C-18 reserves the slash prefix: a registered command
 * is executed by the client and never composes into a message, a context, or a
 * provider turn on any path. So this arm carries the command's NAME and no request
 * at all: there is nothing for the wire to be handed.
 */
export interface ComposerClientCommandResolution {
  readonly outcome: "client-command";
  readonly commandName: string;
}

export interface ComposerRefusedResolution {
  readonly outcome: "refused";
  readonly refusal: ConsoleRefusal;
}

export type ComposerSendResolution =
  | ComposerNewTurnResolution
  | ComposerSteerResolution
  | ComposerClientCommandResolution
  | ComposerRefusedResolution;

/** What a dispatch settled as. The surface renders exactly one of these. */
export type ComposerSendOutcome =
  | { readonly status: "sent"; readonly path: ComposerSendPath }
  | { readonly status: "intercepted"; readonly commandName: string }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/**
 * Whether a name is a registered client command.
 *
 * A PORT rather than a registry handle: the composer seat is handed a session
 * store, a bridge, a draft store, a route, and a focused pane, and no command
 * registry — so the router takes the one predicate it needs. The default answers
 * `false` for every name, which means an unrecognised `/word` refuses loudly and
 * names the escape, and no text is ever silently sent as prose.
 */
export type ClientCommandPredicate = (commandName: string) => boolean;

/**
 * What the console knows about a name the bound provider published.
 *
 * Narrowed from the catalog's own entry rather than restated, so the three members
 * the refusal reads can never disagree with the list a person read them off.
 */
export type EnumeratedProviderCommand = Pick<ProviderCatalogEntry, "name" | "kind" | "driverName">;

/**
 * Whether a name is one the addressed agent's provider published, for discovery.
 *
 * A SECOND port beside the client-command predicate and deliberately not a widening
 * of it: the two answers lead to opposite acts. A client command is run; a provider
 * entry is refused by name, because `Spec-023 §Signature Feature Composition
 * Sketches` §The Session Composer makes the enumeration a discovery surface — V1
 * sends exactly one enumerated entry, the compaction command, through its own control
 * and never through a typed line. The default answers `undefined` for every name,
 * which leaves a composer with no enumeration behind it saying exactly what it said
 * before this port existed.
 */
export type ProviderCommandPredicate = (
  commandName: string,
) => EnumeratedProviderCommand | undefined;

export interface ComposerSendRouterOptions {
  readonly bridge: ConsoleBridge;
  /** Defaults to recognising none, which is the fail-loud arm rather than the quiet one. */
  readonly recognizeClientCommand?: ClientCommandPredicate;
  /** Defaults to naming none, so an unread enumeration changes no refusal. */
  readonly recognizeProviderCommand?: ProviderCommandPredicate;
  /**
   * Mints the per-request idempotency key the wire requires as a UUID.
   *
   * Injected so a test can pin it; the default is the platform's own generator
   * rather than a hand-rolled one, because a weak key would defeat the
   * `UNIQUE(target_run_id, client_idempotency_key)` replay guard it exists for.
   */
  readonly mintIdempotencyKey?: () => string;
}

/** The wire method a new turn is queued through. */
const QUEUE_CREATE_METHOD = "run.queueCreate";

/** The wire method every intervention travels, steer included. */
const INTERVENE_METHOD = "run.intervene";

/** The wire method a stop travels. Reachable during any active turn. */
const INTERRUPT_RUN_METHOD = "driver.interruptRun";

export class ComposerSendRouter {
  readonly #bridge: ConsoleBridge;
  readonly #recognizeClientCommand: ClientCommandPredicate;
  readonly #recognizeProviderCommand: ProviderCommandPredicate;
  readonly #mintIdempotencyKey: () => string;

  public constructor(options: ComposerSendRouterOptions) {
    this.#bridge = options.bridge;
    this.#recognizeClientCommand = options.recognizeClientCommand ?? (() => false);
    this.#recognizeProviderCommand = options.recognizeProviderCommand ?? (() => undefined);
    this.#mintIdempotencyKey = options.mintIdempotencyKey ?? (() => crypto.randomUUID());
  }

  /**
   * What this text would do, without doing it.
   *
   * Pure. The surface calls it as the input changes to render the path label, and
   * calls {@link send} with the same text to perform it, so what a person reads
   * above the input is the decision that will actually run.
   */
  public resolve(text: string, target: ComposerTarget): ComposerSendResolution {
    const body = text.trim();
    if (body.length === 0) {
      return refused(
        "empty-message",
        "There is nothing to send yet. Type a message, or press Stop to interrupt the running turn.",
      );
    }
    const slashOutcome = this.#resolveSlashPrefix(body, target);
    if (slashOutcome !== undefined) {
      return slashOutcome;
    }
    // The escape's single strip, in one place rather than once per branch below.
    const sendableBody = body.startsWith(LITERAL_SLASH_ESCAPE) ? body.slice(1) : body;
    return target.path === "channel-message"
      ? this.#resolveNewTurn(sendableBody, target)
      : this.#resolveSteer(sendableBody, target);
  }

  /**
   * Resolve, then dispatch.
   *
   * The one place a composed message reaches the wire. A refusal — this module's or
   * the daemon's — comes back as a value rather than a rejection, because a refused
   * send is an ordinary answer the surface renders beside the control that was
   * pressed, not an exception the surface has to catch to stay alive.
   */
  public async send(text: string, target: ComposerTarget): Promise<ComposerSendOutcome> {
    const resolution = this.resolve(text, target);
    switch (resolution.outcome) {
      case "refused":
        return { status: "refused", refusal: resolution.refusal };
      case "client-command":
        return { status: "intercepted", commandName: resolution.commandName };
      case "new-turn":
        return await this.#dispatch(QUEUE_CREATE_METHOD, resolution.request, "channel-message");
      case "steer":
        return await this.#dispatch(INTERVENE_METHOD, resolution.request, "provider-bound");
    }
  }

  /**
   * Stop the addressed run.
   *
   * Reachable during any active turn regardless of what is in the input, which is
   * why it is its own method and takes no text: a person interrupting a turn is not
   * composing one, and gating Stop on a valid draft would put the control behind
   * exactly the state it exists to escape.
   *
   * What the cut removed is daemon-supplied and arrives on the run's own lifecycle
   * rows; nothing here derives a cut position.
   */
  public async stop(target: ComposerTarget): Promise<ComposerSendOutcome> {
    if (target.path !== "provider-bound") {
      return {
        status: "refused",
        refusal: composerRefusal(
          "no-running-turn",
          "There is no running turn addressed here to stop.",
        ),
      };
    }
    const runId = RunIdSchema.safeParse(target.targetRunId);
    if (!runId.success) {
      return { status: "refused", refusal: unparseableIdentifier("the run") };
    }
    const params = InterruptRunParamsSchema.safeParse({
      runId: runId.data,
    } satisfies InterruptRunParams);
    if (!params.success) {
      return { status: "refused", refusal: unparseableIdentifier("the run") };
    }
    return await this.#dispatch(INTERRUPT_RUN_METHOD, params.data, "provider-bound");
  }

  /**
   * The slash rules, both paths (Spec-017's C-18 — the reserved slash prefix).
   *
   * Returns `undefined` when the text carries no leading slash at all, which is the
   * ordinary case and the only one that continues to a send. Silent fall-through to
   * prose never happens: every leading-slash branch below either intercepts,
   * escapes deliberately, or refuses loudly.
   */
  #resolveSlashPrefix(body: string, target: ComposerTarget): ComposerSendResolution | undefined {
    if (!body.startsWith("/")) {
      return undefined;
    }
    const commandName = readDirectiveName(body);
    if (target.path === "provider-bound") {
      // Every leading slash, the escape included. The provider-bound transport is
      // the one whose own input surface parses client-side commands, so an escape
      // that worked on the channel path would be an escape into a parser this
      // console does not control. The copy carries no internal id.
      return (
        this.#resolveDiscoveryOnly(commandName) ??
        refused(
          "slash-prefix-unsupported",
          "Text that begins with a slash cannot be sent to a running turn yet. Remove the leading slash, or address this message to the channel instead.",
        )
      );
    }
    if (commandName === undefined) {
      // The literal-slash escape: a message that really begins with a slash.
      return undefined;
    }
    if (commandName.length > 0 && this.#recognizeClientCommand(commandName)) {
      return { outcome: "client-command", commandName };
    }
    return (
      this.#resolveDiscoveryOnly(commandName) ??
      refused(
        "unknown-command",
        `No command by that name is registered. Type ${LITERAL_SLASH_ESCAPE} to send a message that really starts with a slash.`,
      )
    );
  }

  /**
   * The refusal for a name the bound provider published, or `undefined` for any
   * other name.
   *
   * NAMED RATHER THAN SENT. The enumeration is a discovery surface: this console does
   * not dispatch a provider command from the line on any path, and the person who
   * typed one read it off a list this composer showed them — so the refusal says what
   * the entry is, rather than telling them to check their spelling (which was right)
   * or to address the channel (which would not run it either).
   */
  #resolveDiscoveryOnly(commandName: string | undefined): ComposerSendResolution | undefined {
    if (commandName === undefined || commandName.length === 0) {
      return undefined;
    }
    const published = this.#recognizeProviderCommand(commandName);
    if (published === undefined) {
      return undefined;
    }
    return refused(
      "provider-command-discovery-only",
      `${published.name} is a ${published.kind} the bound ${published.driverName} provider publishes, and this console lists those for discovery only. Nothing was sent.`,
    );
  }

  #resolveNewTurn(body: string, target: ComposerTarget): ComposerSendResolution {
    if (target.path !== "channel-message") {
      return refused("identifier-unparseable", "This message is not addressed to a channel.");
    }
    const sessionId = SessionIdSchema.safeParse(target.sessionId);
    if (!sessionId.success) {
      return { outcome: "refused", refusal: unparseableIdentifier("the session") };
    }
    const channelId =
      target.channelId === undefined ? undefined : ChannelIdSchema.safeParse(target.channelId);
    if (channelId !== undefined && !channelId.success) {
      return { outcome: "refused", refusal: unparseableIdentifier("the channel") };
    }
    const workspaceId =
      target.workspaceId === undefined
        ? undefined
        : WorkspaceIdSchema.safeParse(target.workspaceId);
    if (workspaceId !== undefined && !workspaceId.success) {
      return { outcome: "refused", refusal: unparseableIdentifier("the workspace") };
    }
    const request = QueueItemCreateRequestSchema.safeParse({
      sessionId: sessionId.data,
      ...(channelId === undefined ? {} : { channelId: channelId.data }),
      ...(workspaceId === undefined ? {} : { workspaceId: workspaceId.data }),
      payload: { content: body },
    } satisfies QueueItemCreateRequest);
    if (!request.success) {
      return { outcome: "refused", refusal: unparseableIdentifier("this message") };
    }
    return { outcome: "new-turn", request: request.data };
  }

  #resolveSteer(body: string, target: ComposerTarget): ComposerSendResolution {
    if (target.path !== "provider-bound") {
      return refused("identifier-unparseable", "This message is not addressed to a running turn.");
    }
    if (target.expectedRunVersion === undefined) {
      return refused(
        "run-version-unread",
        "The console has not read this run's current version, so a steer cannot be guarded against a turn that has already moved on. Reopen the run and try again.",
      );
    }
    const runId = RunIdSchema.safeParse(target.targetRunId);
    if (!runId.success) {
      return { outcome: "refused", refusal: unparseableIdentifier("the run") };
    }
    const request = InterventionRequestPayloadSchema.safeParse({
      type: "steer",
      targetRunId: runId.data,
      expectedRunVersion: target.expectedRunVersion,
      clientIdempotencyKey: this.#mintIdempotencyKey(),
      content: body,
    } satisfies InterventionRequestPayload);
    if (!request.success) {
      return { outcome: "refused", refusal: unparseableIdentifier("this steer") };
    }
    return { outcome: "steer", request: request.data };
  }

  /**
   * Hand one already-validated request to the daemon.
   *
   * THE BRAND CAST IS HERE AND NOWHERE ELSE. `daemon.call<M extends DaemonMethod>`
   * takes a `never`-shaped brand until Plan-007 narrows it to the real method-name
   * union, so no string literal is structurally assignable to it. The method name
   * stays loosely `string` — the genuinely untypeable part — while the params keep
   * their registered contract type, which is the tightening the shipped
   * `session-members/participant-roster.tsx` precedent settled on. One documented
   * bypass for the whole composer rather than one per call site.
   */
  async #dispatch(
    method: string,
    params: QueueItemCreateRequest | InterventionRequestPayload | InterruptRunParams,
    path: ComposerSendPath,
  ): Promise<ComposerSendOutcome> {
    const call = this.#bridge.sidekicks.daemon.call as (
      method: string,
      params: QueueItemCreateRequest | InterventionRequestPayload | InterruptRunParams,
    ) => Promise<unknown>;
    try {
      await call(method, params);
      return { status: "sent", path };
    } catch (cause) {
      return { status: "refused", refusal: carriedDaemonRefusal(cause) };
    }
  }
}

/** One composer-side refusal, already wrapped in the resolution's refused arm. */
function refused(code: ComposerRefusalCode, detail: string): ComposerRefusedResolution {
  return { outcome: "refused", refusal: composerRefusal(code, detail) };
}
