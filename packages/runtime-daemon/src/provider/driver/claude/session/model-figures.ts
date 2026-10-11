// Claude Code's figures that no session request returns: a model's context window and reply
// reserve, and the style and advisor choices a session's folder and account offer. Each is read in
// a short control-only process, so it is held for the daemon's life and read once per key of one
// installed build; a new build starts an empty store, since a build can change every figure.
// - A window and a reply reserve are keyed by the model and the API endpoint the process was
//   given, the provider it was switched to and that provider's base address, since another
//   provider or a proxy changes both.
// - Style and advisor choices are keyed by the session's folder, whose own styles are listed, and
//   its account, whose sign-in decides the advisors.

import type { SpawnEnvPair } from "../../../spawn-env.js";
import type { ClaudeCommandChoices } from "./answered-commands.js";
import type { ProviderOperatingSystem } from "../../../operating-system/contract.js";
import { claudeConfigFolderFor } from "./conversation-file.js";
import type { ClaudeReplyReserve } from "./reply-reserve.js";
import type { ClaudeModelContextRead, ClaudeSessionFolderReadRequest } from "./transport.js";
import { readNonEmptyString } from "../../../record-readers.js";

// The variables that point Claude Code at an API endpoint other than its default: the switch to
// each provider it reaches besides Anthropic's own API, then each provider's base address.
const CLAUDE_ENDPOINT_VARIABLES: readonly string[] = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_AWS_BASE_URL",
];

// The system facts a folder's config folder is read with: the home variable and name matching.
type ClaudeFigureSystem = Pick<ProviderOperatingSystem, "homeVariable" | "environmentNameMatch">;

// Every key the store holds is composed here, so no two parts can run together.
function composeFigureKey(...parts: readonly string[]): string {
  return JSON.stringify(parts);
}

// The endpoint a process started in `spawnEnvironment` sends its requests to, as the variables
// that set it; the empty list is Claude Code's default endpoint.
function composeEndpointKey(spawnEnvironment: readonly SpawnEnvPair[]): string {
  return composeFigureKey(
    ...spawnEnvironment.flatMap(([name, value]) =>
      CLAUDE_ENDPOINT_VARIABLES.includes(name) ? [`${name}=${value}`] : [],
    ),
  );
}

function composeModelKey(place: ClaudeSessionFolderReadRequest): string {
  return composeFigureKey(composeEndpointKey(place.spawnEnvironment), place.model);
}

function composeChoicesKey(
  place: ClaudeSessionFolderReadRequest,
  operatingSystem: ClaudeFigureSystem,
): string {
  return composeFigureKey(
    place.workingDirectory,
    claudeConfigFolderFor(place.spawnEnvironment, operatingSystem),
  );
}

// The model a `get_context_usage` reply names and its whole window (`rawMaxTokens`), or `undefined`
// when the reply, which is provider output, lacks either.
function readClaudeContextWindow(
  usage: Record<string, unknown> | undefined,
): { readonly model: string; readonly contextWindow: number } | undefined {
  const model = usage === undefined ? undefined : readNonEmptyString(usage, "model");
  const contextWindow = usage?.["rawMaxTokens"];
  const isWindow =
    typeof contextWindow === "number" && Number.isInteger(contextWindow) && contextWindow > 0;
  return model === undefined || !isWindow ? undefined : { model, contextWindow };
}

// The context reads made against one endpoint.
interface ClaudeEndpointContextReads {
  readonly contextWindows: Map<string, number>;
  // Each model a read was asked for or answered for, a refused one included.
  readonly readModels: Set<string>;
}

/**
 * The figures held for one installed Claude Code build, so every key includes the build's version.
 * A read in flight is held as its promise, so sessions created together share one process, and a
 * failed read is dropped so the next session reads it again.
 */
export class ClaudeModelFigures {
  /** The build version these figures describe; `undefined` before the daemon reads one. */
  readonly buildVersion: string | undefined;
  readonly #commandChoices = new Map<string, Promise<ClaudeCommandChoices>>();
  readonly #replyReserves = new Map<string, Promise<ClaudeReplyReserve>>();
  readonly #contextReads = new Map<string, ClaudeEndpointContextReads>();
  readonly #operatingSystem: ClaudeFigureSystem;

  constructor(buildVersion: string | undefined, operatingSystem: ClaudeFigureSystem) {
    this.buildVersion = buildVersion;
    this.#operatingSystem = operatingSystem;
  }

  /** The style and advisor choices read for `place`'s folder and account, when a read is held. */
  commandChoicesOf(
    place: ClaudeSessionFolderReadRequest,
  ): Promise<ClaudeCommandChoices> | undefined {
    return this.#commandChoices.get(composeChoicesKey(place, this.#operatingSystem));
  }

  /** Holds the style and advisor choices a read is reading for `place`'s folder and account. */
  holdCommandChoices(
    place: ClaudeSessionFolderReadRequest,
    commandChoices: Promise<ClaudeCommandChoices>,
  ): void {
    this.#commandChoices.set(composeChoicesKey(place, this.#operatingSystem), commandChoices);
  }

  /** Drops a failed choices read, so the next session reads it again; a later read stays. */
  forgetCommandChoices(
    place: ClaudeSessionFolderReadRequest,
    commandChoices: Promise<ClaudeCommandChoices>,
  ): void {
    const key = composeChoicesKey(place, this.#operatingSystem);
    if (this.#commandChoices.get(key) === commandChoices) {
      this.#commandChoices.delete(key);
    }
  }

  /**
   * The reply reserve read for `place`'s model and endpoint, when a read is held.
   *
   * @consumedBy the compaction slider, whose stops below the window key's reach come from it
   */
  replyReserveOf(place: ClaudeSessionFolderReadRequest): Promise<ClaudeReplyReserve> | undefined {
    return this.#replyReserves.get(composeModelKey(place));
  }

  /** Holds the reply reserve a read is reading for `place`'s model and endpoint. */
  holdReplyReserve(
    place: ClaudeSessionFolderReadRequest,
    replyReserve: Promise<ClaudeReplyReserve>,
  ): void {
    this.#replyReserves.set(composeModelKey(place), replyReserve);
  }

  /** Drops a failed reply-reserve read, so the next read of it goes again; a later read stays. */
  forgetReplyReserve(
    place: ClaudeSessionFolderReadRequest,
    replyReserve: Promise<ClaudeReplyReserve>,
  ): void {
    const key = composeModelKey(place);
    if (this.#replyReserves.get(key) === replyReserve) {
      this.#replyReserves.delete(key);
    }
  }

  /**
   * The context window read for a catalog row's model id at the endpoint `spawnEnvironment` sets;
   * `undefined` until a read lands.
   */
  contextWindowOf(spawnEnvironment: readonly SpawnEnvPair[], model: string): number | undefined {
    return this.#contextReads.get(composeEndpointKey(spawnEnvironment))?.contextWindows.get(model);
  }

  /** Every model whose context read at that endpoint is done, for the next read to skip. */
  contextReadModels(spawnEnvironment: readonly SpawnEnvPair[]): ReadonlySet<string> {
    return new Set(this.#contextReads.get(composeEndpointKey(spawnEnvironment))?.readModels);
  }

  /**
   * Records the context reads one process started in `spawnEnvironment` made; a refused or
   * unreadable one keeps no window.
   */
  recordContextReads(
    spawnEnvironment: readonly SpawnEnvPair[],
    reads: readonly ClaudeModelContextRead[],
  ): void {
    const endpointKey = composeEndpointKey(spawnEnvironment);
    const endpointReads = this.#contextReads.get(endpointKey) ?? {
      contextWindows: new Map<string, number>(),
      readModels: new Set<string>(),
    };
    this.#contextReads.set(endpointKey, endpointReads);
    for (const read of reads) {
      if (read.requestedModel !== undefined) {
        endpointReads.readModels.add(read.requestedModel);
      }
      const window = readClaudeContextWindow(read.usage);
      if (window !== undefined) {
        endpointReads.readModels.add(window.model);
        endpointReads.contextWindows.set(window.model, window.contextWindow);
      }
    }
  }
}
