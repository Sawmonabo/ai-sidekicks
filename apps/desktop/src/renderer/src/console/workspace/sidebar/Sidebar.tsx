// The session sidebar's frame: the filter, the sections host, the width, and the
// collapse rule.
//
// `Spec-023 §Console Design (Meridian)` §4.4 — "Show what else in the session
// needs a look, as independently loaded sections that open panes." The sections
// are four families' bodies and the frame is one; this file is the frame, and it
// renders whatever the section registry answers with.
//
// THE FRAME READS NO WIRE. §4.4's own sentence — "the sidebar reads nothing itself
// beyond `session.read` and `session.subscribe` for the spine" — is why there is
// no bridge call here. Counts, rollup status, and what a filter matches are each a
// property of a SECTION's read, so a frame that computed one would be synthesising
// a badge the daemon has not served, which the same section forbids in as many
// words. What the frame owns is the SHAPE: which section is open, where the
// keyboard is, what the filter holds, and how wide the column is.
//
// COLLAPSE, THE FILTER, THE CURSOR, AND THE WIDTH ALL LIVE IN `SidebarModel`. The
// component subscribes and dispatches; it holds no state of its own beyond the map
// of disclosure elements, which is a DOM handle rather than state — nothing
// renders from it, and the cursor it serves is the model's.
//
// THE REGISTRY IS AN INJECTABLE PROP OVER A PROCESS-WIDE DEFAULT. Four families
// fill this sidebar by calling `registerSidebarSection`, which writes into the
// process-wide registry, so a mount that named no registry would have to read
// that one or render six empty seats — the default is what the seat contract
// already means. It stays overridable for the two cases where the process-wide
// one is the wrong answer: a test composes sections into a registry it owns
// rather than leaking into a shared one, and an auxiliary window composes a
// different subset without a second code path.

import { useCallback, useId, useMemo, useRef } from "react";

import { InlineRefusal } from "../../primitives/index.js";
import { type ConsoleBridge } from "../../bridge/index.js";
import { type UiStateStore } from "../../persistence/index.js";
import { type SessionStore } from "../../store/index.js";
import {
  SIDEBAR_SECTION_IDS,
  sidebarSectionRegistry,
  type ConsolePaneOpener,
  type SidebarSectionId,
  type SidebarSectionRegistry,
} from "../seats/index.js";
import { SidebarResizeHandle } from "./SidebarResizeHandle.js";
import { SidebarSection } from "./SidebarSection.js";
import { useSidebarKeyboard, useSidebarModel, useSidebarSnapshot } from "./sidebar-hooks.js";

import "./sidebar.css";

/** Carries the model's width into the column, so CSS owns layout and JS owns the number. */
interface SidebarWidthStyle extends React.CSSProperties {
  readonly "--meridian-sidebar-width": string;
}

export interface SidebarProps {
  readonly sessionStore: SessionStore;
  readonly bridge: ConsoleBridge;
  /**
   * How a section opens a pane. Handed down rather than imported, so a sidebar
   * rendered in an auxiliary window opens panes in THAT window's deck.
   */
  readonly openPane: ConsolePaneOpener;
  /** The registry the sections were filled through. Defaults to the process-wide one. */
  readonly sectionRegistry?: SidebarSectionRegistry;
  /**
   * Where collapse and width are kept, or `undefined` for a sidebar with no
   * durable home. Omitted, the sidebar works and forgets — which is honest, and
   * is what an auxiliary window with no database of its own gets.
   */
  readonly uiStateStore?: UiStateStore;
}

export function Sidebar(props: SidebarProps): React.JSX.Element {
  const filterFieldId = useId();
  const containerRef = useRef<HTMLElement | null>(null);
  // A DOM handle rather than state: nothing renders from it, and re-rendering
  // when a disclosure mounts would be a render caused by a ref callback.
  const disclosuresRef = useRef(new Map<SidebarSectionId, HTMLButtonElement>());

  const sectionRegistry = props.sectionRegistry ?? sidebarSectionRegistry;

  const model = useSidebarModel(props.sessionStore.sessionId, props.uiStateStore);
  const snapshot = useSidebarSnapshot(model);

  const registerDisclosure = useCallback(
    (id: SidebarSectionId, element: HTMLButtonElement | null) => {
      if (element === null) {
        disclosuresRef.current.delete(id);
        return;
      }
      disclosuresRef.current.set(id, element);
    },
    [],
  );

  const focusSection = useCallback((id: SidebarSectionId) => {
    disclosuresRef.current.get(id)?.focus();
  }, []);

  const keyboardTargets = useMemo(
    () => ({ openPane: props.openPane, focusSection }),
    [props.openPane, focusSection],
  );
  useSidebarKeyboard(model, keyboardTargets, containerRef);

  const widthStyle: SidebarWidthStyle = {
    "--meridian-sidebar-width": `${String(snapshot.widthPx)}px`,
  };

  return (
    <nav
      className="meridian-sidebar"
      aria-label="Session sidebar"
      ref={containerRef}
      style={widthStyle}
    >
      <div className="meridian-sidebar__filter">
        <label className="meridian-visually-hidden" htmlFor={filterFieldId}>
          Filter the sidebar by title or path
        </label>
        <input
          id={filterFieldId}
          className="meridian-sidebar__filter-field"
          type="search"
          // `search` rather than `text` so the platform's own clear affordance is
          // there. §4.4 offers no global search here — that is a growth item —
          // and the placeholder says which of the two this is.
          placeholder="Filter sections"
          value={snapshot.filterQuery}
          onChange={(event) => {
            model.setFilterQuery(event.currentTarget.value);
          }}
        />
      </div>
      <ul className="meridian-sidebar__sections">
        {SIDEBAR_SECTION_IDS.map((id) => (
          <SidebarSection
            key={id}
            id={id}
            model={model}
            render={sectionRegistry.descriptorFor(id)?.render}
            isOpen={model.isSectionOpen(id)}
            isCursored={snapshot.cursorSectionId === id}
            attention={model.attentionFor(id)}
            filterQuery={snapshot.filterQuery}
            sessionStore={props.sessionStore}
            bridge={props.bridge}
            openPane={props.openPane}
            registerDisclosure={registerDisclosure}
          />
        ))}
      </ul>
      {snapshot.persistenceRefusal === undefined ? null : (
        <div className="meridian-sidebar__refusal">
          <InlineRefusal
            code={snapshot.persistenceRefusal.code}
            detail={snapshot.persistenceRefusal.detail}
          />
        </div>
      )}
      <SidebarResizeHandle
        widthPx={snapshot.widthPx}
        onResize={(widthPx) => {
          model.setWidth(widthPx);
        }}
      />
    </nav>
  );
}
