/**
 * Finds the continuity markers a delivered brief left in a target's turns and reads the losses each
 * declared, so a repeat delivery is recognized instead of duplicated.
 */

import type { DeclaredLossKind } from "@ai-sidekicks/contracts";
import { DECLARED_LOSS_KINDS } from "@ai-sidekicks/contracts";
import {
  BRIEF_CONTINUITY_LOSS_JOINER,
  BRIEF_CONTINUITY_LOSS_SEPARATOR,
  BRIEF_CONTINUITY_MARKER_PREFIX,
  BRIEF_FLOOR_DECLARED_LOSS_KIND,
  BRIEF_IDENTITY_KEY_BYTE_LENGTH,
} from "./hand-over-brief.js";

/**
 * Characters that continue a token, so a marker abutting one is part of something longer. Without
 * the boundary, a brief whose key merely extends ours would read as this brief delivered.
 */
const BRIEF_MARKER_TOKEN_CHARACTER = /[A-Za-z0-9_-]/;

/** One syntactically complete marker occurrence in a target turn, whatever brief wrote it. */
export type BriefContinuityMarkerOccurrence =
  | {
      readonly form: "recorded";
      readonly briefIdentityKey: string;
      readonly kinds: ReadonlySet<DeclaredLossKind>;
    }
  | { readonly form: "key-only"; readonly briefIdentityKey: string }
  | { readonly form: "unreadable-record"; readonly briefIdentityKey: string };

/** A record's parse, before the scanner attaches the key that carried it. */
type BriefContinuityRecordReading =
  | { readonly form: "recorded"; readonly kinds: ReadonlySet<DeclaredLossKind> }
  | { readonly form: "unreadable-record" };

/** The identity key's exact wire shape: lowercase hex, two characters per digest byte. */
const BRIEF_IDENTITY_KEY_TEXT_PATTERN: RegExp = new RegExp(
  `^[0-9a-f]{${String(BRIEF_IDENTITY_KEY_BYTE_LENGTH * 2)}}`,
);

/**
 * Every complete continuity marker in the target's turns, whichever brief wrote it, in read order.
 * It scans for any key because a grown projection derives a new key. A key counts only in its
 * exact shape at token boundaries; a complete marker with a garbage record is still a marker.
 */
export function readAnyBriefContinuityMarkerOccurrences(
  targetTurns: readonly string[],
): readonly BriefContinuityMarkerOccurrence[] {
  const occurrences: BriefContinuityMarkerOccurrence[] = [];
  for (const turnText of targetTurns) {
    for (
      let markerStart: number = turnText.indexOf(BRIEF_CONTINUITY_MARKER_PREFIX);
      markerStart >= 0;
      markerStart = turnText.indexOf(
        BRIEF_CONTINUITY_MARKER_PREFIX,
        markerStart + BRIEF_CONTINUITY_MARKER_PREFIX.length,
      )
    ) {
      const precedingCharacter: string = turnText.slice(Math.max(0, markerStart - 1), markerStart);
      if (precedingCharacter !== "" && BRIEF_MARKER_TOKEN_CHARACTER.test(precedingCharacter)) {
        continue;
      }
      const afterPrefix: string = turnText.slice(
        markerStart + BRIEF_CONTINUITY_MARKER_PREFIX.length,
      );
      const briefIdentityKey: string | undefined =
        BRIEF_IDENTITY_KEY_TEXT_PATTERN.exec(afterPrefix)?.[0];
      if (briefIdentityKey === undefined) {
        continue;
      }
      const tail: string = afterPrefix.slice(briefIdentityKey.length);
      if (!tail.startsWith(BRIEF_CONTINUITY_LOSS_SEPARATOR)) {
        // The key-only form is complete only where the token ends.
        const followingCharacter: string = tail.slice(0, 1);
        if (followingCharacter !== "" && BRIEF_MARKER_TOKEN_CHARACTER.test(followingCharacter)) {
          continue;
        }
        occurrences.push({ form: "key-only", briefIdentityKey });
        continue;
      }
      occurrences.push({
        ...readBriefContinuityRecord(tail.slice(BRIEF_CONTINUITY_LOSS_SEPARATOR.length)),
        briefIdentityKey,
      });
    }
  }
  return occurrences;
}

/** The occurrences of one brief's marker: the any-key grammar, filtered by key. */
function readBriefContinuityMarkerOccurrences(
  targetTurns: readonly string[],
  briefIdentityKey: string,
): readonly BriefContinuityMarkerOccurrence[] {
  return readAnyBriefContinuityMarkerOccurrences(targetTurns).filter(
    (occurrence) => occurrence.briefIdentityKey === briefIdentityKey,
  );
}

/**
 * Parses one record (the text after `;dropped=`) strictly: a `+`-joined list of recognized kinds
 * that includes the floor's own kind. This writer never emits a list without it, so reading one as
 * "nothing lost" would be a false guarantee.
 */
function readBriefContinuityRecord(record: string): BriefContinuityRecordReading {
  // Anything but lowercase ASCII, `_` and `+` (a space, a newline, following prose) ends the
  // record.
  const tokenRun: string = /^[a-z_+]*/.exec(record)?.[0] ?? "";
  if (tokenRun.length === 0) {
    return { form: "unreadable-record" };
  }
  const kinds: Set<DeclaredLossKind> = new Set<DeclaredLossKind>();
  for (const component of tokenRun.split(BRIEF_CONTINUITY_LOSS_JOINER)) {
    const kind: DeclaredLossKind | undefined = DECLARED_LOSS_KINDS.find(
      (candidate) => candidate === component,
    );
    if (kind === undefined) {
      return { form: "unreadable-record" };
    }
    kinds.add(kind);
  }
  if (!kinds.has(BRIEF_FLOOR_DECLARED_LOSS_KIND)) {
    return { form: "unreadable-record" };
  }
  return { form: "recorded", kinds };
}

/**
 * Whether any target turn carries a complete marker for an attributable key: one attempted
 * against this target (a grown projection derives a new key) or the one being delivered now. Any
 * key would let a pasted foreign marker pass; a false yes loses the context transfer, while a
 * false no costs one extra summary.
 */
export function targetTurnsCarryAttributableBriefMarker(
  targetTurns: readonly string[],
  attributableBriefIdentityKeys: ReadonlySet<string>,
): boolean {
  return readAnyBriefContinuityMarkerOccurrences(targetTurns).some((occurrence) =>
    attributableBriefIdentityKeys.has(occurrence.briefIdentityKey),
  );
}

/**
 * Whether any target turn carries a complete marker for this brief's key, that is, whether the send
 * just made landed. Deliveries are serialized per target, so a readback can only newly find it.
 */
export function targetTurnsCarryBriefMarker(
  targetTurns: readonly string[],
  briefIdentityKey: string,
): boolean {
  return readBriefContinuityMarkerOccurrences(targetTurns, briefIdentityKey).length > 0;
}

/**
 * The union of the loss kinds the brief already in the target recorded as dropped, or `undefined`
 * with no marker or any occurrence lacking a readable record; the caller then owes the
 * conservative answer.
 */
export function readDeliveredBriefDeclaredLosses(
  targetTurns: readonly string[],
  briefIdentityKey: string,
): readonly DeclaredLossKind[] | undefined {
  const occurrences: readonly BriefContinuityMarkerOccurrence[] =
    readBriefContinuityMarkerOccurrences(targetTurns, briefIdentityKey);
  if (occurrences.length === 0) {
    return undefined;
  }
  const recorded: Set<DeclaredLossKind> = new Set<DeclaredLossKind>();
  for (const occurrence of occurrences) {
    if (occurrence.form !== "recorded") {
      return undefined;
    }
    for (const kind of occurrence.kinds) {
      recorded.add(kind);
    }
  }
  return DECLARED_LOSS_KINDS.filter((kind) => recorded.has(kind));
}
