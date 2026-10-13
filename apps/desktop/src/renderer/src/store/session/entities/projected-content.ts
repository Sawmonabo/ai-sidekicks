// A row's body as the console admits it: the text of an available one is packed and sealed at
// once, so the string the wire brought is let go with the reply that carried it.

import type { HydratedSessionEventContent } from "@ai-sidekicks/contracts/event/envelope";
import type { TranscriptRowContent } from "@ai-sidekicks/contracts/transcript/content";

import { PackedText } from "#renderer/lib/text/packed.js";
import type { ProjectedFullBody, ProjectedRowContent } from "./vocabulary.js";

/**
 * `content` as the console holds it: an available body's text packed and sealed; the other arms
 * carry no text and pass as they are.
 */
export function projectedContentOf(content: HydratedSessionEventContent): ProjectedFullBody;
export function projectedContentOf(content: TranscriptRowContent): ProjectedRowContent;
export function projectedContentOf(content: TranscriptRowContent): ProjectedRowContent {
  return content.status === "available"
    ? { ...content, body: PackedText.of(content.body) }
    : content;
}
