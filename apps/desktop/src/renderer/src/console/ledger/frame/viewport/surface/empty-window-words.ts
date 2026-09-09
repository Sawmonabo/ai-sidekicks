// What an empty ledger window says, and the one fact that changes it.
//
// A MODULE RATHER THAN A TABLE INSIDE THE VIEWPORT, because this stopped being a
// lookup the moment a second input joined the scope: the session-scoped sentence
// depends on whether the sidekicks in this session may reach each other, and a
// rule with two inputs and three outcomes is a function with its own cases rather
// than a record literal a component indexes.
//
// WHY THE GRANT CHANGES THE SENTENCE AT ALL. A session whose peer-invocation grant
// is OFF cannot produce a handoff row: the two peer tools are registered at spawn
// and every invocation is adjudicated per call against the projected grant, so each
// one answers denied and nothing reaches the log. "Nothing has happened in this
// session yet" is true of that session and says the wrong thing about it — it reads
// as an absence of activity when part of what a reader might be waiting for is
// switched off. So the empty window names the control instead of leaving the
// connection to be guessed at.
//
// AND ONLY `false` DOES THAT. The projected member is three-valued: present and
// true, present and false, and ABSENT — a responder that predates the member looks
// identical to one that has the grant turned off. Naming the control on the absent
// arm would render an unknown state as off, which is the one wrong answer here, so
// the ordinary sentence stands for both the enabled and the unknown session.
//
// AND ONLY THE SESSION SCOPE. A channel window's emptiness is a fact about that
// channel; the grant is a fact about the session it belongs to, and hanging a
// session-wide explanation on a channel's empty log would answer a question nobody
// asked of it.

/**
 * What a ledger is a log OF — the one thing an empty window's sentence turns on.
 *
 * DECLARED HERE BECAUSE THIS IS THE LOWEST CONSUMER, and every surface above
 * derives from this union rather than re-spelling the two words: the feed's
 * absences say the same thing about the same two subjects, and two unions would
 * drift the day a third scope exists.
 */
export type LedgerScope = "session" | "channel";

/** The two lines an empty window carries: what is absent, and what would fill it. */
export interface EmptyLedgerWords {
  readonly title: string;
  readonly detail: string;
}

/**
 * The ordinary sentence, per scope.
 *
 * "Nothing has happened in this session yet" over a CHANNEL pane is false about the
 * session and says so with the session's own name: the pane is a log of one channel
 * and the session it belongs to may be busy. Total over the scope by `satisfies`, so
 * a third scope is a compile error here rather than a pane that borrows one of these
 * two sentences.
 */
const ORDINARY_WORDS = {
  session: {
    title: "Nothing has happened in this session yet.",
    detail: "Entries appear here as people and agents work.",
  },
  channel: {
    title: "Nothing has happened in this channel yet.",
    detail: "Entries appear here as people and agents work in it.",
  },
} as const satisfies Readonly<Record<LedgerScope, EmptyLedgerWords>>;

/**
 * The session-scoped sentence for a session whose peer-invocation grant is off.
 *
 * The control is named the way the control names ITSELF — "Sidekicks reaching each
 * other", the heading of the grant's own surface — so a reader who goes looking for
 * it finds the words they were just given rather than a paraphrase of them. The
 * title is unchanged, because the log really is empty; what changes is the second
 * line, which is where a reader is told what would fill it.
 */
const PEER_INVOCATION_OFF_WORDS: EmptyLedgerWords = {
  title: ORDINARY_WORDS.session.title,
  detail:
    "Entries appear here as people and agents work. Sidekicks reaching each other is off for this session, so one sidekick handing work to another starts nothing here until it is turned on.",
};

/**
 * What this empty window says.
 *
 * @param scope what the window is a log of.
 * @param peerInvocationEnabled the projected grant, or `undefined` where the
 *   session read did not report it. Absence is not off.
 */
export function emptyLedgerWords(
  scope: LedgerScope,
  peerInvocationEnabled?: boolean | undefined,
): EmptyLedgerWords {
  return scope === "session" && peerInvocationEnabled === false
    ? PEER_INVOCATION_OFF_WORDS
    : ORDINARY_WORDS[scope];
}
