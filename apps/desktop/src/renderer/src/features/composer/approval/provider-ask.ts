// Whether an approval arrived as a provider's mid-run permission ask. `askId` is on the
// `approval.requested` event payload but not on the projection read, so this reads the projected
// entity's body rather than the record the pane's read answered with.

import { readWireString } from "@renderer/lib/wire-strings.js";
import { type StoredEntity } from "@renderer/store/session/entities/entities.js";

/** One approval's provider-ask origin. */
export interface ProviderAsk {
  /** The daemon's durable id for the ask, wire-verbatim. */
  readonly askId: string;
}

/**
 * The provider-ask origin of one approval, or `undefined`. A missing entity, a missing body,
 * and a missing or non-string or empty `askId` are one answer: render the ordinary card.
 */
export function providerAskFor(entity: StoredEntity | undefined): ProviderAsk | undefined {
  const askId = readWireString(entity?.body?.["askId"]);
  if (askId === undefined) {
    return undefined;
  }
  return { askId };
}
