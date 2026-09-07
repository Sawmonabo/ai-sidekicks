// The create form's closed field vocabulary, and the value two moments of a draft are
// compared by.
//
// A MODULE BESIDE THE DRAFT RATHER THAN INSIDE IT. `create-channel-draft.ts` holds what
// a person has typed and composes the one request out of it; what lives here is the
// shape that leaves the draft and the single rule that reads two of them. The split is
// what keeps the comparison honest: a member added to the snapshot below is a member
// {@link draftSnapshotsMatch} walks, because both are declared in one place, and a
// comparison written beside the private fields it reads would have been free to forget
// one and stay green.

import type {
  GrowthChannelAudience,
  GrowthChannelKind,
  GrowthChannelTurnPolicy,
} from "../../bridge/index.js";

/**
 * The moderation members a person can touch, declared once.
 *
 * The tuple is what the form iterates, what the draft keys its touched set on, and the
 * order the snapshot below carries them in, so a third moderation member arrives in all
 * three places or in none.
 */
export const CHANNEL_MODERATION_FIELDS = ["preTurnGate", "postTurnReview"] as const;

/** One moderation member. Derived from the tuple, never restated. */
export type ChannelModerationField = (typeof CHANNEL_MODERATION_FIELDS)[number];

/**
 * Everything a person had typed at one moment, as one comparable value.
 *
 * COMPOSED AND NEVER HELD. The draft's fields are private and this is what leaves it, so
 * a snapshot is a reading taken at a moment rather than a second copy the draft has to
 * keep in step. The moderation entries ride as a POSITIONAL list off the tuple above —
 * one entry per declared member, `undefined` where nobody has touched it — so the
 * comparison walks a fixed width rather than reasoning about map keys, and an untouched
 * member and a member set back to its old value read as the same fact, which is what
 * they are.
 */
export interface CreateChannelDraftSnapshot {
  readonly name: string;
  readonly kind: GrowthChannelKind;
  readonly audience: GrowthChannelAudience | undefined;
  readonly turnPolicy: GrowthChannelTurnPolicy | undefined;
  readonly roundRobinOrder: string;
  readonly turnsPerAgent: string;
  /** One entry per {@link CHANNEL_MODERATION_FIELDS} member, in that order. */
  readonly moderation: readonly (boolean | undefined)[];
  readonly otherParticipantId: string | undefined;
}

/**
 * Whether two readings of one draft say the same thing.
 *
 * Member by member and never by identity, because a snapshot is composed fresh each
 * time it is taken — two readings of an untouched draft are different objects carrying
 * the same answer, and that is exactly the case this has to report as a match.
 */
export function draftSnapshotsMatch(
  left: CreateChannelDraftSnapshot,
  right: CreateChannelDraftSnapshot,
): boolean {
  return (
    left.name === right.name &&
    left.kind === right.kind &&
    left.audience === right.audience &&
    left.turnPolicy === right.turnPolicy &&
    left.roundRobinOrder === right.roundRobinOrder &&
    left.turnsPerAgent === right.turnsPerAgent &&
    left.otherParticipantId === right.otherParticipantId &&
    left.moderation.length === right.moderation.length &&
    left.moderation.every((touched, index) => touched === right.moderation[index])
  );
}
