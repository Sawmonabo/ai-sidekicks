/**
 * Finds the continuity markers a delivered memo left in a target's turns and reads the losses each
 * declared, so a repeat delivery is recognized instead of duplicated.
 */

import type { DeclaredLossKind } from "@ai-sidekicks/contracts";
import { DECLARED_LOSS_KINDS } from "@ai-sidekicks/contracts";
import {
  MEMO_CONTINUITY_LOSS_JOINER,
  MEMO_CONTINUITY_LOSS_SEPARATOR,
  MEMO_CONTINUITY_MARKER_PREFIX,
  MEMO_FLOOR_DECLARED_LOSS_KIND,
  MEMO_IDENTITY_KEY_BYTE_LENGTH,
} from "./memo-projection.js";

/**
 * Characters that continue a token, so a marker abutting one is part of something longer. Without
 * the boundary, a memo whose key merely extends ours would read as this memo delivered.
 */
const MEMO_MARKER_TOKEN_CHARACTER = /[A-Za-z0-9_-]/;

/** One syntactically complete marker occurrence in a target turn, whatever memo wrote it. */
export type MemoContinuityMarkerOccurrence =
  | {
      readonly form: "recorded";
      readonly memoIdentityKey: string;
      readonly kinds: ReadonlySet<DeclaredLossKind>;
    }
  | { readonly form: "key-only"; readonly memoIdentityKey: string }
  | { readonly form: "unreadable-record"; readonly memoIdentityKey: string };

/** A record's parse, before the scanner attaches the key that carried it. */
type MemoContinuityRecordReading =
  | { readonly form: "recorded"; readonly kinds: ReadonlySet<DeclaredLossKind> }
  | { readonly form: "unreadable-record" };

/** The identity key's exact wire shape: lowercase hex, two characters per digest byte. */
const MEMO_IDENTITY_KEY_TEXT_PATTERN: RegExp = new RegExp(
  `^[0-9a-f]{${String(MEMO_IDENTITY_KEY_BYTE_LENGTH * 2)}}`,
);

/**
 * Every complete continuity marker in the target's turns, whichever memo wrote it, in read order.
 * It scans for any key because a grown projection derives a new key. A key counts only in its
 * exact shape at token boundaries; a complete marker with a garbage record is still a marker.
 */
export function readAnyMemoContinuityMarkerOccurrences(
  targetTurns: readonly string[],
): readonly MemoContinuityMarkerOccurrence[] {
  const occurrences: MemoContinuityMarkerOccurrence[] = [];
  for (const turnText of targetTurns) {
    for (
      let markerStart: number = turnText.indexOf(MEMO_CONTINUITY_MARKER_PREFIX);
      markerStart >= 0;
      markerStart = turnText.indexOf(
        MEMO_CONTINUITY_MARKER_PREFIX,
        markerStart + MEMO_CONTINUITY_MARKER_PREFIX.length,
      )
    ) {
      const precedingCharacter: string = turnText.slice(Math.max(0, markerStart - 1), markerStart);
      if (precedingCharacter !== "" && MEMO_MARKER_TOKEN_CHARACTER.test(precedingCharacter)) {
        continue;
      }
      const afterPrefix: string = turnText.slice(
        markerStart + MEMO_CONTINUITY_MARKER_PREFIX.length,
      );
      const memoIdentityKey: string | undefined =
        MEMO_IDENTITY_KEY_TEXT_PATTERN.exec(afterPrefix)?.[0];
      if (memoIdentityKey === undefined) {
        continue;
      }
      const tail: string = afterPrefix.slice(memoIdentityKey.length);
      if (!tail.startsWith(MEMO_CONTINUITY_LOSS_SEPARATOR)) {
        // The key-only form is complete only where the token ends.
        const followingCharacter: string = tail.slice(0, 1);
        if (followingCharacter !== "" && MEMO_MARKER_TOKEN_CHARACTER.test(followingCharacter)) {
          continue;
        }
        occurrences.push({ form: "key-only", memoIdentityKey });
        continue;
      }
      occurrences.push({
        ...readMemoContinuityRecord(tail.slice(MEMO_CONTINUITY_LOSS_SEPARATOR.length)),
        memoIdentityKey,
      });
    }
  }
  return occurrences;
}

/** The occurrences of one memo's marker: the any-key grammar, filtered by key. */
function readMemoContinuityMarkerOccurrences(
  targetTurns: readonly string[],
  memoIdentityKey: string,
): readonly MemoContinuityMarkerOccurrence[] {
  return readAnyMemoContinuityMarkerOccurrences(targetTurns).filter(
    (occurrence) => occurrence.memoIdentityKey === memoIdentityKey,
  );
}

/**
 * Parses one record (the text after `;dropped=`) strictly: a `+`-joined list of recognized kinds
 * that includes the floor's own kind. This writer never emits a list without it, so reading one as
 * "nothing lost" would be a false guarantee.
 */
function readMemoContinuityRecord(record: string): MemoContinuityRecordReading {
  // Anything but lowercase ASCII, `_` and `+` (a space, a newline, following prose) ends the
  // record.
  const tokenRun: string = /^[a-z_+]*/.exec(record)?.[0] ?? "";
  if (tokenRun.length === 0) {
    return { form: "unreadable-record" };
  }
  const kinds: Set<DeclaredLossKind> = new Set<DeclaredLossKind>();
  for (const component of tokenRun.split(MEMO_CONTINUITY_LOSS_JOINER)) {
    const kind: DeclaredLossKind | undefined = DECLARED_LOSS_KINDS.find(
      (candidate) => candidate === component,
    );
    if (kind === undefined) {
      return { form: "unreadable-record" };
    }
    kinds.add(kind);
  }
  if (!kinds.has(MEMO_FLOOR_DECLARED_LOSS_KIND)) {
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
export function targetTurnsCarryAttributableMemoMarker(
  targetTurns: readonly string[],
  attributableMemoIdentityKeys: ReadonlySet<string>,
): boolean {
  return readAnyMemoContinuityMarkerOccurrences(targetTurns).some((occurrence) =>
    attributableMemoIdentityKeys.has(occurrence.memoIdentityKey),
  );
}

/**
 * Whether any target turn carries a complete marker for this memo's key, that is, whether the send
 * just made landed. Deliveries are serialized per target, so a readback can only newly find it.
 */
export function targetTurnsCarryMemoMarker(
  targetTurns: readonly string[],
  memoIdentityKey: string,
): boolean {
  return readMemoContinuityMarkerOccurrences(targetTurns, memoIdentityKey).length > 0;
}

/**
 * The union of the loss kinds the memo already in the target recorded as dropped, or `undefined`
 * with no marker or any occurrence lacking a readable record; the caller then owes the
 * conservative answer.
 */
export function readDeliveredMemoDeclaredLosses(
  targetTurns: readonly string[],
  memoIdentityKey: string,
): readonly DeclaredLossKind[] | undefined {
  const occurrences: readonly MemoContinuityMarkerOccurrence[] =
    readMemoContinuityMarkerOccurrences(targetTurns, memoIdentityKey);
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
