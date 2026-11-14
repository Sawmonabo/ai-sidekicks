// The send router: every send resolves through it to `agent.queueItem.create`, whether a turn is
// running or not. A message sent mid-turn waits on the session's queue until the agent takes it
// at its next step, so a run-addressed composer sends the same call as a session-addressed one.
//
// Resolution is pure and separate from dispatch. Ids are read through the wire readers, so an
// unreadable id is a rendered refusal that names it, and a rejected call propagates. A message
// with no words still goes when it carries a staged file. Trimming only decides blankness; the
// wire gets the user's bytes, and slash rules read the raw text, so indented text starting with
// `/` is prose. What rides with the words, the held draft's files, skill picks, turn speed and
// repository, goes on the request as the draft holds it.

import type { AgentQueueItemCreateRequest } from "@ai-sidekicks/contracts/run/queue";
import type { SessionDraftExtras } from "@ai-sidekicks/contracts/session/draft";

import { readQueueItemCreateRequest } from "#renderer/services/daemon/wire/requests.js";
import { readSessionId } from "#renderer/services/daemon/wire/identifiers.js";
import type { ComposerTarget } from "../../target.js";
import { readSlashCommandName } from "../../slash-command-syntax.js";
import type {
  ConsoleCommandPredicate,
  ComposerMessageOutcome,
  ComposerMessageResolution,
  ComposerRefusedResolution,
  ComposerSendOutcome,
  ComposerSendResolution,
} from "./resolutions.js";
import { composerRefusal, unparsableIdentifier, type ComposerRefusalCode } from "./refusals.js";
import { dispatchQueuedMessage, type ComposerSendCalls } from "./dispatch.js";

/** Options for the router; only `calls` is required. */
export interface ComposerSendRouterOptions {
  /** The daemon call a resolved send makes. */
  readonly calls: ComposerSendCalls;
  /** Defaults to recognizing none, which is the fail-loud arm rather than the quiet one. */
  readonly recognizeConsoleCommand?: ConsoleCommandPredicate;
  /**
   * Mints the per-request idempotency key, which must be a UUID. The default is the
   * platform generator: a weak key would defeat the daemon's duplicate-request guard.
   */
  readonly mintIdempotencyKey?: () => string;
}

/** Resolves composed text to a wire call and dispatches it; see the module header. */
export class ComposerSendRouter {
  readonly #calls: ComposerSendCalls;
  readonly #recognizeConsoleCommand: ConsoleCommandPredicate;
  readonly #mintIdempotencyKey: () => string;

  public constructor(options: ComposerSendRouterOptions) {
    this.#calls = options.calls;
    this.#recognizeConsoleCommand = options.recognizeConsoleCommand ?? (() => false);
    this.#mintIdempotencyKey = options.mintIdempotencyKey ?? (() => crypto.randomUUID());
  }

  /** What this text would do, without doing it. Pure: `send` resolves with the same text. */
  public resolve(
    text: string,
    target: ComposerTarget,
    extras: SessionDraftExtras,
  ): ComposerSendResolution {
    if (carriesNothing(text, extras)) {
      return refused("empty-message", "There is nothing to send yet. Type a message.");
    }
    const slashOutcome = this.#resolveSlashPrefix(text);
    if (slashOutcome !== undefined) {
      return slashOutcome;
    }
    return this.#resolveMessage(text, target, extras);
  }

  /**
   * Resolve, then dispatch: the one place a composed message reaches the wire. A refusal comes
   * back as a value; a rejected call is not caught.
   */
  public async send(
    text: string,
    target: ComposerTarget,
    extras: SessionDraftExtras,
  ): Promise<ComposerSendOutcome> {
    const resolution = this.resolve(text, target, extras);
    if (resolution.outcome === "console-command") {
      return { status: "intercepted", commandName: resolution.commandName };
    }
    return await this.#dispatchMessage(resolution);
  }

  /**
   * Send an intercepted line its command did not act on, exactly as typed: the slash rules are
   * skipped, so the provider answers it as it does in its own terminal.
   */
  public async sendAsTyped(
    text: string,
    target: ComposerTarget,
    extras: SessionDraftExtras,
  ): Promise<ComposerMessageOutcome> {
    return await this.#dispatchMessage(this.#resolveMessage(text, target, extras));
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

  #resolveMessage(
    body: string,
    target: ComposerTarget,
    extras: SessionDraftExtras,
  ): ComposerMessageResolution {
    const sessionId = readSessionId(target.sessionId);
    if (sessionId === undefined) {
      return { outcome: "refused", refusal: unparsableIdentifier() };
    }
    const request = readQueueItemCreateRequest({
      sessionId,
      clientIdempotencyKey: this.#mintIdempotencyKey(),
      content: body,
      ...extras,
    } satisfies AgentQueueItemCreateRequest);
    if (request === undefined) {
      return { outcome: "refused", refusal: unparsableIdentifier() };
    }
    return { outcome: "queue", request };
  }

  async #dispatchMessage(resolution: ComposerMessageResolution): Promise<ComposerMessageOutcome> {
    switch (resolution.outcome) {
      case "refused":
        return { status: "refused", refusal: resolution.refusal };
      case "queue":
        return await dispatchQueuedMessage(this.#calls, resolution.request);
    }
  }
}

/**
 * Whether a message carries nothing to send: no words and no staged file. Composed notes are
 * words in the draft. Trimming decides only blankness; the value is never what gets sent.
 */
export function carriesNothing(text: string, extras: SessionDraftExtras): boolean {
  return text.trim().length === 0 && (extras.attachments ?? []).length === 0;
}

/** One composer-side refusal, already wrapped in the resolution's refused arm. */
function refused(code: ComposerRefusalCode, detail: string): ComposerRefusedResolution {
  return { outcome: "refused", refusal: composerRefusal(code, detail) };
}
