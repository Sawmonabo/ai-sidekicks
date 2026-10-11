// The staged files a message carries, as a driver hands them to its provider: each bound to the
// stored copy the provider reads, in the order they were staged, and one the daemon could not bind
// standing in its own place as an unresolved marker, so no file is ever left out unsaid.

import type {
  UnresolvedAttachmentCause,
  UnresolvedAttachmentMarker,
} from "@ai-sidekicks/contracts/artifacts/attachment-reference";
import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

/**
 * One staged file bound to its stored copy: the absolute path the provider reads, the file's own
 * name, and the media type read from its bytes.
 */
export interface ResolvedAttachment {
  readonly kind: "resolved";
  readonly artifactId: ArtifactId;
  readonly path: string;
  readonly fileName: string;
  readonly mediaType: string;
}

/** One attachment as a driver hands it to its provider, a bound file or the marker in its place. */
export type ProviderAttachment = ResolvedAttachment | UnresolvedAttachmentMarker;

/**
 * Binds a message's attachments to their stored copies, answering one entry per id in the same
 * order; an id it cannot bind is an unresolved marker in its place. Wired by the daemon.
 */
export interface AttachmentResolver {
  resolveAttachments(
    sessionId: SessionId,
    artifactIds: readonly ArtifactId[],
  ): Promise<ProviderAttachment[]>;
}

// What the agent reads in the place of a file that could not be delivered, by cause.
const UNDELIVERED_ATTACHMENT_REASONS: Readonly<Record<UnresolvedAttachmentCause, string>> = {
  deleted: "it was deleted",
};

/** Binds a message's attachments in staging order; one with none asks the resolver nothing. */
export async function resolveMessageAttachments(
  resolver: AttachmentResolver,
  sessionId: SessionId,
  artifactIds: readonly ArtifactId[] | undefined,
): Promise<readonly ProviderAttachment[]> {
  return artifactIds === undefined || artifactIds.length === 0
    ? []
    : await resolver.resolveAttachments(sessionId, artifactIds);
}

/**
 * The line an agent reads for a file given to it by its path, which it opens itself, or for one
 * that could not be delivered, naming why.
 */
export function composeAttachmentText(attachment: ProviderAttachment): string {
  return attachment.kind === "resolved"
    ? `Attached file ${attachment.fileName}: ${attachment.path}`
    : `Attached file ${attachment.artifactId} was not delivered: ` +
        `${UNDELIVERED_ATTACHMENT_REASONS[attachment.cause]}.`;
}

/**
 * A message as words alone, for a reader that takes only text: its words, then a line per
 * attachment in staging order.
 */
export function composeMessageText(
  content: string,
  attachments: readonly ProviderAttachment[],
): string {
  return [content, ...attachments.map(composeAttachmentText)].join("\n");
}
