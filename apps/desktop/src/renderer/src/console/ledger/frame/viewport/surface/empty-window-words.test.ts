// What an empty window says, and the three-valued grant that changes one of them.
//
// The property under test is a negative as much as a positive: the sentence that
// names the peer-invocation control has to appear for a session that reported the
// grant OFF and for nothing else — not for a channel window, not for an enabled
// session, and above all not for a session whose read never carried the member,
// because that one is unknown and rendering unknown as off is the one wrong answer.

import { describe, expect, it } from "vitest";

import { emptyLedgerWords } from "./empty-window-words.js";

/** How the grant's own surface heads itself, which is what the sentence must name. */
const CONTROL_NAME = "Sidekicks reaching each other";

describe("the empty ledger window's words", () => {
  it("names the peer-invocation control when the session reported the grant off", () => {
    const words = emptyLedgerWords("session", false);
    expect(words.detail).toContain(CONTROL_NAME);
    // The log really is empty, so the first line is unchanged — what the grant
    // changes is what a reader is told would fill it.
    expect(words.title).toBe(emptyLedgerWords("session", true).title);
  });

  it("negative control: an enabled session gets the ordinary sentence", () => {
    // Without this, the case above would pass over a rule that named the control
    // unconditionally — which would tell every reader of every empty session that a
    // capability they have is switched off.
    expect(emptyLedgerWords("session", true).detail).not.toContain(CONTROL_NAME);
  });

  it("never renders the unknown grant as off", () => {
    // The member is absent from a responder that predates it, and that session looks
    // identical to one with the grant on. Both spellings of absence take the
    // ordinary sentence.
    expect(emptyLedgerWords("session", undefined).detail).not.toContain(CONTROL_NAME);
    expect(emptyLedgerWords("session").detail).not.toContain(CONTROL_NAME);
    expect(emptyLedgerWords("session").detail).toBe(emptyLedgerWords("session", true).detail);
  });

  it("leaves a channel window's sentence alone whatever the session's grant is", () => {
    // The grant is a fact about the session; this window is a log of one channel,
    // and a session-wide explanation here would answer a question nobody asked of it.
    const channelWords = emptyLedgerWords("channel", false);
    expect(channelWords.detail).not.toContain(CONTROL_NAME);
    expect(channelWords).toStrictEqual(emptyLedgerWords("channel", true));
    expect(channelWords.title).toContain("channel");
  });

  it("says something different for each scope", () => {
    // Two subjects, two sentences: "nothing has happened in this session" over a
    // channel pane is false about the session and reads as though it were.
    expect(emptyLedgerWords("session").title).not.toBe(emptyLedgerWords("channel").title);
    expect(emptyLedgerWords("session").detail).not.toBe(emptyLedgerWords("channel").detail);
  });
});
