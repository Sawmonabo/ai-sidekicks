// The send router: every send resolves through it to `agent.queueItem.create`, whether a turn is
// running or not. A message sent mid-turn waits on the session's queue until the agent takes it
// at its next step, so a run-addressed composer sends the same call as a session-addressed one.
//
// Resolution is pure and separate from dispatch. Ids are read through the wire readers, so an
// unreadable id is a rendered refusal that names it, and a rejected call propagates. A message
// with no words still goes when it carries a staged file; one carrying nothing does nothing and
// draws no line. Trimming only decides blankness; the
// wire gets the user's bytes, and slash rules read the raw text, so indented text starting with
// `/` is prose. What rides with the words, the held draft's files, skill picks, turn speed and
// repository, goes on the request as the draft holds it. Resolving mints the request's key, so the
// message's row is drawn under it from the press, before the request leaves.

import type { AgentQueueItemCreateRequest } from "@ai-sidekicks/contracts/run/queue";
import type { SessionDraftExtras } from "@ai-sidekicks/contracts/session/draft";

import { readSessionId } from "#renderer/services/daemon/wire/identifiers.js";
import type { ComposerTarget } from "../../target.js";
import { readSlashCommandName } from "../../slash-command-syntax.js";
import type {
  ConsoleCommandPredicate,
  ComposerMessageOutcome,
  ComposerMessageResolution,
  ComposerSendResolution,
} from "./resolutions.js";
import { unparsableIdentifier } from "./refusals.js";
import { dispatchQueuedMessage, type ComposerSendCalls } from "./dispatch.js";

/**
 * What rides with a message's words: the held draft's extras and, for an edit of a waiting
 * message, the item it replaces in place.
 */
export type ComposerSendExtras = SessionDraftExtras &
  Pick<AgentQueueItemCreateRequest, "replacesQueueItemId">;

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

/** Resolves composed text to a wire call, and sends a resolved one; see the module header. */
export class ComposerSendRouter {
  readonly #calls: ComposerSendCalls;
  readonly #recognizeConsoleCommand: ConsoleCommandPredicate;
  readonly #mintIdempotencyKey: () => string;

  public constructor(options: ComposerSendRouterOptions) {
    this.#calls = options.calls;
    this.#recognizeConsoleCommand = options.recognizeConsoleCommand ?? (() => false);
    this.#mintIdempotencyKey = options.mintIdempotencyKey ?? (() => crypto.randomUUID());
  }

  /** What this text would do, without doing it; a message's request carries a key of its own. */
  public resolve(
    text: string,
    target: ComposerTarget,
    extras: ComposerSendExtras,
  ): ComposerSendResolution {
    if (carriesNothing(text, extras)) {
      return { outcome: "empty" };
    }
    const slashOutcome = this.#resolveSlashPrefix(text);
    if (slashOutcome !== undefined) {
      return slashOutcome;
    }
    return this.#resolveMessage(text, target, extras);
  }

  /**
   * The text as a message, exactly as typed: the slash rules are skipped, so an intercepted line
   * its command did not act on, or a press whose only file is still copying, goes as a message
   * the provider answers as it does in its own terminal.
   */
  public resolveAsTyped(
    text: string,
    target: ComposerTarget,
    extras: ComposerSendExtras,
  ): ComposerMessageResolution {
    return this.#resolveMessage(text, target, extras);
  }

  /** The one place a composed message reaches the wire. A rejected call is not caught. */
  public async dispatch(request: AgentQueueItemCreateRequest): Promise<ComposerMessageOutcome> {
    return await dispatchQueuedMessage(this.#calls, request);
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
    extras: ComposerSendExtras,
  ): ComposerMessageResolution {
    const sessionId = readSessionId(target.sessionId);
    if (sessionId === undefined) {
      return { outcome: "refused", refusal: unparsableIdentifier() };
    }
    const request: AgentQueueItemCreateRequest = {
      sessionId,
      clientIdempotencyKey: this.#mintIdempotencyKey(),
      content: body,
      ...extras,
    };
    return { outcome: "queue", request };
  }
}

/**
 * Whether a message carries nothing to send: no words and no staged file. Composed notes are
 * words in the draft. Trimming decides only blankness; the value is never what gets sent.
 */
export function carriesNothing(text: string, extras: SessionDraftExtras): boolean {
  return text.trim().length === 0 && (extras.attachments ?? []).length === 0;
}
