// The footnote popover host — one per rendered body, and where a definition is read.
//
// This console keeps one popover host per timeline over the source-keyed registry
// `footnote-registry.ts` owns. The registry this shell hands each card is the
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

import { useId, useMemo, useState } from "react";
import { Popover } from "@base-ui/react/popover";

import { DefinitionBody } from "./DefinitionBody.js";
import type { FootnoteRegistry } from "./footnote-registry.js";
import { FootnoteHostProvider, type FootnoteHostBinding } from "./footnote-popover-context.js";
import { type MarkdownRenderContext } from "./MarkdownNodes.js";
import { UncitedDefinitions } from "./UncitedDefinitions.js";

/** How far the popup sits off the marker it belongs to. */
const FOOTNOTE_POPUP_SIDE_OFFSET = 6;

export interface FootnotePopoverHostProps {
  /** The row this body belongs to — the registry's first key half. */
  readonly sourceId: string;
  /** Where this message's definitions were recorded. */
  readonly footnotes: FootnoteRegistry;
  /** Identifiers this body defined that nothing in it refers to. Empty while streaming. */
  readonly uncitedIdentifiers: readonly string[];
  /**
   * Which footnote identifiers this message defined — the same set the body renders
   * under, so a marker means the same thing inside a definition as outside one.
   */
  readonly definedFootnoteIdentifiers: ReadonlySet<string>;
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

  // THE CONTEXT A DEFINITION BODY IS MAPPED UNDER, and it carries the source's real
  // defined set. A footnote body CAN hold a reference to another note — GFM parses one,
  // and `footnote-collection.test.ts` asserts a pair of notes citing each other are both
  // collected — so mapping the body under an empty set rendered every such marker as an
  // inert `<sup>`, and the chained-reference navigation the registry and the marker both
  // exist for could not happen even though the host is mounted right here around it.
  //
  // Settled, because a definition the registry holds was parsed from a block that had
  // already settled.
  const definitionContext = useMemo<MarkdownRenderContext>(
    () => ({ isSettled: true, definedFootnoteIdentifiers: props.definedFootnoteIdentifiers }),
    [props.definedFootnoteIdentifiers],
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
                  context={definitionContext}
                />
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        )}
      </Popover.Root>
    </FootnoteHostProvider>
  );
}
