// One sidebar section: the disclosure a person drives, and the owning family's body
// behind it.
//
// A native `<button>` rather than a div with a role, so Enter and Space activate it
// without this file re-implementing what the platform already does. The sidebar's own
// chord table binds the same two keys for the DOM-free cursor and is installed in
// capture phase, so it consumes the press before the button sees it whenever a chord
// actually fires — one act either way, never two.
//
// A COLLAPSED SECTION IS NOT MOUNTED AT ALL, and this is the file that decides it. A
// section body is what starts that section's read, so mounting eight of them to show
// two would run eight reads and hold eight subscriptions for a column showing two.
// That is the same sentence as the design rule about independently loaded sections and
// as the frame-time budget, which is why there is no hidden-but-mounted arm below.
//
// THE ATTENTION MARK IS THE SECTION'S CLAIM, NOT THIS FILE'S READING. The rail's
// attention count is "taken from the daemon's attention projection, never counted in
// the renderer", and this file synthesises no badge either: the mark renders only where
// the section's own descriptor answered, and a section that answered nothing shows
// nothing — not a zero, not a grey dot.

import { useId } from "react";

import { type ConsoleBridge } from "../../bridge/index.js";
import { Glyph, Nothing, type GlyphName } from "../../primitives/index.js";
import { type SessionStore } from "../../store/index.js";
import { GLYPH_SIZE_CHROME, GLYPH_SIZE_ROW } from "../../tokens/index.js";
import {
  type ConsolePaneOpener,
  type SidebarSectionContext,
  type SidebarSectionId,
} from "../../seats/index.js";
import { SECTION_HEADER_ATTRIBUTE, SIDEBAR_SECTION_LABELS } from "./model/sidebar-labels.js";
import { type SidebarSectionAttention } from "./model/sidebar-model.js";

/**
 * The glyph each section wears.
 *
 * Total over the closed set for the labels table's reason: a section added to the seat
 * fails to compile here rather than rendering a header with a hole where its mark is.
 */
const GLYPH_BY_SECTION_ID: Readonly<Record<SidebarSectionId, GlyphName>> = {
  goal: "goal",
  channels: "channel",
  runs: "run",
  agents: "agent",
  repos: "repo",
  approvals: "approval",
  artifacts: "artifact",
  members: "member",
};

/**
 * What the attention mark says out loud, per level.
 *
 * Total over the vocabulary the seat declares. The two values are the two hues rule 3
 * spends on urgency, and the phrases name the SITUATION rather than the colour — a
 * screen reader announcing "amber" would be reading the palette out.
 */
const ATTENTION_PHRASE: Readonly<Record<SidebarSectionAttention, string>> = {
  attention: "needs attention",
  failure: "something failed",
};

/**
 * The section's own mark is the chrome scale, named rather than restated.
 *
 * The disclosure's chevron is smaller and the token home publishes the row scale for
 * it, so both sizes below are named tokens and neither is a literal.
 */
const SECTION_GLYPH_SIZE = GLYPH_SIZE_CHROME;

export interface SidebarSectionProps {
  readonly sectionId: SidebarSectionId;
  /**
   * The owning family's body, or `undefined` while nobody has filled this seat.
   *
   * The renderer rather than the whole descriptor: a descriptor's `owner` is the
   * registry's conflict vocabulary, and handing it to a component that renders none of
   * it would invite one that did.
   */
  readonly render: ((context: SidebarSectionContext) => React.ReactNode) | undefined;
  readonly isOpen: boolean;
  readonly isCursored: boolean;
  readonly attention: SidebarSectionAttention | undefined;
  readonly filterQuery: string;
  readonly sessionStore: SessionStore;
  readonly bridge: ConsoleBridge;
  readonly openPane: ConsolePaneOpener;
  /** Press the header: put the cursor here, and open or shut this section. */
  readonly onPress: (sectionId: SidebarSectionId) => void;
  /** Handed the disclosure element so the cursor can move focus onto it. */
  readonly registerDisclosure: (
    sectionId: SidebarSectionId,
    element: HTMLButtonElement | null,
  ) => void;
}

export function SidebarSection(props: SidebarSectionProps): React.JSX.Element {
  const headerId = useId();
  const bodyId = useId();
  const label = SIDEBAR_SECTION_LABELS[props.sectionId];

  return (
    <li className="meridian-sidebar__section" data-cursored={props.isCursored ? "true" : undefined}>
      <h2 className="meridian-sidebar__heading">
        <button
          type="button"
          id={headerId}
          ref={(element) => {
            props.registerDisclosure(props.sectionId, element);
          }}
          className="meridian-sidebar__disclosure"
          aria-expanded={props.isOpen}
          aria-controls={bodyId}
          // `aria-current` rather than a second selected state: the cursor is where the
          // keyboard is, and "current" is what that means to a screen reader. Focus
          // follows it, so the two never disagree.
          aria-current={props.isCursored ? "true" : undefined}
          {...{ [SECTION_HEADER_ATTRIBUTE]: props.sectionId }}
          {...(props.attention === undefined ? {} : { "data-attention": props.attention })}
          onClick={() => {
            props.onPress(props.sectionId);
          }}
        >
          <Glyph name={props.isOpen ? "chevron-down" : "chevron-right"} size={GLYPH_SIZE_ROW} />
          <Glyph name={GLYPH_BY_SECTION_ID[props.sectionId]} size={SECTION_GLYPH_SIZE} />
          <span className="meridian-sidebar__label">{label}</span>
          {props.attention === undefined ? null : (
            // The mark itself is the header's leading edge, drawn by the stylesheet off
            // `data-attention` — ONE visual owner for the datum. What lives here is the
            // half a tint cannot carry: the words a screen reader reads.
            <span className="meridian-visually-hidden">{ATTENTION_PHRASE[props.attention]}</span>
          )}
        </button>
      </h2>
      {!props.isOpen ? null : (
        <div
          className="meridian-sidebar__body"
          id={bodyId}
          role="region"
          aria-labelledby={headerId}
        >
          {props.render === undefined ? (
            <Nothing
              kind="not-checked"
              placement="surface"
              title={`The ${label.toLocaleLowerCase()} section has not been built yet.`}
              detail="It is reserved here rather than stubbed, so nothing on screen stands in for a read the console has not made."
            />
          ) : (
            props.render({
              sessionStore: props.sessionStore,
              bridge: props.bridge,
              openPane: props.openPane,
              isOpen: true,
              filterQuery: props.filterQuery,
            })
          )}
        </div>
      )}
    </li>
  );
}
