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
//   4. **A fulfilled call is not a successful send.** Both send paths answer with a
//      registered response, and this module used to treat any reply that did not
//      throw as "sent". `run.intervene` answers with a lifecycle STATE, and two of
//      the six mean the run did not take the message, so a normally rejected steer
//      cleared the participant's draft as if it had landed; the response is parsed
//      against its registered shape and the state decides, and the answer's
//      `runVersion` is kept — an applied native steer advances the run version with
//      no state event to broadcast it, so the response is the only place the fresh
//      comparand exists and a second steer was guaranteed to be refused as stale
//      without it. `run.queueCreate` answers with the queued item, and a reply that
//      is not the registered shape confirms no queued message at all — a
//      protocol-version mismatch used to clear the draft on one. Only the stop is
//      settled by fulfilment alone, and that is a property of its contract rather
//      than a shortcut: `driver.interruptRun` answers with `DriverAckResult`, which
//      is the empty object, so there is no member a reply could carry for a parse
//      to read.
//
// TRIMMING IS A TEST AND NEVER A TRANSFORM. This module used to resolve against
// `text.trim()` and hand that trimmed value to both request builders, so the daemon
// received text the participant did not author: pasted code lost its indentation, an
// indentation-sensitive instruction lost its shape, and a deliberately separated
// Markdown block lost its separation. Blankness is still decided by trimming — that
// is a question about the text, not an edit of it — and everything that reaches the
// wire is the participant's own bytes. The slash rules read the RAW text through
// `directive-syntax.ts` for the same reason, which narrows them deliberately: a
// command opens its line, and indented text beginning with a slash is prose.
//
// WHAT THIS MODULE DOES NOT DO. It does not decide whether the person MAY send:
// eligibility is the daemon's and reaches the surface as a typed refusal, which
// this module carries through verbatim rather than re-deriving.

import {
  ChannelIdSchema,
  InterruptRunParamsSchema,
  InterventionRequestPayloadSchema,
  InterventionRequestResponseSchema,
  QueueItemCreateRequestSchema,
  QueueItemCreateResponseSchema,
  RunIdSchema,
  SessionIdSchema,
  WorkspaceIdSchema,
  type InterruptRunParams,
  type InterventionRequestPayload,
  type InterventionState,
  type QueueItemCreateRequest,
} from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "../../../console/bridge/index.js";
import type { ComposerTarget } from "../chips/chip-models.js";
import {
  LITERAL_SLASH_ESCAPE,
  opensDirectiveLine,
  readDirectiveName,
  stripLiteralSlashEscape,
} from "../directive-syntax.js";
import type {
  ClientCommandPredicate,
  ComposerRefusedResolution,
  ComposerSendOutcome,
  ComposerSendResolution,
  ProviderCommandPredicate,
} from "./send-resolutions.js";
import {
  carriedDaemonRefusal,
  composerRefusal,
  interventionNotApplied,
  unparseableIdentifier,
  unreadableInterventionReply,
  unreadableQueueReply,
  type ComposerRefusalCode,
} from "./send-refusals.js";
import { RunVersionLedger } from "./run-version-ledger.js";

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
  /**
   * Where the comparands the daemon has answered are kept.
   *
   * Supplied rather than owned because this class is rebuilt whenever the command
   * zone's predicates change identity — which the addressed target does on every
   * store notification — and a ledger inside it would be emptied between two steers,
   * which is exactly the interval it exists to bridge. A router built without one
   * gets its own, so a caller that has no second steer to make needs no wiring.
   */
  readonly runVersions?: RunVersionLedger;
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
  readonly #runVersions: RunVersionLedger;

  public constructor(options: ComposerSendRouterOptions) {
    this.#bridge = options.bridge;
    this.#recognizeClientCommand = options.recognizeClientCommand ?? (() => false);
    this.#recognizeProviderCommand = options.recognizeProviderCommand ?? (() => undefined);
    this.#mintIdempotencyKey = options.mintIdempotencyKey ?? (() => crypto.randomUUID());
    this.#runVersions = options.runVersions ?? new RunVersionLedger();
  }

  /**
   * What this text would do, without doing it.
   *
   * Pure. The surface calls it as the input changes to render the path label, and
   * calls {@link send} with the same text to perform it, so what a person reads
   * above the input is the decision that will actually run.
   */
  public resolve(text: string, target: ComposerTarget): ComposerSendResolution {
    // The one place trimming appears, and it decides nothing but blankness: the
    // value below is never what gets sent.
    if (text.trim().length === 0) {
      return refused(
        "empty-message",
        "There is nothing to send yet. Type a message, or press Stop to interrupt the running turn.",
      );
    }
    const slashOutcome = this.#resolveSlashPrefix(text, target);
    if (slashOutcome !== undefined) {
      return slashOutcome;
    }
    // The escape's single strip, in one place rather than once per branch below.
    const sendableBody = stripLiteralSlashEscape(text);
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
        return await this.#dispatchQueuedTurn(resolution.request);
      case "steer":
        return await this.#dispatchIntervention(resolution.request);
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
    return await this.#dispatchInterrupt(params.data);
  }

  /**
   * The slash rules, both paths (Spec-017's C-18 — the reserved slash prefix).
   *
   * Returns `undefined` when the text carries no leading slash at all, which is the
   * ordinary case and the only one that continues to a send. Silent fall-through to
   * prose never happens: every leading-slash branch below either intercepts,
   * escapes deliberately, or refuses loudly.
   *
   * Both questions — is this line claimed, and what does it name — are asked of
   * `directive-syntax.ts` rather than answered here with a prefix test of this
   * module's own. The discovery popover asks the same module, so a line the list
   * opens on and a line this path acts on are one decision rather than two that
   * agree until somebody edits one of them.
   */
  #resolveSlashPrefix(body: string, target: ComposerTarget): ComposerSendResolution | undefined {
    if (!opensDirectiveLine(body)) {
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
    // The store's projection and the daemon's last answer, reconciled: neither is
    // the fresher on its own, and after an applied native steer only the answer has
    // moved.
    const expectedRunVersion = this.#runVersions.comparandFor(
      target.targetRunId,
      target.expectedRunVersion,
    );
    if (expectedRunVersion === undefined) {
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
      expectedRunVersion,
      clientIdempotencyKey: this.#mintIdempotencyKey(),
      content: body,
    } satisfies InterventionRequestPayload);
    if (!request.success) {
      return { outcome: "refused", refusal: unparseableIdentifier("this steer") };
    }
    return { outcome: "steer", request: request.data };
  }

  /**
   * Dispatch the stop, whose fulfilment IS the settlement.
   *
   * The one send path with nothing to read back, and that is its CONTRACT rather
   * than a shortcut: `driver.interruptRun` answers with `DriverAckResult`, which the
   * registered schema declares as the empty object. A parse here would assert that
   * `{}` is `{}` and would tell a person nothing a rejection has not already told
   * them.
   */
  async #dispatchInterrupt(params: InterruptRunParams): Promise<ComposerSendOutcome> {
    try {
      await this.#call(INTERRUPT_RUN_METHOD, params);
      return { status: "sent", path: "provider-bound" };
    } catch (cause) {
      return { status: "refused", refusal: carriedDaemonRefusal(cause) };
    }
  }

  /**
   * Dispatch one new turn, and READ what came back.
   *
   * The steer path's rule on the other send. `run.queueCreate` answers with the
   * registered `QueueItemCreateResponse` — the item's id, its state, and when it was
   * created — so a reply that is not that shape is a reply this console can read no
   * queued message out of, which is what a protocol-version mismatch produces.
   * Returning it as sent cleared the participant's draft on the strength of a
   * payload nothing had understood.
   *
   * The parsed value is deliberately not KEPT. Nothing in the composer addresses a
   * queue item — the shelf reads the queue from its own subscription — so what the
   * parse buys is the confirmation itself and not a member to carry forward.
   */
  async #dispatchQueuedTurn(request: QueueItemCreateRequest): Promise<ComposerSendOutcome> {
    let reply: unknown;
    try {
      reply = await this.#call(QUEUE_CREATE_METHOD, request);
    } catch (cause) {
      return { status: "refused", refusal: carriedDaemonRefusal(cause) };
    }
    if (!QueueItemCreateResponseSchema.safeParse(reply).success) {
      return { status: "refused", refusal: unreadableQueueReply() };
    }
    return { status: "sent", path: "channel-message" };
  }

  /**
   * Dispatch one steer, and READ what came back.
   *
   * Its own path rather than an argument to the one above, because the two settle
   * differently: `run.queueCreate` and `driver.interruptRun` are answered or refused,
   * and `run.intervene` is answered with a LIFECYCLE STATE that may say the run
   * declined the message. Folding that into the shared path would have made the
   * decision a flag, and the arm nobody sets is the arm a person meets.
   *
   * The reply is parsed against its registered shape before anything is read off it,
   * and the version is kept from EVERY parsed response — a refusal answers with the
   * run's current version too, which is what lets the next attempt guard itself
   * without a re-read the console has no projection to perform.
   */
  async #dispatchIntervention(request: InterventionRequestPayload): Promise<ComposerSendOutcome> {
    let reply: unknown;
    try {
      reply = await this.#call(INTERVENE_METHOD, request);
    } catch (cause) {
      return { status: "refused", refusal: carriedDaemonRefusal(cause) };
    }
    const parsed = InterventionRequestResponseSchema.safeParse(reply);
    if (!parsed.success) {
      return { status: "refused", refusal: unreadableInterventionReply() };
    }
    this.#runVersions.record(request.targetRunId, parsed.data.runVersion);
    if (!isInterventionAdmitted(parsed.data.state)) {
      return {
        status: "refused",
        refusal: interventionNotApplied(parsed.data.state, parsed.data.rejectionReason),
      };
    }
    return { status: "sent", path: "provider-bound" };
  }

  /**
   * Hand one already-validated request to the daemon, brand cast and all.
   *
   * THE BRAND CAST IS HERE AND NOWHERE ELSE. `daemon.call<M extends DaemonMethod>`
   * takes a `never`-shaped brand until Plan-007 narrows it to the real method-name
   * union, so no string literal is structurally assignable to it. The method name
   * stays loosely `string` — the genuinely untypeable part — while the params keep
   * their registered contract type, which is the tightening the shipped
   * `session-members/participant-roster.tsx` precedent settled on. One documented
   * bypass for the whole composer rather than one per call site.
   */
  async #call(
    method: string,
    params: QueueItemCreateRequest | InterventionRequestPayload | InterruptRunParams,
  ): Promise<unknown> {
    const call = this.#bridge.sidekicks.daemon.call as (
      method: string,
      params: QueueItemCreateRequest | InterventionRequestPayload | InterruptRunParams,
    ) => Promise<unknown>;
    return await call(method, params);
  }
}

/**
 * Whether an intervention state means the composed text reached the run.
 *
 * A total switch over the registered union rather than a list, so a seventh state
 * has to be classified rather than falling into whichever arm was written last.
 * `Queue And Intervention Model §Intervention State Transition Table` is what
 * decides each one: `requested` and `accepted` are admissions the daemon will act
 * on, `applied` is the provider confirming the effect, and `degraded` is the
 * orchestration layer having fallen back — the message travelled on all four. Only
 * `rejected` (refused before dispatch) and `expired` (the version guard, or the run
 * moving between accept and apply) leave the participant's words unsent, and those
 * are the two that keep the draft.
 */
function isInterventionAdmitted(state: InterventionState): boolean {
  switch (state) {
    case "requested":
    case "accepted":
    case "applied":
    case "degraded":
      return true;
    case "rejected":
    case "expired":
      return false;
  }
}

/** One composer-side refusal, already wrapped in the resolution's refused arm. */
function refused(code: ComposerRefusalCode, detail: string): ComposerRefusedResolution {
  return { outcome: "refused", refusal: composerRefusal(code, detail) };
}
