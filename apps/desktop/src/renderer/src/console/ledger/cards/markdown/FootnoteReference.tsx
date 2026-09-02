// A footnote marker — the control that opens its definition, or the marker alone.
//
// `Spec-023 §Console Design (Meridian)` §5.14: "Footnotes use one popover host per
// timeline with a definition registry keyed by source, so a definition line never
// resolves as its own body; click pins, chained references navigate in place, focus is
// restored." A marker that could not be pressed made the definition unreachable — the
// registry recorded every body and nothing ever asked it for one.
//
// TWO ELEMENTS, AND WHICH ONE IS RENDERED IS A FACT ABOUT THE MESSAGE. A reference whose
// own message declared a definition is a button: there is a body to open. A reference
// whose definition has not arrived — the streaming case, where the block carrying `[^1]`
// settled before the block carrying `[^1]: …` — is a plain marker. It is deliberately NOT
// a disabled button: a control that cannot be pressed still says a control is there, and
// a reader who reaches it by keyboard has been sent somewhere with nothing to do.
//
// THE PRESS IS THE LIBRARY'S. `Spec-023 §Console Libraries` adopts `@base-ui/react` as
// the one widget family, and its popover carries the whole of what a popover owes:
// keyboard reachability (the trigger is a native button), Escape, outside press, focus
// returned to the marker that opened it, and positioning against that marker. The
// `handle` is what makes one popup serve every marker in the card — the family's own
// mechanism for a detached trigger — so this component holds no open state of its own.

import { Popover } from "@base-ui/react/popover";

import { useFootnoteHost } from "./footnote-popover-context.js";

export interface FootnoteReferenceProps {
  /** The GFM identifier, wire-verbatim — the registry's second key half. */
  readonly identifier: string;
  /** What the marker shows: the author's label where there is one, else the identifier. */
  readonly label: string;
  /** Whether this message declared a definition under that identifier. */
  readonly isDefined: boolean;
}

export function FootnoteReference(props: FootnoteReferenceProps): React.JSX.Element {
  const host = useFootnoteHost();

  if (!props.isDefined || host === undefined) {
    return (
      <sup
        className="meridian-markdown__footnote"
        data-defined={props.isDefined ? "true" : "false"}
        aria-label={`Footnote ${props.label}`}
      >
        {props.label}
      </sup>
    );
  }

  return (
    <Popover.Trigger
      handle={host.handle}
      payload={props.identifier}
      className="meridian-markdown__footnote meridian-markdown__footnote--open"
      data-defined="true"
      aria-label={`Footnote ${props.label}`}
      // `aria-describedby` only while this marker is the one that opened the popup.
      // Base UI reports that per trigger, which is what makes a single host describable:
      // pointing every marker at the popup permanently would tell a screen reader that
      // forty markers are described by one element that is showing one of them.
      render={(triggerProps, state) => (
        <button
          {...triggerProps}
          type="button"
          aria-describedby={state.open ? host.popupId : undefined}
        />
      )}
    >
      {props.label}
    </Popover.Trigger>
  );
}
