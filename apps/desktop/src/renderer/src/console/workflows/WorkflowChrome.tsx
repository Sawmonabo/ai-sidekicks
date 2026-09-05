// The frame the three workflows surfaces share: a header, one primary action, and
// whichever of the two grammars the current state calls for.
//
// The three surfaces differ in what they hold and agree completely on what they
// hold it in — `Spec-023 §Console Design (Meridian)` rule 7 gives every one of them
// the same quiet chrome, and rules 8 and 9 give all three the same two vocabularies
// for having nothing to show. Written per surface, that agreement would be three
// headers that drift in padding and three absence blocks that drift in copy shape,
// and only the screenshot tier would ever notice.
//
// THE TWO GRAMMARS ARE KEPT APART, DELIBERATELY. An absence is the console's own
// prose about a read (rule 8); a refusal is the daemon's answer, rendered with its
// code in mono and its message verbatim (rule 9). Collapsing the refusal arm into
// the `error` absence would drop the code — the string a person pastes into a search
// — and would have this family paraphrasing a daemon it is required to quote.
//
// THE BANNER IS THE SHAPE, AND THAT IS A CHOICE ABOUT BLAST RADIUS RATHER THAN THE
// ONLY EXPORT AVAILABLE. Every refusal these three surfaces can reach changes what
// the whole surface can do next — a definitions read that was denied leaves no rows
// to attach an inline refusal to, and a control denial on a run changes what the
// room can do with that run. The inline shape belongs on a control that was pressed
// and stays; when this family grows those controls, they render their own.

import { useId } from "react";

import { Glyph, Nothing, RefusalBanner, type GlyphName } from "../primitives/index.js";
import { WORKFLOW_CHROME_GLYPH_SIZE, type WorkflowChromeState } from "./chrome-state.js";

export interface WorkflowChromeProps {
  /** The kind glyph, so a surface is identifiable before its copy is read. */
  readonly glyph: GlyphName;
  /** The surface's name. Sentence case, a noun phrase, never a sentence. */
  readonly heading: string;
  /** One line under the heading saying what this surface is for. */
  readonly summary: string;
  readonly state: WorkflowChromeState;
  /**
   * The one primary action this surface offers, when it offers one.
   *
   * Singular by contract rather than by convention: rule 7 puts secondary controls
   * one click away, and a slot that took a list would be the place a second visible
   * button arrives without anyone deciding to add one.
   */
  readonly primaryAction?: React.ReactNode;
  /** The surface's body. Rendered on `ready` and on no other arm. */
  readonly children?: React.ReactNode;
}

/**
 * Render a workflows surface's chrome and whatever its state calls for.
 *
 * The heading owns the accessible name of the region rather than an `aria-label`
 * repeating it, so the two cannot disagree — a label that drifts from the visible
 * heading is a surface that announces itself as something a sighted reader cannot
 * find.
 *
 * THE NAME IS THE HEADING'S TEXT AND THE ID IS THE INSTANCE'S. Derived from the text,
 * the id was a fact about the copy rather than about this chrome: a deck holding two
 * `workflow-run` panes rendered the same id twice, which is invalid markup, and both
 * `aria-labelledby` references then resolved to whichever heading came first — so the
 * second pane was announced with the first pane's name. `useId` is minted per
 * component instance, which is exactly the scope the reference needs, and it is what
 * `LedgerRow` and `OperatorControls` already use for the same job. The pane identity
 * would have worked too and is deliberately not reached for: the chrome is handed
 * none, and taking one would give this component a second input for a problem the
 * hook solves with no input at all.
 */
export function WorkflowChrome(props: WorkflowChromeProps): React.JSX.Element {
  const headingId = useId();
  return (
    <section className="meridian-workflow" aria-labelledby={headingId}>
      <header className="meridian-workflow__header">
        <Glyph name={props.glyph} size={WORKFLOW_CHROME_GLYPH_SIZE} />
        <div className="meridian-workflow__heading-group">
          <h2 className="meridian-workflow__heading" id={headingId}>
            {props.heading}
          </h2>
          <p className="meridian-workflow__summary">{props.summary}</p>
        </div>
        {props.primaryAction === undefined ? null : (
          <div className="meridian-workflow__primary-action">{props.primaryAction}</div>
        )}
      </header>
      <div className="meridian-workflow__body">{renderState(props)}</div>
    </section>
  );
}

/**
 * The state's own rendering, total over the union.
 *
 * A function beside the component rather than a branch inside its body: the switch
 * is exhaustive over `WorkflowChromeState`, and keeping it here is what makes a
 * sixth arm a compile error at one site instead of a silently unrendered state at
 * three.
 */
function renderState(props: WorkflowChromeProps): React.ReactNode {
  const { state } = props;
  switch (state.kind) {
    case "not-checked":
      return (
        <Nothing kind="not-checked" placement="surface" title={state.title} detail={state.detail} />
      );
    case "not-loaded":
      return <Nothing kind="not-loaded" placement="surface" title={state.title} />;
    case "empty":
      return (
        <Nothing
          kind="empty"
          placement="surface"
          title={state.title}
          detail={state.detail}
          action={props.primaryAction}
        />
      );
    case "refused":
      return <RefusalBanner code={state.refusal.code} detail={state.refusal.detail} />;
    case "ready":
      return props.children;
  }
}
