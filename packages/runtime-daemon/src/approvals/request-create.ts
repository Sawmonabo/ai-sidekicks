// The daemon's own call that raises an ask: what the permission-ask intake, a daemon-hosted tool and
// a workflow's command step hand the approval service. No client calls it and no method registers
// it, so its schema is the daemon's alone. The request carries no deadline, since an ask waits until
// it is answered, and no provider ask id, which only the daemon mints, so a forged pairing cannot
// route another ask's answer.
import { z } from "zod";

import {
  ApprovalCategorySchema,
  ApprovalRequestIdSchema,
  type ApprovalCategory,
  type ApprovalRequestId,
} from "@ai-sidekicks/contracts/approval";
import { FILE_PATH_MAX_LEN, wireFreeFormString } from "@ai-sidekicks/contracts/free-form-string";
import { RunIdSchema, type RunId } from "@ai-sidekicks/contracts/run/id";
import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts/session/id";

/**
 * What an ask is about, kept as the request row's descriptor and drawn by the card. `subject` is the
 * words the standing allow names, derived from the ask when it is raised: a command's program and
 * first subcommand, a network request's host, a written file's name. `prompt` is the provider's own
 * line saying why it stopped. Any other member is a detail of the target, kept as given.
 */
export type ApprovalResourceDescriptor = {
  subject: string;
  /** False on an ask that may not carry a standing allow, such as input to a running command. */
  standingAllowOffered: boolean;
  toolName?: string | undefined;
  prompt?: string | undefined;
  [detail: string]: unknown;
};
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
 * Parses an {@link ApprovalRequestCreateRequest}. Refused: a category outside the canonical set, and
 * any member it does not name, a provider ask id among them.
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
 * Parses an {@link ApprovalRequestCreateResponse}.
 *
 * @consumedBy the in-process create entry the permission-ask intake calls
 */
export const ApprovalRequestCreateResponseSchema: z.ZodType<
  ApprovalRequestCreateResponse,
  ApprovalRequestCreateResponse
> = z.object({ approvalRequestId: ApprovalRequestIdSchema }).strict();

/**
 * What only the daemon knows about where an ask came from, passed beside the request and never in
 * it: the daemon's own id of the provider ask it was minted for, and the tool call the ask holds,
 * whose row draws its held mark. A card the daemon raises itself carries neither.
 */
export interface ApprovalRequestOrigin {
  readonly askId?: string | undefined;
  readonly toolCallId?: string | undefined;
}
