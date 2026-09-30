// The send router: every send resolves through it to the one wire call the target admits (a new
// turn is `run.queueCreate`, a steer is `run.intervene`; the wire has no send verb).
//
// Resolution is pure and separate from dispatch. Ids are read through the wire readers, so an
// unreadable id is a rendered refusal that names it. A missing `expectedRunVersion` refuses
// rather than sending a zero. A resolved call is not a successful send: the intervention state
// decides, and a rejected call propagates. Trimming only decides blankness; the wire gets the
// user's bytes, and slash rules read the raw text, so indented text starting with `/` is prose.

import type { InterventionRequestPayload, QueueItemCreateRequest } from "@ai-sidekicks/contracts";

import {
  readInterventionRequest,
  readQueueItemCreateRequest,
} from "@renderer/services/daemon/wire-requests.js";
import { readRunId, readSessionId } from "@renderer/services/daemon/wire-identifiers.js";
import type { ComposerSessionTarget, ComposerTarget } from "../composer-target.js";
import { readSlashCommandName } from "../slash-command-syntax.js";
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
import { AnsweredRunVersions } from "./answered-run-versions.js";
import {
  dispatchIntervention,
  dispatchQueuedTurn,
  type ComposerSendCalls,
} from "./send-dispatch.js";

/** Options for the router; only `calls` is required. */
export interface ComposerSendRouterOptions {
  /** The two daemon calls a resolved send makes. */
  readonly calls: ComposerSendCalls;
  /** Defaults to recognizing none, which is the fail-loud arm rather than the quiet one. */
  readonly recognizeClientCommand?: ClientCommandPredicate;
  /** Defaults to naming none, so an unread enumeration changes no refusal. */
  readonly recognizeProviderCommand?: ProviderCommandPredicate;
  /**
   * Mints the per-request idempotency key, which must be a UUID. The default is the
   * platform generator: a weak key would defeat the daemon's replay guard.
   */
  readonly mintIdempotencyKey?: () => string;
  /**
   * Where answered run versions are kept. Supplied because the router is rebuilt whenever
   * the command zone's predicates change, which would empty an owned ledger between steers.
   * Defaults to a router-owned one.
   */
  readonly runVersions?: AnsweredRunVersions;
}

/** Resolves composed text to a wire call and dispatches it; see the module header. */
export class ComposerSendRouter {
  readonly #calls: ComposerSendCalls;
  readonly #recognizeClientCommand: ClientCommandPredicate;
  readonly #recognizeProviderCommand: ProviderCommandPredicate;
  readonly #mintIdempotencyKey: () => string;
  readonly #runVersions: AnsweredRunVersions;

  public constructor(options: ComposerSendRouterOptions) {
    this.#calls = options.calls;
    this.#recognizeClientCommand = options.recognizeClientCommand ?? (() => false);
    this.#recognizeProviderCommand = options.recognizeProviderCommand ?? (() => undefined);
    this.#mintIdempotencyKey = options.mintIdempotencyKey ?? (() => crypto.randomUUID());
    this.#runVersions = options.runVersions ?? new AnsweredRunVersions();
  }

  /** What this text would do, without doing it. Pure: `send` resolves with the same text. */
  public resolve(text: string, target: ComposerTarget): ComposerSendResolution {
    // Trimming decides only blankness; the value is never what gets sent.
    if (text.trim().length === 0) {
      return refused("empty-message", "There is nothing to send yet. Type a message.");
    }
    const slashOutcome = this.#resolveSlashPrefix(text);
    if (slashOutcome !== undefined) {
      return slashOutcome;
    }
    return target.path === "session-message"
      ? this.#resolveNewTurn(text, target)
      : this.#resolveSteer(text, target);
  }

  /**
   * Resolve, then dispatch: the one place a composed message reaches the wire. A refusal comes
   * back as a value; a rejected call is not caught.
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
   * The slash rules under the reserved prefix. Returns `undefined` when the line names no
   * command or one nothing claims, the only outcome that continues to a send: the provider
   * answers an unclaimed slash word as it does in its own terminal. Whether a line names a
   * command is asked of `slash-command-syntax.ts`, as the discovery popover does.
   */
  #resolveSlashPrefix(body: string): ComposerSendResolution | undefined {
    const commandName = readSlashCommandName(body);
    if (commandName === undefined) {
      return undefined;
    }
    if (commandName.length > 0 && this.#recognizeClientCommand(commandName)) {
      return { outcome: "client-command", commandName };
    }
    return this.#resolveDiscoveryOnly(commandName);
  }

  /**
   * The refusal for a name the bound provider published, or `undefined` for any other name.
   * Discovery only: the console dispatches no provider command from the line, so the refusal
   * says what the entry is instead of blaming spelling or the slash.
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

  #resolveNewTurn(body: string, target: ComposerSessionTarget): ComposerSendResolution {
    const sessionId = readSessionId(target.sessionId);
    if (sessionId === undefined) {
      return { outcome: "refused", refusal: unparseableIdentifier("the session") };
    }
    const request = readQueueItemCreateRequest({
      sessionId,
      clientIdempotencyKey: this.#mintIdempotencyKey(),
      content: body,
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
    // The store's projection and the daemon's last answer, reconciled: only the answer has
    // moved after an applied native steer.
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
