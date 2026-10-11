// A message's staged files as Claude Code's streaming input takes them: a picture in a format its
// image block takes as that block, built from the stored bytes, and any other file as its path in
// the message's words, which the agent opens itself. A picture past Claude Code's size limit is
// refused before anything is sent, in Claude Code's own words.

import { readFile, stat } from "node:fs/promises";

import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import {
  composeAttachmentText,
  resolveMessageAttachments,
  type AttachmentResolver,
  type ProviderAttachment,
  type ResolvedAttachment,
} from "../attachments.js";
import {
  CLAUDE_PICTURE_MEDIA_TYPES,
  type ClaudePictureMediaType,
  type ClaudeUserContentBlock,
} from "./session/transport.js";

const PICTURE_MEDIA_TYPES: ReadonlySet<string> = new Set(CLAUDE_PICTURE_MEDIA_TYPES);

// Claude Code's default per-picture limit on an image block's base64 text, which it checks before
// a request and Anthropic's API enforces as its 5 MB per-image limit.
const CLAUDE_PICTURE_BASE64_LIMIT = 5_242_880;

// A picture larger than Claude Code takes, in Claude Code's own refusal led by the file's name.
class ClaudePictureTooLargeError extends Error {
  constructor(fileName: string, base64Size: number) {
    super(
      `${fileName}: Image base64 size (${base64Size}) exceeds API limit ` +
        `(${CLAUDE_PICTURE_BASE64_LIMIT}). Please resize the image before sending.`,
    );
    this.name = "ClaudePictureTooLargeError";
  }
}

function isClaudePicture(
  attachment: ProviderAttachment,
): attachment is ResolvedAttachment & { readonly mediaType: ClaudePictureMediaType } {
  return attachment.kind === "resolved" && PICTURE_MEDIA_TYPES.has(attachment.mediaType);
}

/**
 * The content blocks a message's attachments follow its words with, one per attachment in staging
 * order. Throws the resolver's failure, the file system's when a picture cannot be read, and
 * a refusal in Claude Code's own words, naming the file, for a picture past its limit.
 */
export async function composeClaudeAttachmentBlocks(
  resolver: AttachmentResolver,
  sessionId: SessionId,
  artifactIds: readonly ArtifactId[] | undefined,
): Promise<ClaudeUserContentBlock[]> {
  const attachments = await resolveMessageAttachments(resolver, sessionId, artifactIds);
  return await Promise.all(
    attachments.map(async (attachment): Promise<ClaudeUserContentBlock> => {
      if (!isClaudePicture(attachment)) {
        return { type: "text", text: composeAttachmentText(attachment) };
      }
      // Base64 spends four characters on every three bytes, so the size is known before a read.
      const base64Size = 4 * Math.ceil((await stat(attachment.path)).size / 3);
      if (base64Size > CLAUDE_PICTURE_BASE64_LIMIT) {
        throw new ClaudePictureTooLargeError(attachment.fileName, base64Size);
      }
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.mediaType,
          data: (await readFile(attachment.path)).toString("base64"),
        },
      };
    }),
  );
}
