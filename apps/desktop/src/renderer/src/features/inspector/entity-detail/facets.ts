// The vocabulary one entity's record is written in: what a detail is handed, and what it may
// put on a row.
//
// A facet is a value with a closed form, not a `ReactNode`, so `EntityRecord.tsx` is the only
// module turning one into markup and no detail picks its own formatter. Builders take `unknown`
// because `StoredEntity.body` is a renderer-local map whose shape no projector has fixed; each
// has an absent arm, so a member the body does not carry is never a blank cell, a zero or a
// dash.

import type { StoredEntity } from "#renderer/store/session/entities/vocabulary.js";
import type { SessionDegradedCause } from "#renderer/store/session/degradation.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import { formatClockTime, formatZonedDateTime } from "#renderer/lib/wire/figures.js";
import { parseInstant } from "#renderer/lib/instant.js";
import { readWireString } from "#renderer/lib/wire/strings.js";

/**
 * What every per-kind detail is handed.
 *
 * Declared here rather than beside the registry, which imports every detail: putting the
 * props there would close a cycle.
 */
export interface EntityDetailProps {
  /** The stored record, or `undefined` where the store holds none for this id. */
  readonly entity: StoredEntity | undefined;
  /** The id the pane layout addressed this pane with, wire-verbatim. */
  readonly entityId: string;
  /** The session store the record is read from. Details that compose read from it. */
  readonly sessionStore: SessionStore;
  /** `false` until the store's first read has answered. */
  readonly isInitialized: boolean;
  /** Set while the projection is known-incomplete; `undefined` while it is whole. */
  readonly degradedCause: SessionDegradedCause | undefined;
  /**
   * The pane this inspector was opened from, when the pane layout linked the two.
   *
   * An id, not a handle: a link must not cost either pane its independence.
   */
  readonly linkedSourcePaneId: string | undefined;
}

/**
 * What a facet's value is, closed at four forms.
 *
 * The forms are the console's provenance signature: a value the wire supplied is mono, one the
 * console computed is not, and one that is not there is neither. An instant is the wire's too:
 * its wall-clock reading, the zoned time its hover shows, and the exact stamp the daemon sent.
 */
export type EntityFacetValue =
  | { readonly form: "wire"; readonly text: string }
  | { readonly form: "derived"; readonly text: string }
  | {
      readonly form: "instant";
      readonly text: string;
      readonly clockText: string;
      readonly zonedText: string;
    }
  | { readonly form: "unrecorded"; readonly detail: string };

/** One labeled row of an entity's record. */
export interface EntityFacet {
  /** The member's name in the console's own words, not the body key. */
  readonly label: string;
  readonly value: EntityFacetValue;
}

/** Read one member of an entity's kind-specific body. `undefined` where absent. */
export function readBodyMember(entity: StoredEntity | undefined, memberName: string): unknown {
  return entity?.body?.[memberName];
}

/** A string the wire supplied — an id, a handle, a state name. Mono and verbatim. */
export function wireFacet(label: string, value: unknown, memberName: string): EntityFacet {
  // The empty string is absent: `readWireString` owns that rule, not this builder.
  const text = readWireString(value);
  return {
    label,
    value: text === undefined ? unrecorded(memberName) : { form: "wire", text },
  };
}

/**
 * An instant, as a wall-clock reading in `locale`, the machine's clock locale, beside the exact
 * stamp the daemon sent, with the zoned time on hover.
 *
 * Wall clock rather than relative: a relative phrase is only true for an instant and the
 * console has no timer. A string that does not parse takes the absent arm, since an em dash
 * reads as "there is none".
 */
export function instantFacet(
  label: string,
  value: unknown,
  memberName: string,
  locale: string,
): EntityFacet {
  if (typeof value !== "string" || parseInstant(value).kind === "malformed") {
    return { label, value: unrecorded(memberName) };
  }
  return {
    label,
    value: {
      form: "instant",
      text: value,
      clockText: formatClockTime(value, locale),
      zonedText: formatZonedDateTime(value, locale),
    },
  };
}

/** The sentence an absent member carries; one generator so the claim cannot drift. */
function unrecorded(memberName: string): EntityFacetValue {
  return {
    form: "unrecorded",
    detail:
      `The record the console holds carries no ${memberName}. A member ` +
      "that has not been projected is not a member that is empty.",
  };
}
