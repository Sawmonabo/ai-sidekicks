// The diff pane's chrome: the frame a diff is read inside, and the honest absence
// that stands where the diff itself will be.
//
// `Spec-023 §Console Design (Meridian)` §10.6 gives the pane its job — "show what
// changed between two named states, and who is accountable for each line" — and
// that job needs three things this file deliberately does NOT build: the compared
// states, the attribution badge, and the rows. All three are DATA, and the wire
// that produces them (`gitflow.diffArtifactCreate`) is on `Plan-023 §Console growth
// slate` rather than in the corpus. The renderer that consumes them ships with the
// diff rows, in this family, beside this file.
//
// WHAT CHROME MEANS HERE. The pane's frame is not a placeholder for the pane: it is
// the part that does not change when the rows arrive. The header names what the
// pane is and which entity it is a view of, the body is one region at one measure,
// and the rows mount into that region without moving it. A shell that also drew a
// fake toolbar would have to be deleted rather than filled, which is the difference
// between a seam and a stub.
//
// WHY THE ABSENCE IS `not-checked` AND NOT `empty`. `empty` asserts that the read
// came back with nothing. Nothing has been read: no diff has been asked for, and no
// wire exists to ask on. Rendering `empty` here would have the console state, in its
// own voice, that a workspace has no changes — a fact it never established.
//
// WHY THE FOCUS HUE IS NOT READ. `ConsolePaneContext.focusHue` colours the ring
// drawn AROUND a focused pane, and the deck draws it: the deck knows which of its
// panes has focus and this body does not. A body that painted its own ring would be
// a second answer to a question the deck already owns.

import { useId } from "react";

import { Glyph, Nothing } from "../../primitives/index.js";
import { type ConsolePaneContext } from "../../workspace/index.js";

export interface DiffPaneProps {
  readonly context: ConsolePaneContext;
}

export function DiffPane(props: DiffPaneProps): React.JSX.Element {
  const { context } = props;
  const headingId = useId();
  return (
    <section
      className="meridian-repos-pane meridian-repos-pane--diff"
      aria-labelledby={headingId}
      data-pane-id={context.paneId}
    >
      <header className="meridian-repos-pane__header">
        <h2 className="meridian-repos-pane__heading" id={headingId}>
          <Glyph name="diff" />
          Diff
        </h2>
        {context.entity === undefined ? null : (
          // Wire-verbatim and never shortened: two workspaces whose ids differ in
          // their tail read identically once a renderer abbreviates them, and this
          // is the only place the pane says which one it is a view of. The full
          // string stays recoverable through the title even where the measure
          // truncates the display copy.
          <span
            className="meridian-repos-pane__subject"
            title={context.entity.id}
            aria-label={`Subject: ${context.entity.kind} ${context.entity.id}`}
          >
            {context.entity.id}
          </span>
        )}
      </header>
      <div className="meridian-repos-pane__body">
        <Nothing
          kind="not-checked"
          placement="surface"
          title="No diff has been asked for."
          detail="A diff names two states and the run or workspace it is attributed to. None has been requested for this pane, so the console is not reporting that nothing changed."
        />
      </div>
    </section>
  );
}
