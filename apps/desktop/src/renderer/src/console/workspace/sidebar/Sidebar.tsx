// The session sidebar's frame: the sections host, and the collapse rule.
//
// `Spec-023 §Console Design (Meridian)` §4.4 — "Show what else in the session needs
// a look, as independently loaded sections that open panes." The sections are four
// families' bodies and the frame is one; this file is the frame, and it renders
// whatever `sidebarSectionRenderer` answers with.
//
// THE FRAME READS NOTHING. §4.4's own sentence — "the sidebar reads nothing itself
// beyond `session.read` and `session.subscribe` for the spine" — is why there is no
// bridge call in this file. Counts, rollup status, and the filter field are each a
// property of a SECTION's read, so a frame that computed one would be synthesising
// a badge the daemon has not served, which the same section forbids in as many
// words.
//
// COLLAPSE IS AN INVERTED SET
//
// The persisted shape is the ids the person has COLLAPSED, never the ids they have
// opened. §4.4: "so a new section defaults open when it carries attention" — a set
// of opened ids would leave a section minted after the last save silently shut, and
// the one that would be shut is the new one nobody has seen. It starts holding
// every id because no section carries attention yet; the moment a section's read
// can answer amber or red, the initial set is that answer's complement and nothing
// else in this file changes.
//
// The set lives in React state rather than in a store: it is this component's own
// view state, no other surface reads it, and the durable half is the persistence
// chokepoint's — a `UiStateStore` write, which lands with the section that first
// has something worth restoring.

import { useCallback, useId, useState } from "react";

import { Glyph, Nothing, type GlyphName } from "../../primitives/index.js";
import { type ConsoleBridge } from "../../bridge/index.js";
import { type SessionStore } from "../../store/index.js";
import {
  SIDEBAR_SECTION_IDS,
  sidebarSectionRenderer,
  type ConsolePaneOpener,
  type SidebarSectionContext,
  type SidebarSectionId,
} from "../seats/index.js";

import "./sidebar.css";

/** What each section is called. Total over the closed set, so a seventh id fails here. */
const LABEL_BY_SECTION_ID: Readonly<Record<SidebarSectionId, string>> = {
  channels: "Channels",
  agents: "Agents",
  runs: "Runs",
  repos: "Repos and worktrees",
  artifacts: "Artifacts",
  members: "Members",
};

/** The glyph each section wears. Total for `LABEL_BY_SECTION_ID`'s reason. */
const GLYPH_BY_SECTION_ID: Readonly<Record<SidebarSectionId, GlyphName>> = {
  channels: "channel",
  agents: "agent",
  runs: "run",
  repos: "repo",
  artifacts: "artifact",
  members: "member",
};

export interface SidebarProps {
  readonly sessionStore: SessionStore;
  readonly bridge: ConsoleBridge;
  /**
   * How a section opens a pane. Handed down rather than imported, so a sidebar
   * rendered in an auxiliary window opens panes in THAT window's deck.
   */
  readonly openPane: ConsolePaneOpener;
}

export function Sidebar(props: SidebarProps): React.JSX.Element {
  const [collapsedSectionIds, setCollapsedSectionIds] = useState<ReadonlySet<SidebarSectionId>>(
    () => new Set(SIDEBAR_SECTION_IDS),
  );

  const toggleSection = useCallback((id: SidebarSectionId) => {
    setCollapsedSectionIds((collapsed) => {
      const next = new Set(collapsed);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
  }, []);

  return (
    <nav className="meridian-sidebar" aria-label="Session sidebar">
      <ul className="meridian-sidebar__sections">
        {SIDEBAR_SECTION_IDS.map((id) => (
          <SidebarSection
            key={id}
            id={id}
            isOpen={!collapsedSectionIds.has(id)}
            onToggle={toggleSection}
            sessionStore={props.sessionStore}
            bridge={props.bridge}
            openPane={props.openPane}
          />
        ))}
      </ul>
    </nav>
  );
}

interface SidebarSectionProps extends SidebarProps {
  readonly id: SidebarSectionId;
  readonly isOpen: boolean;
  readonly onToggle: (id: SidebarSectionId) => void;
}

/**
 * One section: a disclosure header and the owning family's body behind it.
 *
 * A native `<button>` rather than a div with a role, so Enter and Space activate it
 * without this file re-implementing what the platform already does — the DOM-free
 * `j` / `k` cursor §4.4 asks for is a movement layer ABOVE this and lands with the
 * section reads it moves between.
 */
function SidebarSection(props: SidebarSectionProps): React.JSX.Element {
  const headerId = useId();
  const bodyId = useId();
  const render = sidebarSectionRenderer(props.id);
  const label = LABEL_BY_SECTION_ID[props.id];

  const context: SidebarSectionContext = {
    sessionStore: props.sessionStore,
    bridge: props.bridge,
    openPane: props.openPane,
    isOpen: props.isOpen,
  };

  return (
    <li className="meridian-sidebar__section">
      <h2 className="meridian-sidebar__heading">
        <button
          type="button"
          id={headerId}
          className="meridian-sidebar__disclosure"
          aria-expanded={props.isOpen}
          aria-controls={bodyId}
          onClick={() => {
            props.onToggle(props.id);
          }}
        >
          <Glyph name={props.isOpen ? "chevron-down" : "chevron-right"} size={12} />
          <Glyph name={GLYPH_BY_SECTION_ID[props.id]} size={14} />
          <span className="meridian-sidebar__label">{label}</span>
        </button>
      </h2>
      <div
        className="meridian-sidebar__body"
        id={bodyId}
        role="region"
        aria-labelledby={headerId}
        hidden={!props.isOpen}
      >
        {render === undefined ? (
          <Nothing
            kind="not-checked"
            title={`The ${label.toLowerCase()} section has not been built yet.`}
            detail="It is reserved here rather than stubbed, so nothing on screen stands in for a read the console has not made."
          />
        ) : (
          render(context)
        )}
      </div>
    </li>
  );
}
