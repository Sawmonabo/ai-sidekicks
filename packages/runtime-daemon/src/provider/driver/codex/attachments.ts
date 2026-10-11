// A message as Codex's turn input takes it: its words as a text item, each skill picked for it as
// a `skill` item naming the file Codex listed it from, and its staged files, a picture as a
// `localImage` item naming its stored copy and any other file as a text item in its own place
// naming its stored copy, which the agent opens itself, or saying why it could not be delivered.
// Codex leaves a `mention` item out of what the model reads, so a file never goes as one.

import { composeAttachmentText, type ProviderAttachment } from "../attachments.js";
import type { CodexTurnMessage } from "./session/state.js";

// The picture formats Codex is handed as an image rather than as a file to open.
const CODEX_PICTURE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function composeCodexAttachmentInput(attachment: ProviderAttachment): Record<string, unknown> {
  return attachment.kind === "resolved" && CODEX_PICTURE_MEDIA_TYPES.has(attachment.mediaType)
    ? { type: "localImage", path: attachment.path }
    : { type: "text", text: composeAttachmentText(attachment), text_elements: [] };
}

/**
 * The input items of the person's messages, in send order: each message's words as a text item,
 * then an item per picked skill in the order picked, then an item per staged file in staging order.
 */
export function composeCodexMessageInput(
  messages: readonly CodexTurnMessage[],
): Record<string, unknown>[] {
  return messages.flatMap((message) => [
    { type: "text", text: message.text, text_elements: [] },
    ...message.skills.map((skill) => ({ type: "skill", name: skill.name, path: skill.path })),
    ...message.attachments.map(composeCodexAttachmentInput),
  ]);
}
