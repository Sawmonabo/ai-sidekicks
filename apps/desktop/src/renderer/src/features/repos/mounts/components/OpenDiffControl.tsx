// The button that opens a change set for a workspace or worktree row. It imports nothing from
// `diff/`: the diff pane loads as its own chunk, and a static import here would pull the patch
// parser and row renderer onto first paint. It never judges eligibility; the pane resolves the
// subject and says what it found.

import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { GLYPH_SIZE_CHROME } from "#renderer/styles/glyphs.js";
import type { EntityRef } from "#renderer/lib/entity-kinds.js";

/**
 * What a diff can be opened over from a repo row: the two entity kinds that carry a checkout,
 * narrowed from the store's own `EntityRef`.
 */
export type OpenDiffSubject = EntityRef & { readonly kind: "workspace" | "worktree" };

/** The row's subject, and the handler that opens the pane over it. */
export interface OpenDiffControlProps {
  readonly subject: OpenDiffSubject;
  /** Open the pane. Supplied by whoever owns the pane layout, never reached for. */
  readonly onOpenDiff: (subject: OpenDiffSubject) => void;
}

/** A button that asks the pane owner to open the changes of one workspace or worktree. */
export function OpenDiffControl(props: OpenDiffControlProps): React.JSX.Element {
  const { subject } = props;
  return (
    <button
      type="button"
      className="meridian-open-diff"
      onClick={() => {
        props.onOpenDiff(subject);
      }}
      // The id is in the name: a mount with three workspaces draws three of these, and
      // "Changes" alone would be three identical names.
      aria-label={`Open the changes of ${subject.kind} ${subject.id}`}
    >
      <Glyph name="diff" size={GLYPH_SIZE_CHROME} />
      Changes
    </button>
  );
}
