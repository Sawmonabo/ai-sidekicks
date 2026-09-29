// The send router: ONE resolution, and every send path goes through it.
//
// Send resolves to the one wire call the addressed target admits. There is no send
// verb on the wire — a new turn is `run.queueCreate` and a steer is `run.intervene`
// with `type: "steer"` — so Send is a ROUTER, and a second router anywhere in the
// console would be a second answer to "what did that button do".
//
// THE PROPERTIES BELOW ARE STRUCTURAL HERE RATHER THAN CONVENTIONAL.
//
//   1. **Resolution is pure and separate from dispatch.** `resolve` takes text and
//      a target and answers with the request it WOULD send. That is what makes the
//      slash rules and every refusal drivable from a test without any call, and it
//      is what makes the decision `send` performs the same one a reader can inspect
//      rather than a second guess beside it.
//   2. **Every identifier is read through the bridge family's reader.** The store
//      holds wire-verbatim strings; `run.queueCreate` and `run.intervene` take
//      branded ids. Reading here means the console never dispatches a shape the
//      daemon would refuse, and an unreadable id becomes a rendered refusal
//      instead of a rejected round trip — with a sentence that names WHICH
//      identifier, which is the whole reason the reading happens here at all.
//      The schema itself is imported at the wire's edge and nowhere else, so this
//      module consumes a typed answer and never a validator.
//   3. **A missing comparand refuses.** `expectedRunVersion` is MANDATORY and
//      fail-closed on the wire. The store may not have projected the run's version,
//      so the comparand can be absent — and the answer to an absent stale-replay
//      guard is to refuse, never to send a zero, which would be a guard the caller
//      invented rather than one the daemon verified.
//   4. **A resolved call is not a successful send.** `run.intervene` answers with a
//      lifecycle STATE, and two of the six mean the run did not take it, so the
//      state decides and the answer's `runVersion` is kept — an applied native steer
//      advances the run version with no state event to broadcast it, so the response
//      is the only place the fresh comparand exists and a second steer was
//      guaranteed to be refused as stale without it. `run.queueCreate` settles on the
//      answer itself: it answers with the queued item. A call that rejects is not
//      caught here; it propagates to the caller of `send`.
//
// TRIMMING IS A TEST AND NEVER A TRANSFORM. Blankness is decided by trimming — that
// is a question about the text, not an edit of it — and everything that reaches the
// wire is the user's own bytes, so pasted code keeps its indentation, an
// indentation-sensitive instruction keeps its shape, and a deliberately separated
// Markdown block keeps its separation. The slash rules read the RAW text through
// `directive-syntax.ts` for the same reason, which narrows them deliberately: a
// command opens its line, and indented text beginning with a slash is prose.
//
// WHAT THIS MODULE DOES NOT DO. It does not decide whether the person MAY send:
// eligibility is the daemon's and reaches the surface as a typed refusal, which
// this module carries through verbatim rather than re-deriving.

import type { InterventionRequestPayload, QueueItemCreateRequest } from "@ai-sidekicks/contracts";

import {
  readInterventionRequest,
  readQueueItemCreateRequest,
} from "@renderer/services/daemon/wire-requests.js";
import { readRunId, readSessionId } from "@renderer/services/daemon/wire-identifiers.js";
import type { ComposerChannelTarget, ComposerTarget } from "../composer-target.js";
import { readDirectiveName } from "../slash-command-syntax.js";
import type {
  ClientCommandPredicate,
  ComposerRefusedResolution,
  ComposerSendOutcome,
  ComposerSendResolution,
  ProviderCommandPredicate,
} from "./send-resolutions.js";
import {
  composerRefusal,
  unparseableIdentifier,
  type ComposerRefusalCode,
} from "./send-refusals.js";
import { RunVersionLedger } from "./answered-run-versions.js";
import {
  dispatchIntervention,
  dispatchQueuedTurn,
  type ComposerSendCalls,
} from "./send-dispatch.js";

export interface ComposerSendRouterOptions {
  /** The two daemon calls a resolved send makes. */
  readonly calls: ComposerSendCalls;
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

export class ComposerSendRouter {
  readonly #calls: ComposerSendCalls;
  readonly #recognizeClientCommand: ClientCommandPredicate;
  readonly #recognizeProviderCommand: ProviderCommandPredicate;
  readonly #mintIdempotencyKey: () => string;
  readonly #runVersions: RunVersionLedger;

  public constructor(options: ComposerSendRouterOptions) {
    this.#calls = options.calls;
    this.#recognizeClientCommand = options.recognizeClientCommand ?? (() => false);
    this.#recognizeProviderCommand = options.recognizeProviderCommand ?? (() => undefined);
    this.#mintIdempotencyKey = options.mintIdempotencyKey ?? (() => crypto.randomUUID());
    this.#runVersions = options.runVersions ?? new RunVersionLedger();
  }

  /**
   * What this text would do, without doing it.
   *
   * Pure. {@link send} resolves with the same text before it dispatches, so what this
   * answers is the decision that will actually run.
   */
  public resolve(text: string, target: ComposerTarget): ComposerSendResolution {
    // The one place trimming appears, and it decides nothing but blankness: the
    // value below is never what gets sent.
    if (text.trim().length === 0) {
      return refused("empty-message", "There is nothing to send yet. Type a message.");
    }
    const slashOutcome = this.#resolveSlashPrefix(text);
    if (slashOutcome !== undefined) {
      return slashOutcome;
    }
    return target.path === "channel-message"
      ? this.#resolveNewTurn(text, target)
      : this.#resolveSteer(text, target);
  }

  /**
   * Resolve, then dispatch.
   *
   * The one place a composed message reaches the wire. A refusal — this module's or
   * an intervention the run did not take — comes back as a value, because a refused
   * send is an ordinary answer the surface renders beside the control that was
   * pressed. A call that rejects is not caught here.
   */
  public async send(text: string, target: ComposerTarget): Promise<ComposerSendOutcome> {
    const resolution = this.resolve(text, target);
    switch (resolution.outcome) {
      case "refused":
        return { status: "refused", refusal: resolution.refusal };
      case "client-command":
        return { status: "intercepted", commandName: resolution.commandName };
      case "new-turn":
        return await dispatchQueuedTurn(this.#calls, resolution.request);
      case "steer":
        return await dispatchIntervention(this.#calls, resolution.request, this.#runVersions);
    }
  }

  /**
   * The slash rules under the reserved slash prefix, the same on both paths.
   *
   * Returns `undefined` when the line names no command or names one nothing claims,
   * which is the only outcome that continues to a send: a slash word on no list goes
   * out as typed, and the provider answers it as it does in its own terminal. Every
   * other branch either intercepts or refuses loudly.
   *
   * The question "does this line name a command" is asked of `directive-syntax.ts`
   * rather than answered here with a prefix test of this module's own. The discovery
   * popover asks the same module, so a line the list opens on and a line this path
   * acts on are one decision rather than two that agree until somebody edits one.
   */
  #resolveSlashPrefix(body: string): ComposerSendResolution | undefined {
    const commandName = readDirectiveName(body);
    if (commandName === undefined) {
      return undefined;
    }
    if (commandName.length > 0 && this.#recognizeClientCommand(commandName)) {
      return { outcome: "client-command", commandName };
    }
    return this.#resolveDiscoveryOnly(commandName);
  }

  /**
   * The refusal for a name the bound provider published, or `undefined` for any
   * other name.
   *
   * NAMED RATHER THAN SENT. The enumeration is a discovery surface: this console does
   * not dispatch a provider command from the line on any path, and the person who
   * typed one read it off a list this composer showed them — so the refusal says what
   * the entry is, rather than telling them to check their spelling (which was right)
   * or to remove the slash (which would not run it either).
   */
  #resolveDiscoveryOnly(commandName: string): ComposerSendResolution | undefined {
    if (commandName.length === 0) {
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

  #resolveNewTurn(body: string, target: ComposerChannelTarget): ComposerSendResolution {
    const sessionId = readSessionId(target.sessionId);
    if (sessionId === undefined) {
      return { outcome: "refused", refusal: unparseableIdentifier("the session") };
    }
    const request = readQueueItemCreateRequest({
      sessionId,
      payload: { content: body },
    } satisfies QueueItemCreateRequest);
    if (request === undefined) {
      return { outcome: "refused", refusal: unparseableIdentifier("this message") };
    }
    return { outcome: "new-turn", request };
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
    const runId = readRunId(target.targetRunId);
    if (runId === undefined) {
      return { outcome: "refused", refusal: unparseableIdentifier("the run") };
    }
    const request = readInterventionRequest({
      type: "steer",
      targetRunId: runId,
      expectedRunVersion,
      clientIdempotencyKey: this.#mintIdempotencyKey(),
      content: body,
    } satisfies InterventionRequestPayload);
    if (request === undefined) {
      return { outcome: "refused", refusal: unparseableIdentifier("this steer") };
    }
    return { outcome: "steer", request };
  }
}

/** One composer-side refusal, already wrapped in the resolution's refused arm. */
function refused(code: ComposerRefusalCode, detail: string): ComposerRefusedResolution {
  return { outcome: "refused", refusal: composerRefusal(code, detail) };
}
