// The session sidebar: the session's other work, one section at a time.
//
// `Spec-023 §Console Design (Meridian)` §Layout grammar — "The workspace is a cast bar
// on top, the deck of panes below it, and a collapsible session sidebar" — and §The
// surface set for what it holds. This component is the column; `sidebar-model.ts` holds
// the rules it renders and `sidebar-state.ts` holds what it keeps.
//
// IT RENDERS SECTIONS IT DOES NOT OWN, WHICH IS WHY THE SEAT EXISTS. The bodies belong
// to three other families, so what walks below is the seat's DECLARED tuple — the
// order a person reads down the column — and never a list assembled from whoever
// happened to register. Two consequences follow, and both are deliberate:
//
//   • **Every declared section shows its header**, filled or not. On a branch where no
//     family has registered, a sidebar that hid its unfilled sections would render as
//     an empty column and read as "this session has no work", which is a claim the
//     console has not established.
//   • **An unfilled section's body is `not-checked`**, rule 8's fourth absence: nobody
//     asked. It is not `empty`, which would say a read came back with none, and it
//     names no owner, because an unfilled section has none to name.
//
// AND A COLLAPSED SECTION IS NOT MOUNTED AT ALL. A section body is what starts that
// section's read, so mounting eight of them to show one would run eight reads and hold
// eight subscriptions for a column showing one. That is the same sentence as the
// design rule and as the frame-time budget, which is why there is no hidden-but-mounted
// arm anywhere below.

import { useCallback, useEffect, useMemo, useRef } from "react";

import { type ConsoleRefusal } from "../../core/index.js";
import { InlineRefusal, Nothing, useAnnounce } from "../../primitives/index.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { useSessionProjectionRevision, type SessionStore } from "../../store/index.js";
import {
  SIDEBAR_SECTION_IDS,
  sidebarSectionRegistry,
  type ConsolePaneOpener,
  type SidebarSectionId,
  type SidebarSectionRegistry,
} from "../../seats/index.js";
import {
  SIDEBAR_SECTION_LABELS,
  resolveOpenSectionId,
  type SidebarAttentionBySectionId,
  type SidebarSectionAttention,
} from "./sidebar-model.js";
import {
  useMountedSidebar,
  type MountedSidebarSeat,
  type SidebarActs,
} from "./sidebar-commands.js";
import type { SidebarLayout, SidebarLayoutSnapshot } from "./sidebar-state.js";

export interface SessionSidebarProps {
  readonly sessionStore: SessionStore;
  readonly bridge: ConsoleBridge;
  /** How a section's cards open panes — the deck this sidebar belongs to, never another. */
  readonly openPane: ConsolePaneOpener;
  readonly layout: SidebarLayout;
  readonly snapshot: SidebarLayoutSnapshot;
  /** Where section bodies come from. Defaults to the process-wide seat. */
  readonly registry?: SidebarSectionRegistry;
  /** Which seat the palette's acts reach this sidebar through. Defaults to the window's. */
  readonly commandSeat?: MountedSidebarSeat;
}

/** The DOM attribute a section header carries, so the focus act needs no class name. */
const SECTION_HEADER_ATTRIBUTE = "data-sidebar-section";

export function SessionSidebar(props: SessionSidebarProps): React.JSX.Element {
  const registry = props.registry ?? sidebarSectionRegistry;
  const { layout, snapshot } = props;
  const columnReference = useRef<HTMLDivElement>(null);
  // Read HERE and not inside a callback: a hook may not be called from one, and a
  // sidebar mounted outside `LiveAnnouncerProvider` should fail on this line rather
  // than the first time a record settles.
  const announce = useAnnounce();

  // THE PROJECTION MOVES UNDER THIS COLUMN, and the containers it moves inside do not.
  // A section reports off its own family's projection of the session store, and that
  // store keeps ONE identity for the life of the session — so a memo keyed on the
  // registry and the two containers would be computed once at mount and never again,
  // and an approval that arrived a second later would reach no marker, open no section,
  // and stay marked after it resolved. The store's own transition counter is the value
  // that says the projection moved; it is what the readers are reading behind.
  //
  // ONE SUBSCRIPTION FOR THE COLUMN, not one per section: the counter names no
  // partition, so eight of them would deliver the same number eight times.
  const projectionRevision = useSessionProjectionRevision(props.sessionStore);

  // What each section reports right now, read off state its family already holds.
  // Never a read: the seat's own contract says the reader is called during render and
  // answers from a projection, which is what keeps a collapsed section free.
  const attentionBySectionId = useMemo<SidebarAttentionBySectionId>(() => {
    const attention: Partial<Record<SidebarSectionId, SidebarSectionAttention>> = {};
    for (const sectionId of SIDEBAR_SECTION_IDS) {
      const reported = registry
        .descriptorFor(sectionId)
        ?.attention?.({ sessionStore: props.sessionStore, bridge: props.bridge });
      if (reported !== undefined) {
        attention[sectionId] = reported;
      }
    }
    return attention;
    // `projectionRevision` is read by the readers above rather than by this body, which
    // is the whole of why it is here: it is the dependency that makes them re-run.
  }, [registry, props.sessionStore, props.bridge, projectionRevision]);

  const openSectionId = resolveOpenSectionId(attentionBySectionId, snapshot.state.chosenSectionId);

  const acts = useMemo<SidebarActs>(
    () => ({
      focusSidebar: () => {
        columnReference.current
          ?.querySelector<HTMLButtonElement>(`[${SECTION_HEADER_ATTRIBUTE}]`)
          ?.focus();
      },
      toggleSidebarCollapsed: () => {
        layout.toggleCollapsed();
      },
    }),
    [layout],
  );
  useMountedSidebar(acts, props.commandSeat);

  // Announced ONCE, when the saved arrangement settles — not on a re-render, not when
  // the person opens a section, and not when there is nothing to report. `hasSettled`
  // only ever goes false to true within one mount, so the guard is the transition
  // itself.
  //
  // AND ONLY WHERE THE SETTLED STATE SAYS SOMETHING THE COLUMN DOES NOT. A sidebar that
  // restored nothing and opened nothing is a sidebar a person is looking at, and
  // announcing it would spend the window's one polite lane on it — the announcer
  // serialises, so a sentence nobody needed delays the next one that somebody does.
  // What is worth saying is a section that came back open, which the restore or an
  // attention item decided rather than the person, and a restore that dropped
  // something.
  const hasAnnouncedReference = useRef(false);
  useEffect(() => {
    if (!snapshot.hasSettled || hasAnnouncedReference.current) {
      return;
    }
    const sentence = settlementSentence(openSectionId, snapshot.restoreRefusals);
    if (sentence === undefined) {
      hasAnnouncedReference.current = true;
      return;
    }
    hasAnnouncedReference.current = true;
    announce(sentence);
  }, [announce, openSectionId, snapshot.hasSettled, snapshot.restoreRefusals]);

  const pressSection = useCallback(
    (sectionId: SidebarSectionId) => {
      layout.pressSection(sectionId);
    },
    [layout],
  );

  const expand = useCallback(() => {
    layout.setCollapsed(false);
  }, [layout]);

  const collapse = useCallback(() => {
    layout.setCollapsed(true);
  }, [layout]);

  if (snapshot.state.isCollapsed) {
    return (
      <div className="meridian-sidebar meridian-sidebar--collapsed" ref={columnReference}>
        <button
          type="button"
          className="meridian-sidebar__expand"
          aria-expanded={false}
          onClick={expand}
        >
          Session sidebar
        </button>
      </div>
    );
  }

  return (
    <div className="meridian-sidebar" ref={columnReference}>
      {snapshot.restoreRefusals.length === 0 ? null : (
        <div className="meridian-sidebar__refusals" role="status">
          {snapshot.restoreRefusals.map((refusal, position) => (
            <InlineRefusal
              key={`${refusal.code}-${String(position)}`}
              code={refusal.code}
              detail={refusal.detail}
            />
          ))}
        </div>
      )}
      {/* The collapse control lives on the column rather than only in the palette:
          the palette row is how a person reaches it from the keyboard, and a surface
          whose only way into a state is a command is a surface most people never
          find. `aria-expanded` is on both this control and the rail's, so the pair
          reads as one disclosure however it is reached. */}
      <div className="meridian-sidebar__chrome">
        <button
          type="button"
          className="meridian-sidebar__collapse"
          aria-expanded={true}
          onClick={collapse}
        >
          Collapse the session sidebar
        </button>
      </div>
      <ul className="meridian-sidebar__sections">
        {SIDEBAR_SECTION_IDS.map((sectionId) => (
          <SidebarSection
            key={sectionId}
            sectionId={sectionId}
            isOpen={sectionId === openSectionId}
            attention={attentionBySectionId[sectionId]}
            registry={registry}
            sessionStore={props.sessionStore}
            bridge={props.bridge}
            openPane={props.openPane}
            onPress={pressSection}
          />
        ))}
      </ul>
    </div>
  );
}

/**
 * What the sidebar says when its arrangement settles, or nothing.
 *
 * The refusal wins where there is one, and it is the refusal's own sentence rather
 * than a paraphrase — rule 9 renders what was refused, and the inline refusal beside
 * this carries the code.
 */
function settlementSentence(
  openSectionId: SidebarSectionId | undefined,
  restoreRefusals: readonly ConsoleRefusal[],
): string | undefined {
  const refusal = restoreRefusals[0];
  if (refusal !== undefined) {
    return refusal.detail;
  }
  if (openSectionId === undefined) {
    return undefined;
  }
  return `The session sidebar opened with ${SIDEBAR_SECTION_LABELS[openSectionId]}, ${String(SIDEBAR_SECTION_IDS.length - 1)} of its ${String(SIDEBAR_SECTION_IDS.length)} sections collapsed.`;
}

interface SidebarSectionProps {
  readonly sectionId: SidebarSectionId;
  readonly isOpen: boolean;
  readonly attention: SidebarSectionAttention | undefined;
  readonly registry: SidebarSectionRegistry;
  readonly sessionStore: SessionStore;
  readonly bridge: ConsoleBridge;
  readonly openPane: ConsolePaneOpener;
  readonly onPress: (sectionId: SidebarSectionId) => void;
}

/**
 * One section: a real button in tab order, and its body only while it is open.
 *
 * `aria-expanded` is on the button and `aria-controls` names the region it opens, so
 * the disclosure a sighted person sees and the one a screen reader hears are the same
 * disclosure. The body is mounted inside the region rather than hidden with CSS,
 * because hiding it would leave the section's read running behind the fold.
 */
function SidebarSection(props: SidebarSectionProps): React.JSX.Element {
  const { sectionId } = props;
  const headerId = `meridian-sidebar-header-${sectionId}`;
  const regionId = `meridian-sidebar-region-${sectionId}`;
  const render = props.registry.descriptorFor(sectionId)?.render;

  return (
    <li className="meridian-sidebar__section">
      <button
        type="button"
        id={headerId}
        className="meridian-sidebar__header"
        aria-expanded={props.isOpen}
        aria-controls={regionId}
        {...{ [SECTION_HEADER_ATTRIBUTE]: sectionId }}
        {...(props.attention === undefined ? {} : { "data-attention": props.attention })}
        onClick={() => {
          props.onPress(sectionId);
        }}
      >
        {SIDEBAR_SECTION_LABELS[sectionId]}
      </button>
      {!props.isOpen ? null : (
        <div
          id={regionId}
          role="region"
          aria-labelledby={headerId}
          className="meridian-sidebar__body"
        >
          {render === undefined ? (
            <Nothing
              kind="not-checked"
              placement="surface"
              title="Nothing has filled this section yet."
              detail="No part of this console has registered a body for it in this window, so nothing has been asked."
            />
          ) : (
            render({
              sessionStore: props.sessionStore,
              bridge: props.bridge,
              openPane: props.openPane,
              isOpen: true,
            })
          )}
        </div>
      )}
    </li>
  );
}
