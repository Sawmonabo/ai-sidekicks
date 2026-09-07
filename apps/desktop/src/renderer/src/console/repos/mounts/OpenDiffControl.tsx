// The one press that puts a change set on screen for a row's own subject.
//
// A COMPONENT RATHER THAN A BUTTON WRITTEN TWICE, on `apps/desktop/AGENTS.md`'s
// second-use rule: the workspace row and the worktree row both offer it, they are in
// two different sub-directories, and the label, the glyph, and the accessible name are
// the same claim in both places.
//
// IT IMPORTS NOTHING FROM `diff-pane/`, AND THAT IS THE POINT. The diff pane's body
// arrives as its own chunk — `repos/index.ts` registers it through a loader so the
// patch parser and the row renderer stay off the initial import graph — and a control
// on the sidebar's own cards is squarely ON that graph. Reaching for a subject type or
// a request builder from over there would pull the whole pane back onto first paint to
// draw one button.
//
// IT DECIDES NOTHING ABOUT ELIGIBILITY. Which attribution a subject resolves to, and
// whether it resolves at all, is the pane's own question and is answered against a
// wire read; a control that pre-judged it here would be a second source of truth for
// an answer the daemon owns. So the press always opens the pane, and the pane says
// what it found.

import { Glyph } from "../../primitives/index.js";
import { GLYPH_SIZE_CHROME } from "../../tokens/index.js";
import type { ConsoleEntityRef } from "../../store/index.js";

/**
 * What a diff can be opened over from a repo row.
 *
 * NARROWED FROM THE STORE'S OWN REFERENCE rather than declared beside it, so the two
 * kinds here are two members of the console's one entity vocabulary and not a third
 * spelling of them. These are exactly the two rows that carry a checkout: a mount
 * holds several and an invitation or a member holds none.
 */
export type OpenDiffSubject = ConsoleEntityRef & { readonly kind: "workspace" | "worktree" };

export interface OpenDiffControlProps {
  readonly subject: OpenDiffSubject;
  /** Open the pane. Supplied by whoever owns the deck, never reached for. */
  readonly onOpenDiff: (subject: OpenDiffSubject) => void;
}

export function OpenDiffControl(props: OpenDiffControlProps): React.JSX.Element {
  const { subject } = props;
  return (
    <button
      type="button"
      className="meridian-open-diff"
      onClick={() => {
        props.onOpenDiff(subject);
      }}
      // THE ID IS IN THE NAME, because a mount with three workspaces draws three of
      // these and a name of "Changes" alone would be three identical controls to
      // anyone reading the row by its accessible name rather than by its position.
      aria-label={`Open the changes of ${subject.kind} ${subject.id}`}
    >
      <Glyph name="diff" size={GLYPH_SIZE_CHROME} />
      Changes
    </button>
  );
}
