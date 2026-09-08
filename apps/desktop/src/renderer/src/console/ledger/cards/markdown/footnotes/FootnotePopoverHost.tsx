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
// THE ANCHORED PART OF THE POPOVER IS THE PRIMITIVE'S. `Popover.Root` and the render
// prop stay here because which definition is open is this host's state, but the
// portal, the positioner, and the popup are `primitives/overlay/OverlayPopoverPopup.tsx`'s
// — that is what puts the popup in the window's airspace (`Spec-023 §Console Design
// (Meridian)` 12.3), and a card that mounted its own portal would be a note a native
// browser-pane view paints over. The popup's id still travels from here: the marker
// names it through `aria-controls`, so one id is minted once and spent in two places.
//
// AND A DEFINITION NOTHING REFERS TO IS NAMED. Stripping it from the body and saying
// nothing would delete an author's words with no record: a reader would have no way to
// know the message carried a note at all. It is only asked once the body is COMPLETE —
// while a message streams, a definition ahead of its reference is the ordinary case and
// calling it uncited would be wrong as well as expensive.

import { useCallback, useId, useMemo, useState, useSyncExternalStore } from "react";
import { Popover } from "@base-ui/react/popover";

import { OverlayPopoverPopup } from "../../../../primitives/index.js";

import { DefinitionBody } from "./DefinitionBody.js";
import type { FootnoteDefinition, FootnoteRegistry } from "./footnote-registry.js";
import { FootnoteHostProvider, type FootnoteHostBinding } from "./footnote-popover-context.js";
import { type MarkdownRenderContext } from "../nodes/MarkdownNodes.js";
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
  const definitions = useSourceFootnoteDefinitions(props.footnotes, props.sourceId);
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
          <OverlayPopoverPopup
            sideOffset={FOOTNOTE_POPUP_SIDE_OFFSET}
            popupId={popupId}
            className="meridian-footnote-popover"
          >
            <DefinitionBody
              bodyNodes={
                identifier === undefined ? undefined : definitions.get(identifier)?.bodyNodes
              }
              context={definitionContext}
            />
          </OverlayPopoverPopup>
        )}
      </Popover.Root>
    </FootnoteHostProvider>
  );
}

/**
 * This body's definitions, as the registry holds them RIGHT NOW.
 *
 * Through `useSyncExternalStore` and not a plain read, which is the whole of what the
 * registry grew a subscription for. Definitions are recorded from an effect —
 * `StreamingMarkdown`'s registration hook — so the write always lands after the render
 * that read them. While a body streams the next frame hides that; on the LAST frame
 * there is no next frame and nothing schedules another render, so a popover already
 * open over a note that update rewrote stayed on the penultimate body indefinitely.
 *
 * A hook rather than three calls in the component body, per `apps/desktop/AGENTS.md`:
 * a subscription is not a render. Both closures are memoised because React re-subscribes
 * when `subscribe` changes identity and re-reads when `getSnapshot` does, and a fresh
 * pair per render would tear the subscription down and build it again on every frame of
 * the stream this hook exists to follow.
 */
function useSourceFootnoteDefinitions(
  footnotes: FootnoteRegistry,
  sourceId: string,
): ReadonlyMap<string, FootnoteDefinition> {
  const subscribe = useCallback(
    (onStoreChange: () => void) => footnotes.subscribeToSource(sourceId, onStoreChange),
    [footnotes, sourceId],
  );
  const readDefinitions = useCallback(
    () => footnotes.definitionsFor(sourceId),
    [footnotes, sourceId],
  );
  return useSyncExternalStore(subscribe, readDefinitions);
}
