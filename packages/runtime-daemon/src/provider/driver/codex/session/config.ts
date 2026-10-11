/**
 * What a Codex session is opened in, resolved by the daemon at every start, and the run
 * configuration each turn is started from.
 */

import { AgentIdSchema, type AgentId } from "@ai-sidekicks/contracts/agent/definition";
import { AttachmentReferenceListSchema } from "@ai-sidekicks/contracts/artifacts/attachment-reference";
import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";
import {
  PickedSkillSchema,
  type PickedSkill,
} from "@ai-sidekicks/contracts/provider/driver/intervention";
import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionEnvironmentRows } from "../../../spawn-env.js";
import { isPlainObject } from "../../../record-readers.js";
import { CodexDriverConfigError } from "./errors.js";

/**
 * The item-injection method (`ThreadInjectItemsParams`, non-experimental at the pin): appends items
 * to a loaded thread's model-visible history, one way a conversation takes changed instructions
 * from its next turn. `items` accepts any JSON, so an unrecognized item is taken and dropped while
 * the request still succeeds.
 *
 * @consumedBy the Codex leg that hands a loaded conversation changed instructions
 */
export const CODEX_THREAD_INJECT_ITEMS_METHOD = "thread/inject_items" as const;

/** Where one session's conversation runs, resolved by the daemon at every start and resume. */
interface CodexSessionSpawnContext {
  /** The session's working folder, its worktree, absolute. */
  readonly workingDirectory: string;
  /** The repository's git folder, the common one for a linked worktree; absent outside one. */
  readonly gitCommonFolder: string | undefined;
  readonly environmentRows: SessionEnvironmentRows | undefined;
  /** The instructions the conversation runs under, sent on every start, resume and fork. */
  readonly baseInstructions: string | undefined;
}

/** Resolves a session's spawn context, wired by the daemon. */
export interface CodexSpawnContextResolver {
  resolveSpawnContext(
    sessionId: SessionId,
    providerAccountId: string | undefined,
  ): Promise<CodexSessionSpawnContext>;
}

/**
 * Posture-affecting `turn/start` fields the daemon derives; `StartRunParams.agentConfig` is
 * untyped, so this refusal keeps a caller-declared policy off the wire.
 */
const CALLER_DERIVED_TURN_POSTURE_FIELDS: readonly string[] = [
  "cwd",
  "sandbox",
  "sandboxPolicy",
  "permissions",
  "permissionProfile",
  "approvalPolicy",
  "approvalsReviewer",
];

/**
 * Contents of `StartRunParams.agentConfig`: the session, the runtime binding the run's deliveries
 * go on, the agent whose run it is, the turn's text and staged files, its model and window, and the
 * skills the person picked, each by its name and the file Codex listed it from.
 */
export interface CodexRunConfig {
  sessionId: SessionId;
  bindingId: string;
  agentId: AgentId;
  input: string;
  /** The message's staged files, in staging order. */
  attachments?: ArtifactId[] | undefined;
  model?: string | undefined;
  /**
   * The larger window chosen for the turn's model, in tokens, as recorded when it was picked (the
   * config's `largerWindow`); sent as recorded. Absent with a model named, the turn runs the
   * default window; absent with no model named, the turn keeps the conversation's model and window.
   */
  modelContextWindow?: number | undefined;
  clientUserMessageId?: string | undefined;
  /** The skills picked for the message, in the order picked. */
  skills?: PickedSkill[] | undefined;
}

/** Fail-closed parse of `StartRunParams.agentConfig`. */
export function parseCodexRunConfig(agentConfig: unknown): CodexRunConfig {
  const source = readRecord(agentConfig, "StartRunParams.agentConfig");
  // Parsed, not cast, so a malformed id fails here as a config error.
  const rawSessionId = readRequiredString(
    source,
    "sessionId",
    "StartRunParams.agentConfig.sessionId",
  );
  const parsedSessionId = SessionIdSchema.safeParse(rawSessionId);
  if (!parsedSessionId.success) {
    throw new CodexDriverConfigError(
      "StartRunParams.agentConfig.sessionId must be a session id.",
      "StartRunParams.agentConfig.sessionId",
      { cause: parsedSessionId.error },
    );
  }
  const sessionId = parsedSessionId.data;
  const bindingId = readRequiredString(source, "bindingId", "StartRunParams.agentConfig.bindingId");
  const parsedAgentId = AgentIdSchema.safeParse(
    readRequiredString(source, "agentId", "StartRunParams.agentConfig.agentId"),
  );
  if (!parsedAgentId.success) {
    throw new CodexDriverConfigError(
      "StartRunParams.agentConfig.agentId must be an agent id.",
      "StartRunParams.agentConfig.agentId",
      { cause: parsedAgentId.error },
    );
  }
  const input = readRequiredString(source, "input", "StartRunParams.agentConfig.input");
  const parsedAttachments = AttachmentReferenceListSchema.optional().safeParse(
    source["attachments"],
  );
  if (!parsedAttachments.success) {
    throw new CodexDriverConfigError(
      "StartRunParams.agentConfig.attachments must be a list of artifact ids.",
      "StartRunParams.agentConfig.attachments",
      { cause: parsedAttachments.error },
    );
  }
  const attachments = parsedAttachments.data;
  const model = readOptionalString(source, "model", "StartRunParams.agentConfig.model");
  const modelContextWindow = readOptionalTokenCount(
    source,
    "largerWindow",
    "StartRunParams.agentConfig.largerWindow",
  );
  const clientUserMessageId = readOptionalString(
    source,
    "clientUserMessageId",
    "StartRunParams.agentConfig.clientUserMessageId",
  );
  const parsedSkills = PickedSkillSchema.array().optional().safeParse(source["skills"]);
  if (!parsedSkills.success) {
    throw new CodexDriverConfigError(
      "StartRunParams.agentConfig.skills must be a list of skills, each a name and its file.",
      "StartRunParams.agentConfig.skills",
      { cause: parsedSkills.error },
    );
  }
  const skills = parsedSkills.data;
  // Refused even when the value matches what the daemon derived; no comparison needed.
  for (const field of CALLER_DERIVED_TURN_POSTURE_FIELDS) {
    if (source[field] !== undefined) {
      throw new CodexDriverConfigError(
        `StartRunParams.agentConfig.${field} cannot be declared; the daemon derives every ` +
          `posture-affecting turn field.`,
        `StartRunParams.agentConfig.${field}`,
      );
    }
  }
  return {
    sessionId,
    bindingId,
    agentId: parsedAgentId.data,
    input,
    ...(attachments === undefined ? {} : { attachments }),
    ...(model === undefined ? {} : { model }),
    ...(modelContextWindow === undefined ? {} : { modelContextWindow }),
    ...(clientUserMessageId === undefined ? {} : { clientUserMessageId }),
    ...(skills === undefined ? {} : { skills }),
  };
}

/** Returns the value as an object, or throws a configuration error naming the label. */
function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new CodexDriverConfigError(`${label} must be an object.`, label);
  }
  return value;
}

/** Reads a non-empty string field, or throws a configuration error naming the label. */
function readRequiredString(source: Record<string, unknown>, key: string, label: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CodexDriverConfigError(`${label} must be a non-empty string.`, label);
  }
  return value;
}

/**
 * Reads a positive whole number of tokens, or undefined when it is absent; throws when present but
 * not one.
 */
function readOptionalTokenCount(
  source: Record<string, unknown>,
  key: string,
  label: string,
): number | undefined {
  const value = source[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new CodexDriverConfigError(
      `${label} must be a positive whole number when present.`,
      label,
    );
  }
  return value;
}

/**
 * Reads a non-empty string field, or undefined when it is absent; throws when present but empty or
 * not a string.
 */
function readOptionalString(
  source: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const value = source[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new CodexDriverConfigError(`${label} must be a non-empty string when present.`, label);
  }
  return value;
}
