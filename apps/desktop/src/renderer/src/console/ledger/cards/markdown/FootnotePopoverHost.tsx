// The footnote popover host — one per rendered body, and where a definition is read.
//
// `Spec-023 §Console Design (Meridian)` §5.14 puts "one popover host per timeline with a
// definition registry keyed by source". The registry this shell hands each card is the
// card's own, so a host per rendered body IS a host per registry: a marker can only ever
// reach a definition its own message declared, which is the property the composite key
// exists to give, and a second host would have nothing extra to show.
//
// THE DEFINITION IS MAPPED HERE AND NOWHERE ELSE. `MarkdownNodes` renders a
// `footnoteDefinition` as nothing, so a body's text never reaches the screen twice; this
// is the one place it is rendered, out of the nodes the registry recorded rather than out
// of a second parse.
//
// AND A DEFINITION NOTHING REFERS TO IS NAMED. Stripping it from the body and saying
// nothing would delete an author's words with no record: a reader would have no way to
// know the message carried a note at all. It is only asked once the body is COMPLETE —
// while a message streams, a definition ahead of its reference is the ordinary case and
// calling it uncited would be wrong as well as expensive.

import type { RootContent } from "mdast";
import { useId, useMemo, useState } from "react";
import { Popover } from "@base-ui/react/popover";

import { Nothing } from "../../../primitives/index.js";
import type { FootnoteRegistry } from "./footnote-registry.js";
import { FootnoteHostProvider, type FootnoteHostBinding } from "./footnote-popover-context.js";
import { MarkdownNodes, type MarkdownRenderContext } from "./MarkdownNodes.js";

/** How far the popup sits off the marker it belongs to. */
const FOOTNOTE_POPUP_SIDE_OFFSET = 6;

/**
 * The context a definition body is mapped under.
 *
 * Settled, because a definition the registry holds was parsed from a block that had
 * already settled; and with no defined identifiers, because a footnote inside a footnote
 * is not a construct GFM nests — a marker in there is a reference to something this body
 * did not declare, and renders inert, which is exactly right.
 */
const DEFINITION_RENDER_CONTEXT: MarkdownRenderContext = {
  isSettled: true,
  definedFootnoteIdentifiers: new Set<string>(),
};

export interface FootnotePopoverHostProps {
  /** The row this body belongs to — the registry's first key half. */
  readonly sourceId: string;
  /** Where this message's definitions were recorded. */
  readonly footnotes: FootnoteRegistry;
  /** Identifiers this body defined that nothing in it refers to. Empty while streaming. */
  readonly uncitedIdentifiers: readonly string[];
  /** The body itself. Every marker inside it opens into this host. */
  readonly children: React.ReactNode;
}

export function FootnotePopoverHost(props: FootnotePopoverHostProps): React.JSX.Element {
  const popupId = useId();
  // Constructed once and kept, per `apps/desktop/AGENTS.md`: a handle rebuilt on a render
  // would detach every marker in the card from the popup they were opening into.
  const [handle] = useState(() => Popover.createHandle<string>());
  const binding = useMemo<FootnoteHostBinding>(
    () => ({ sourceId: props.sourceId, popupId, handle }),
    [props.sourceId, popupId, handle],
  );

  return (
    <FootnoteHostProvider value={binding}>
      {props.children}
      <UncitedDefinitions identifiers={props.uncitedIdentifiers} />
      <Popover.Root handle={handle}>
        {({ payload: identifier }: { readonly payload: string | undefined }) => (
          <Popover.Portal>
            <Popover.Positioner sideOffset={FOOTNOTE_POPUP_SIDE_OFFSET}>
              <Popover.Popup id={popupId} className="meridian-footnote-popover">
                <DefinitionBody
                  bodyNodes={
                    identifier === undefined
                      ? undefined
                      : props.footnotes.resolve(props.sourceId, identifier)?.bodyNodes
                  }
                />
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        )}
      </Popover.Root>
    </FootnoteHostProvider>
  );
}

/**
 * One definition's body, or the reason there is none to show.
 *
 * The registry answers `undefined` for a reference whose definition has not arrived, and
 * a marker is only a button once the message has declared one — so reaching this arm
 * means the definition left the registry between the press and the render, which is what
 * the bound eviction can do to the oldest entries. Saying so beats an empty popup.
 */
function DefinitionBody(props: {
  readonly bodyNodes: readonly RootContent[] | undefined;
}): React.JSX.Element {
  if (props.bodyNodes === undefined) {
    return (
      <Nothing
        kind="empty"
        placement="inline"
        title="This footnote's definition is no longer held."
      />
    );
  }
  return <MarkdownNodes nodes={props.bodyNodes} context={DEFINITION_RENDER_CONTEXT} />;
}

/**
 * The definitions this body declared and never referred to.
 *
 * `not-checked` would be wrong and `error` would be an accusation: the message defined a
 * note, the console read it, and nothing in the message points at it. That is an EMPTY
 * result for a question that was asked — rule 8's `empty` — and the identifiers are the
 * author's own strings, so they are listed rather than counted.
 */
function UncitedDefinitions(props: {
  readonly identifiers: readonly string[];
}): React.JSX.Element | null {
  if (props.identifiers.length === 0) {
    return null;
  }
  return (
    <Nothing
      kind="empty"
      placement="inline"
      title={`Defined and never referred to: ${props.identifiers.join(", ")}.`}
      detail="The note is in the message; nothing in it points here."
    />
  );
}
