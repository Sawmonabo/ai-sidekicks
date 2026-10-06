// The send router: every send resolves through it to the one wire call the target admits (a new
// turn is `run.queueCreate`, a steer is `run.intervene`; the wire has no send verb).
//
// Resolution is pure and separate from dispatch. Ids are read through the wire readers, so an
// unreadable id is a rendered refusal that names it. A missing `expectedRunVersion` refuses
// rather than sending a zero. A resolved call is not a successful send: the intervention state
// decides, and a rejected call propagates. Trimming only decides blankness; the wire gets the
// user's bytes, and slash rules read the raw text, so indented text starting with `/` is prose.

import type { InterventionRequestPayload } from "@ai-sidekicks/contracts/run/control";
import type { QueueItemCreateRequest } from "@ai-sidekicks/contracts/run/queue";

import {
  readInterventionRequest,
  readQueueItemCreateRequest,
} from "#renderer/services/daemon/wire/requests.js";
import { readRunId, readSessionId } from "#renderer/services/daemon/wire/identifiers.js";
import type { ComposerRunTarget, ComposerSessionTarget, ComposerTarget } from "../../target.js";
import { readSlashCommandName } from "../../slash-command-syntax.js";
import type {
  ConsoleCommandPredicate,
  ComposerMessageOutcome,
  ComposerMessageResolution,
  ComposerRefusedResolution,
  ComposerSendOutcome,
  ComposerSendResolution,
} from "./resolutions.js";
import { composerRefusal, unparseableIdentifier, type ComposerRefusalCode } from "./refusals.js";
import { AnsweredRunVersions } from "../../answered-run-versions.js";
import { dispatchIntervention, dispatchQueuedTurn, type ComposerSendCalls } from "./dispatch.js";

/** Options for the router; only `calls` is required. */
export interface ComposerSendRouterOptions {
  /** The two daemon calls a resolved send makes. */
  readonly calls: ComposerSendCalls;
  /** Defaults to recognizing none, which is the fail-loud arm rather than the quiet one. */
  readonly recognizeConsoleCommand?: ConsoleCommandPredicate;
  /**
   * Mints the per-request idempotency key, which must be a UUID. The default is the
   * platform generator: a weak key would defeat the daemon's duplicate-request guard.
   */
  readonly mintIdempotencyKey?: () => string;
  /**
   * Where answered run versions are kept. Supplied because the router is rebuilt whenever
   * the command zone's predicates change, which would empty an owned record between steers.
   * Defaults to a router-owned one.
   */
  readonly runVersions?: AnsweredRunVersions;
}

/** Resolves composed text to a wire call and dispatches it; see the module header. */
export class ComposerSendRouter {
  readonly #calls: ComposerSendCalls;
  readonly #recognizeConsoleCommand: ConsoleCommandPredicate;
  readonly #mintIdempotencyKey: () => string;
  readonly #runVersions: AnsweredRunVersions;

  public constructor(options: ComposerSendRouterOptions) {
    this.#calls = options.calls;
    this.#recognizeConsoleCommand = options.recognizeConsoleCommand ?? (() => false);
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
    return this.#resolveMessage(text, target);
  }

  /**
   * Resolve, then dispatch: the one place a composed message reaches the wire. A refusal comes
   * back as a value; a rejected call is not caught.
   */
  public async send(text: string, target: ComposerTarget): Promise<ComposerSendOutcome> {
    const resolution = this.resolve(text, target);
    if (resolution.outcome === "console-command") {
      return { status: "intercepted", commandName: resolution.commandName };
    }
    return await this.#dispatchMessage(resolution);
  }

  /**
   * Send an intercepted line its command did not act on, exactly as typed: the slash rules are
   * skipped, so the provider answers it as it does in its own terminal.
   */
  public async sendAsTyped(text: string, target: ComposerTarget): Promise<ComposerMessageOutcome> {
    return await this.#dispatchMessage(this.#resolveMessage(text, target));
  }

  /**
   * The slash rules under the reserved prefix. Returns `undefined` when the line names no
   * command that runs here, the only outcome that continues to a send: the provider answers any
   * other slash word, its own included, as it does in its own terminal. Whether a line names a
   * command is asked of `slash-command-syntax.ts`, as the command list does.
   */
  #resolveSlashPrefix(body: string): ComposerSendResolution | undefined {
    const commandName = readSlashCommandName(body);
    if (commandName === undefined || commandName.length === 0) {
      return undefined;
    }
    return this.#recognizeConsoleCommand(commandName)
      ? { outcome: "console-command", commandName }
      : undefined;
  }

  #resolveMessage(body: string, target: ComposerTarget): ComposerMessageResolution {
    return target.path === "session-message"
      ? this.#resolveNewTurn(body, target)
      : this.#resolveSteer(body, target);
  }

  async #dispatchMessage(resolution: ComposerMessageResolution): Promise<ComposerMessageOutcome> {
    switch (resolution.outcome) {
      case "refused":
        return { status: "refused", refusal: resolution.refusal };
      case "new-turn":
        return await dispatchQueuedTurn(this.#calls, resolution.request);
      case "steer":
        return await dispatchIntervention(this.#calls, resolution.request, this.#runVersions);
    }
  }

  #resolveNewTurn(body: string, target: ComposerSessionTarget): ComposerMessageResolution {
    const sessionId = readSessionId(target.sessionId);
    if (sessionId === undefined) {
      return { outcome: "refused", refusal: unparseableIdentifier() };
    }
    const request = readQueueItemCreateRequest({
      sessionId,
      clientIdempotencyKey: this.#mintIdempotencyKey(),
      content: body,
    } satisfies QueueItemCreateRequest);
    if (request === undefined) {
      return { outcome: "refused", refusal: unparseableIdentifier() };
    }
    return { outcome: "new-turn", request };
  }

  #resolveSteer(body: string, target: ComposerRunTarget): ComposerMessageResolution {
    // The store's projection and the daemon's last answer, reconciled: only the answer has
    // moved after an applied native steer.
    const expectedRunVersion = this.#runVersions.comparandFor(
      target.targetRunId,
      target.expectedRunVersion,
    );
    if (expectedRunVersion === undefined) {
      return refused(
        "run-version-unread",
        "The console has not read this run's current version, so a steer " +
          "cannot be guarded against a turn that has already moved on. " +
          "Reopen the run and try again.",
      );
    }
    const runId = readRunId(target.targetRunId);
    if (runId === undefined) {
      return { outcome: "refused", refusal: unparseableIdentifier() };
    }
    const request = readInterventionRequest({
      type: "steer",
      targetRunId: runId,
      expectedRunVersion,
      clientIdempotencyKey: this.#mintIdempotencyKey(),
      content: body,
    } satisfies InterventionRequestPayload);
    if (request === undefined) {
      return { outcome: "refused", refusal: unparseableIdentifier() };
    }
    return { outcome: "steer", request };
  }
}

/** One composer-side refusal, already wrapped in the resolution's refused arm. */
function refused(code: ComposerRefusalCode, detail: string): ComposerRefusedResolution {
  return { outcome: "refused", refusal: composerRefusal(code, detail) };
}
