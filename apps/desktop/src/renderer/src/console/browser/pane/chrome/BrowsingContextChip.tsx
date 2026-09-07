// The strip's leading chip: the browsing context name the agent set.
//
// Its own module for `apps/desktop/AGENTS.md`'s one-component rule, and it reads as
// one: the strip draws the session's pages, and this draws the CONTEXT those pages
// belong to, which is a different subject with a different source.
//
// IT RENDERS ITS OWN ABSENCE rather than falling back to a word like "Browser". The
// context name is a thing an agent sets through a tool, and a chip that invented one
// would tell a person the agent had named its context when it had not.
//
// AND IT BRANCHES ON THE READING BEFORE IT LOOKS FOR A NAME, which is the correction
// this module carries. `null` is the wire's value for a served context nobody named,
// and it was also what the absence of a reading collapsed to — so a pending, refused,
// or ended page-list subscription drew "Unnamed context", stating as a fact about the
// agent something no frame had said. That is rule 8's collapse in one line: three
// readings and an answer, rendered as the answer. The four arms below are the union's
// own, so a fifth reading fails to compile here rather than inheriting whichever
// sentence sat closest.

import type { PageListReading } from "../page-state.js";

/** Every reading that carries no frame, and therefore no context name to render. */
type UnreportedContextKind = Exclude<PageListReading["kind"], "served">;

/**
 * What the chip says when no frame has named a context — one sentence per reading.
 *
 * Total over the union by construction rather than by a default arm, which is what
 * makes the claim checkable: a default would render one of these three sentences for
 * a reading nobody had written copy for, and the sentence would be wrong two times in
 * three. The wording is the strip's own — `TabStrip.tsx` says "Pages not read" and
 * "Pages no longer reported" for the same three arms of the same reading, and two
 * halves of one row that describe one subscription in two vocabularies read as two
 * subscriptions.
 */
const UNREPORTED_CONTEXT_COPY: Readonly<Record<UnreportedContextKind, string>> = {
  reading: "Context not read",
  refused: "Context not reported",
  ended: "Context no longer reported",
};

export function BrowsingContextChip(props: {
  readonly reading: PageListReading;
}): React.JSX.Element {
  const { reading } = props;
  if (reading.kind !== "served") {
    return (
      <span className="meridian-browser-tabs__context meridian-browser-tabs__context--unreported">
        {UNREPORTED_CONTEXT_COPY[reading.kind]}
      </span>
    );
  }
  const contextName = reading.frame.contextName;
  return contextName === null || contextName.length === 0 ? (
    <span className="meridian-browser-tabs__context meridian-browser-tabs__context--unnamed">
      Unnamed context
    </span>
  ) : (
    <span className="meridian-browser-tabs__context">{contextName}</span>
  );
}
