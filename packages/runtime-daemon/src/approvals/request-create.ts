// The daemon's own call that raises an ask: what the permission-ask intake, a daemon-hosted tool
// and a workflow's command step hand the approval service. No client calls it and no method
// registers it, so its schema is the daemon's alone. The request carries no deadline, since an ask
// waits until it is answered, and no provider ask id, which only the daemon mints, so a forged
// pairing cannot route another ask's answer.
import { z } from "zod";

import {
  ApprovalCategorySchema,
  type ApprovalCategory,
  type ApprovalRequestId,
} from "@ai-sidekicks/contracts/approval";
import { FILE_PATH_MAX_LEN, wireFreeFormString } from "@ai-sidekicks/contracts/free-form-string";
import { RunIdSchema, type RunId } from "@ai-sidekicks/contracts/run/id";
import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts/session/id";

import type { ProviderAskAction } from "../provider/port/permission-ask.js";

/**
 * What an ask is about, kept as the request row's descriptor and drawn by the card. `subject` is
 * the words the standing allow names, derived from the ask when it is raised: a command's program
 * and first subcommand, a network request's host, a written file's name. `action` is what a
 * provider's held call would do, whole, which the card shows and a rule names the kind of. `prompt`
 * is the provider's own line saying why it stopped. Any other member is a detail of the target,
 * kept as given.
 */
export type ApprovalResourceDescriptor = {
  subject: string;
  /** False on an ask that may not carry a standing allow, such as input to a running command. */
  standingAllowOffered: boolean;
  /**
   * False where the provider keeps no project rule for the ask, as Codex keeps none on a file
   * change; the project scope is offered only where this and the standing allow both are.
   */
  projectScopeOffered: boolean;
  /** Whether the person may correct the command or path before approving it. */
  editable: boolean;
  action?: ProviderAskAction | undefined;
  toolName?: string | undefined;
  prompt?: string | undefined;
  [detail: string]: unknown;
};

const ProviderAskActionSchema: z.ZodType<ProviderAskAction, ProviderAskAction> =
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("plan") }).strict(),
    z.object({ kind: z.literal("command"), command: z.string() }).strict(),
    z.object({ kind: z.literal("command_input"), input: z.string() }).strict(),
    z.object({ kind: z.literal("file_change"), paths: z.array(z.string()).readonly() }).strict(),
    z.object({ kind: z.literal("file_read"), path: z.string() }).strict(),
    z.object({ kind: z.literal("network"), host: z.string() }).strict(),
    z.object({ kind: z.literal("tool"), toolName: z.string() }).strict(),
  ]);
/**
 * Parses an {@link ApprovalResourceDescriptor}.
 *
 * @consumedBy the permission check's request
 */
export const ApprovalResourceDescriptorSchema: z.ZodType<
  ApprovalResourceDescriptor,
  ApprovalResourceDescriptor
> = z
  .object({
    subject: wireFreeFormString(FILE_PATH_MAX_LEN, "ApprovalResourceDescriptor.subject"),
    standingAllowOffered: z.boolean(),
    projectScopeOffered: z.boolean(),
    editable: z.boolean(),
    action: ProviderAskActionSchema.optional(),
    toolName: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
  })
  .catchall(z.unknown());

/** One ask to raise for a person's answer. */
export interface ApprovalRequestCreateRequest {
  sessionId: SessionId;
  runId: RunId;
  /** The agent's actor id, or the device a person's request came from. */
  requestedBy: string;
  category: ApprovalCategory;
  /** The target as free text, such as a command or a path. */
  scope: string;
  resourceDescriptor: ApprovalResourceDescriptor;
}
/**
 * Parses an {@link ApprovalRequestCreateRequest}. Refused: a category outside the canonical set,
 * and any member it does not name, a provider ask id among them.
 */
export const ApprovalRequestCreateRequestSchema: z.ZodType<
  ApprovalRequestCreateRequest,
  ApprovalRequestCreateRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    runId: RunIdSchema,
    requestedBy: z.string().min(1),
    category: ApprovalCategorySchema,
    scope: wireFreeFormString(FILE_PATH_MAX_LEN, "ApprovalRequestCreateRequest.scope"),
    resourceDescriptor: ApprovalResourceDescriptorSchema,
  })
  .strict();

/** The ask raised, pending until it is answered or canceled. */
export interface ApprovalRequestCreateResponse {
  approvalRequestId: ApprovalRequestId;
}
/**
 * What only the daemon knows about where an ask came from, passed beside the request and never in
 * it: the daemon's own id of the provider ask it was minted for, and the tool call the ask holds,
 * whose row draws its held mark. A card the daemon raises itself carries neither.
 */
export interface ApprovalRequestOrigin {
  readonly askId?: string | undefined;
  readonly toolCallId?: string | undefined;
}
