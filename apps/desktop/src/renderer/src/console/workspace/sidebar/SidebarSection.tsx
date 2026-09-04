// One sidebar section: the disclosure a person drives, and the owning family's
// body behind it.
//
// A native `<button>` rather than a div with a role, so Enter and Space activate
// it without this file re-implementing what the platform already does. The
// sidebar's own chord table binds the same two keys for the DOM-free cursor and
// is installed in capture phase, so it consumes the press before the button sees
// it whenever a chord actually fires — one act either way, never two.
//
// THE ATTENTION MARK IS THE SECTION'S CLAIM, NOT THIS FILE'S READING.
// `Spec-023 §The surface set` holds the rail's attention count "never counted in
// the renderer", and this file synthesises no badge either. So the mark renders only
// where the section itself reported amber or red through the seat, and a section
// that has reported nothing shows nothing — not a zero, not a grey dot.
//
// THE CONTEXT IS BUILT WITH STABLE CALLBACKS. A section body will report its
// attention from an effect, and an effect whose dependency is rebuilt every
// render fires every render. `reportAttention` is memoised per section id here so
// a well-written body reports once per change rather than once per pass.

import { useCallback, useId, useMemo } from "react";

import { Glyph, Nothing, type GlyphName } from "../../primitives/index.js";
import { type ConsoleBridge } from "../../bridge/index.js";
import { type SessionStore } from "../../store/index.js";
import {
  type ConsolePaneOpener,
  type SidebarSectionAttention,
  type SidebarSectionContext,
  type SidebarSectionId,
} from "../../seats/index.js";
import { type SidebarModel } from "./sidebar-model.js";

/**
 * What each section is called. Total over the closed set, so an id added to
 * `seats/sidebar-sections.ts` fails to compile here until it is named — which is
 * how `goal` and `approvals` arrived rather than rendering as blank rows.
 *
 * The order is the seat's order and not this table's: the sidebar iterates
 * `SIDEBAR_SECTION_IDS`, and a record is unordered.
 */
const LABEL_BY_SECTION_ID: Readonly<Record<SidebarSectionId, string>> = {
  goal: "Goal",
  channels: "Channels",
  runs: "Runs",
  agents: "Agents",
  repos: "Repos and worktrees",
  approvals: "Approvals",
  artifacts: "Artifacts",
  members: "Members",
};

/** The glyph each section wears. Total for `LABEL_BY_SECTION_ID`'s reason. */
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
 * Total over the vocabulary, and `calm` maps to `undefined` rather than to a word
 * because the calm rendering is no mark at all — a phrase for it would be a badge
 * saying nothing is wrong, which is chrome rather than information.
 */
const ATTENTION_LABEL: Readonly<Record<SidebarSectionAttention, string | undefined>> = {
  red: "needs attention",
  amber: "worth a look",
  calm: undefined,
};

const SECTION_GLYPH_SIZE = 14;
const DISCLOSURE_GLYPH_SIZE = 12;

export interface SidebarSectionProps {
  readonly id: SidebarSectionId;
  readonly model: SidebarModel;
  /**
   * The owning family's body, or `undefined` while nobody has filled this seat.
   *
   * The renderer rather than the whole descriptor: a descriptor's `owner` is the
   * registry's conflict vocabulary, and handing it to a component that renders
   * none of it would invite one that did.
   */
  readonly render: ((context: SidebarSectionContext) => React.ReactNode) | undefined;
  readonly isOpen: boolean;
  readonly isCursored: boolean;
  readonly attention: SidebarSectionAttention;
  readonly filterQuery: string;
  readonly sessionStore: SessionStore;
  readonly bridge: ConsoleBridge;
  readonly openPane: ConsolePaneOpener;
  /** Handed the disclosure element so the cursor can move focus onto it. */
  readonly registerDisclosure: (id: SidebarSectionId, element: HTMLButtonElement | null) => void;
}

export function SidebarSection(props: SidebarSectionProps): React.JSX.Element {
  const headerId = useId();
  const bodyId = useId();
  const label = LABEL_BY_SECTION_ID[props.id];
  const attentionLabel = ATTENTION_LABEL[props.attention];

  const { model, id } = props;
  const reportAttention = useCallback(
    (attention: SidebarSectionAttention) => {
      model.reportAttention(id, attention);
    },
    [model, id],
  );

  const context: SidebarSectionContext = useMemo(
    () => ({
      sessionStore: props.sessionStore,
      bridge: props.bridge,
      openPane: props.openPane,
      isOpen: props.isOpen,
      filterQuery: props.filterQuery,
      reportAttention,
    }),
    [
      props.sessionStore,
      props.bridge,
      props.openPane,
      props.isOpen,
      props.filterQuery,
      reportAttention,
    ],
  );

  return (
    <li className="meridian-sidebar__section" data-cursored={props.isCursored ? "true" : undefined}>
      <h2 className="meridian-sidebar__heading">
        <button
          type="button"
          id={headerId}
          ref={(element) => {
            props.registerDisclosure(props.id, element);
          }}
          className="meridian-sidebar__disclosure"
          aria-expanded={props.isOpen}
          aria-controls={bodyId}
          // `aria-current` rather than a second selected state: the cursor is
          // where the keyboard is, and "current" is what that means to a screen
          // reader. Focus follows it, so the two never disagree.
          aria-current={props.isCursored ? "true" : undefined}
          onClick={() => {
            props.model.setCursor(props.id);
            props.model.toggleSection(props.id);
          }}
        >
          <Glyph
            name={props.isOpen ? "chevron-down" : "chevron-right"}
            size={DISCLOSURE_GLYPH_SIZE}
          />
          <Glyph name={GLYPH_BY_SECTION_ID[props.id]} size={SECTION_GLYPH_SIZE} />
          <span className="meridian-sidebar__label">{label}</span>
          {attentionLabel === undefined ? null : (
            <span
              className={`meridian-sidebar__attention meridian-sidebar__attention--${props.attention}`}
            >
              <span className="meridian-visually-hidden">{attentionLabel}</span>
            </span>
          )}
        </button>
      </h2>
      <div
        className="meridian-sidebar__body"
        id={bodyId}
        role="region"
        aria-labelledby={headerId}
        hidden={!props.isOpen}
      >
        {props.render === undefined ? (
          <Nothing
            kind="not-checked"
            title={`The ${label.toLowerCase()} section has not been built yet.`}
            detail="It is reserved here rather than stubbed, so nothing on screen stands in for a read the console has not made."
          />
        ) : (
          props.render(context)
        )}
      </div>
    </li>
  );
}
