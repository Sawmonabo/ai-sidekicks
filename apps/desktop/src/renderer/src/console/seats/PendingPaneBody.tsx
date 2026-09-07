// What a pane renders while its body's module is still arriving.
//
// IT IS THE PANE'S OWN CHROME WITH AN EMPTY BODY, and that is the whole design. The
// chrome is drawn from the pane's address — the kind, the entity it is a view of, the
// session, the focus hue — every one of which the deck knows before the body's module
// lands, so the frame this renders is the frame the loaded body renders around itself.
// Nothing moves when the body arrives: the head is already at its height and the body
// box already at its size, and what changes is only what is inside it.
//
// NO SPINNER, NO SKELETON, NO FLASH. The chunk comes off local disk in an Electron
// window, so the pending window is a frame or two; a spinner appearing and vanishing
// inside it is motion that settles nothing, which is the one thing
// `Spec-023 §Console Design (Meridian)` rule 5 does not admit. A skeleton would be
// worse — it would draw rows the body may not have.
//
// AND IT IS DELIBERATELY NOT ONE OF THE FIVE KINDS OF NOTHING. Rule 8 enumerates five
// absences — not loaded, empty, error, not checked, unknown — and says a renderer that
// collapses two of them into one is wrong. None of them is this: nothing about the
// entity is missing, unknown, or refused, and no read has been attempted yet. What is
// absent is a MODULE, which is a fact about the bundle rather than about the session,
// and rendering `not loaded` here would tell a person their data had not arrived, which
// is a different claim and a false one.
//
// The one thing it adds beyond the chrome is the marker `pending-pane-body.ts` owns, so
// the screenshot tier can refuse to photograph this frame.

import { ConsolePaneChrome } from "./ConsolePaneChrome.js";
import type { ConsolePaneContext } from "./pane-context.js";
import { PENDING_PANE_BODY_ATTRIBUTE } from "./pending-pane-body.js";

export interface PendingPaneBodyProps {
  /** The address and bindings the deck opened this pane at. */
  readonly context: ConsolePaneContext;
}

/**
 * The pane, before its body.
 *
 * The marker rides a `hidden` element inside the body box rather than an attribute on
 * the chrome's own section, and that is a deliberate choice between two shapes: an
 * attribute would mean widening `ConsolePaneChromeProps` with a member about module
 * loading, which is a concern the chrome has nothing to do with, while a `hidden`
 * element is `display: none` and therefore contributes no box, no baseline, and no
 * flex line to a column that is otherwise empty. What the marker costs the layout is
 * nothing, which is the property this whole fallback exists to have.
 *
 * The two host controls are deliberately not passed. They reach the chrome through the
 * deck's own context exactly as they do for a loaded body, so the control strip is
 * identical across the swap rather than growing a button when the body lands.
 */
export function PendingPaneBody(props: PendingPaneBodyProps): React.JSX.Element {
  const { context } = props;
  return (
    <ConsolePaneChrome
      kind={context.kind}
      sessionId={context.sessionStore?.sessionId}
      entity={"entity" in context ? context.entity : undefined}
      focusHue={context.focusHue}
    >
      <span hidden {...{ [PENDING_PANE_BODY_ATTRIBUTE]: context.kind }} />
    </ConsolePaneChrome>
  );
}
