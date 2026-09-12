// The session sidebar: the session's other work, as independently loaded sections.
//
// The design track describes this surface as showing "the session's other work as
// independently loaded sections … each a composition of its own read, opening panes; a
// section carrying an amber or red item is open and every other section is collapsed",
// and the layout grammar puts it in the workspace as a collapsible column beside the
// deck. This file is the column; `model/` holds the rules it renders, `persistence/`
// holds what it keeps, and `commands/` holds how a keyboard reaches it.
//
// ONE SIDEBAR, MADE FROM TWO. This surface was built twice on two branches, and this
// module is the single one that survived them. Concern by concern, what was kept and
// what was DELETED — no second model, no adapter between two models, no file kept for
// compatibility:
//
//   • **Section source** — the seat registry. Both builds already read
//     `sidebarSectionRegistry`, so families register and this file walks the seat's
//     declared tuple. The hard-coded section list is gone.
//   • **Open / collapse** — the INVERTED collapsed-id set, many sections open at once.
//     The design track asks for "expansion persistence as an inverted set (collapsed
//     ids), so a new section defaults open when it carries attention", which a
//     single-open accordion cannot express. The accordion's `chosenSectionId`,
//     `resolveOpenSectionId`, and `chooseSectionOnPress` are deleted.
//   • **Attention** — the descriptor's PULL reader, `attention?(context)`, driving the
//     open-once rule in `SidebarModel`. The push form, where a mounted body reported
//     its own level through the seat context, cannot work beside the rule below it: a
//     collapsed section is not mounted, so a section in trouble could never report and
//     the rule that opens it could never fire. `reportAttention` and the `red | amber |
//     calm` vocabulary beside it are deleted from the seat.
//   • **Body mounting** — a collapsed section mounts NOTHING. The always-mounted
//     `hidden` region is deleted: it ran every section's read to show one.
//   • **Filter** — the filter field above the tree, with auto-expand while filtering
//     and rollback when cleared. Read as an override in `SidebarModel.isSectionOpen`
//     rather than written into the collapsed set, so the rollback needs no bookkeeping.
//   • **Cursor and chords** — the DOM-free cursor, `j` / `k` / `Enter` / `Space`, on a
//     sidebar-scoped `CommandRegistry` and `KeyBindingTable` installed on this
//     element.
//   • **Palette seat** — ONE seat, `commands/sidebar-command-seat.ts`, carrying the
//     three acts reachable from outside the column.
//   • **Width and persistence** — ONE versioned record under one key, with a
//     refusal-typed restore rendered in the column. The two-key, two-partition,
//     pixel-valued pair beside it — and `sidebar-persistence.ts`, `sidebar-hooks.ts`,
//     and `sidebar-constants.ts` with it — is deleted.
//   • **Resize** — the workspace's own `Group` / `Panel` / `Separator` split, which
//     already owns this boundary. `SidebarResizeHandle.tsx` is deleted: a second
//     control on one boundary is exactly the second model this unification exists to
//     remove, and it is why the width is a PERCENT here rather than a pixel count.
//
// THE FRAME READS NO WIRE. Counts, rollup status, and what a filter matches are each a
// property of a SECTION's read, so a frame that computed one would be synthesising a
// badge the daemon has not served. What this file owns is the SHAPE: which sections are
// open, where the keyboard is, what the filter holds.
//
// IT RENDERS SECTIONS IT DOES NOT OWN, WHICH IS WHY THE SEAT EXISTS. The bodies belong
// to three other families, so what walks below is the seat's DECLARED tuple — the order
// a person reads down the column — and never a list assembled from whoever happened to
// register. Every declared section shows its header, filled or not: on a branch where
// no family has registered, a sidebar that hid its unfilled sections would render as an
// empty column and read as "this session has no work", which is a claim the console has
// not established.

import { useCallback, useId, useLayoutEffect, useMemo, useRef } from "react";

import { type ConsoleBridge } from "../../bridge/index.js";
import { InlineRefusal, useAnnounce } from "../../primitives/index.js";
import { type FrameStore, type SessionStore } from "../../store/index.js";
import {
  SIDEBAR_SECTION_IDS,
  sidebarSectionRegistry,
  type ConsolePaneOpener,
  type SidebarRowDragTarget,
  type SidebarSectionId,
  type SidebarSectionRegistry,
} from "../../seats/index.js";
import { SidebarSection } from "./SidebarSection.js";
import { useSectionAttention, useSidebarSettlementAnnouncement } from "./sidebar-column-reads.js";
import {
  useMountedSidebar,
  type MountedSidebarSeat,
  type SidebarActs,
} from "./commands/sidebar-command-seat.js";
import { useSidebarKeyboard } from "./commands/use-sidebar-keyboard.js";
import { type SidebarModel, type SidebarSnapshot } from "./model/sidebar-model.js";
import { BulkActionBar } from "./bulk/BulkActionBar.js";
import { useBulkSelectionFace, useBulkSelectionModel } from "./bulk/use-bulk-selection.js";
import { useSidebarRowDragSources, useSidebarRowDropMonitor } from "./drag/row-drag.js";

export interface SidebarProps {
  readonly sessionStore: SessionStore;
  readonly bridge: ConsoleBridge;
  /**
   * This window's own store, handed to every section.
   *
   * A section reads it for one thing — whether a mutating call can be sent at all —
   * and it is a prop for `openPane`'s reason: a sidebar rendered in an auxiliary
   * window reports that window's shell rather than the main window's.
   */
  readonly frameStore: FrameStore;
  /**
   * How a section opens a pane. Handed down rather than imported, so a sidebar rendered
   * in an auxiliary window opens panes in THAT window's deck.
   */
  readonly openPane: ConsolePaneOpener;
  /**
   * The sidebar's state, owned by the workspace.
   *
   * Owned there and not here because the workspace's split reads the width to size the
   * panel and writes it back when the separator settles — the same number this column
   * renders inside. Two owners for one width is two numbers that disagree for a frame.
   */
  readonly model: SidebarModel;
  readonly snapshot: SidebarSnapshot;
  /**
   * The registry the sections were filled through. Defaults to the process-wide one.
   *
   * Overridable for the two cases where the process-wide one is the wrong answer: a
   * test composes sections into a registry it owns rather than leaking into a shared
   * one, and an auxiliary window composes a different subset without a second code
   * path.
   */
  readonly sectionRegistry?: SidebarSectionRegistry;
  /** Which seat the palette's acts reach this sidebar through. Defaults to the window's. */
  readonly commandSeat?: MountedSidebarSeat;
}

export function Sidebar(props: SidebarProps): React.JSX.Element {
  const { model, snapshot } = props;
  const filterFieldId = useId();
  const columnReference = useRef<HTMLElement | null>(null);
  const filterFieldReference = useRef<HTMLInputElement | null>(null);
  // A DOM handle rather than state: nothing renders from it, and re-rendering when a
  // disclosure mounts would be a render caused by a ref callback.
  const disclosuresReference = useRef(new Map<SidebarSectionId, HTMLButtonElement>());
  // Read HERE and not inside a callback: a hook may not be called from one, and a
  // sidebar mounted outside `LiveAnnouncerProvider` should fail on this line rather
  // than the first time a record settles.
  const announce = useAnnounce();

  const sectionRegistry = props.sectionRegistry ?? sidebarSectionRegistry;

  const rollupBySectionId = useSectionAttention(
    model,
    sectionRegistry,
    props.sessionStore,
    props.bridge,
    props.frameStore,
  );

  // ONE SELECTION AND ONE SET OF DRAG SOURCES FOR THE COLUMN. A bulk act crosses
  // sections and a drop opens into this column's own deck, so both are the column's
  // rather than a section's — and both are handed DOWN through the section context, so
  // a section reaches neither by import.
  //
  // The selection is held per SESSION rather than per mount: this column is re-bound as
  // the workspace moves between sessions, and the bar below hands the runner this
  // session's id beside whatever rows are ticked. `use-bulk-selection.ts` owns why that
  // pairing is the subject-scoped holder's and not a clear of this file's own.
  const bulkSelection = useBulkSelectionModel(props.bridge, props.sessionStore.sessionId);
  const bulkSelectionFace = useBulkSelectionFace(bulkSelection);
  const rowDragSources = useSidebarRowDragSources();
  const bindRowDrag = useCallback(
    (target: SidebarRowDragTarget) => rowDragSources.binderFor(target),
    [rowDragSources],
  );
  useSidebarRowDropMonitor(props.openPane, announce);

  const registerDisclosure = useCallback(
    (sectionId: SidebarSectionId, element: HTMLButtonElement | null) => {
      if (element === null) {
        disclosuresReference.current.delete(sectionId);
        return;
      }
      disclosuresReference.current.set(sectionId, element);
    },
    [],
  );

  // WHAT THE ACT WANTS FOCUSED, WHEN THE THING IT WANTS IS NOT ON SCREEN YET. Both
  // focus acts open the column first, and on a collapsed column the control they are
  // reaching for does not exist until React has committed that open — so taking focus
  // in the act body would silently do nothing exactly when a person reached for the
  // sidebar from outside it, which is the case these acts exist for. A ref rather than
  // state: nothing renders from it, and it is consumed in the same commit.
  const pendingFocusReference = useRef<"filter" | SidebarSectionId | undefined>(undefined);
  const takeFocus = useCallback((target: "filter" | SidebarSectionId) => {
    if (target === "filter") {
      const field = filterFieldReference.current;
      if (field === null) {
        return false;
      }
      field.focus();
      return true;
    }
    const disclosure = disclosuresReference.current.get(target);
    if (disclosure === undefined) {
      return false;
    }
    disclosure.focus();
    return true;
  }, []);

  const keyboardTargets = useMemo(
    () => ({
      openPane: props.openPane,
      focusSection: (sectionId: SidebarSectionId) => {
        takeFocus(sectionId);
      },
    }),
    [props.openPane, takeFocus],
  );
  useSidebarKeyboard(model, keyboardTargets, columnReference);

  const acts = useMemo<SidebarActs>(
    () => ({
      focusSidebar: () => {
        model.setColumnCollapsed(false);
        if (!takeFocus(model.snapshot.cursorSectionId)) {
          pendingFocusReference.current = model.snapshot.cursorSectionId;
        }
      },
      toggleSidebarCollapsed: () => {
        model.toggleColumnCollapsed();
      },
      focusSidebarFilter: () => {
        model.setColumnCollapsed(false);
        if (!takeFocus("filter")) {
          pendingFocusReference.current = "filter";
        }
      },
    }),
    [model, takeFocus],
  );
  useMountedSidebar(acts, props.commandSeat);

  // A LAYOUT effect, and keyed on the collapse: this is the commit in which the column
  // the act opened first has its controls, and taking focus before paint is what keeps
  // the move invisible rather than a flash of the rail with focus arriving after it.
  useLayoutEffect(() => {
    const pending = pendingFocusReference.current;
    if (pending !== undefined && takeFocus(pending)) {
      pendingFocusReference.current = undefined;
    }
  }, [snapshot.state.isCollapsed, takeFocus]);

  useSidebarSettlementAnnouncement(model, snapshot);

  const pressSection = useCallback(
    (sectionId: SidebarSectionId) => {
      model.setCursor(sectionId);
      model.toggleSection(sectionId);
    },
    [model],
  );

  if (snapshot.state.isCollapsed) {
    return (
      <nav className="meridian-sidebar meridian-sidebar--collapsed" aria-label="Session sidebar">
        <button
          type="button"
          className="meridian-sidebar__expand"
          aria-expanded={false}
          onClick={() => {
            model.setColumnCollapsed(false);
          }}
        >
          Session sidebar
        </button>
      </nav>
    );
  }

  return (
    <nav className="meridian-sidebar" aria-label="Session sidebar" ref={columnReference}>
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
      {/* The collapse control lives on the column rather than only in the palette: the
          palette row is how a person reaches it from the keyboard, and a surface whose
          only way into a state is a command is a surface most people never find.
          `aria-expanded` is on both this control and the rail's, so the pair reads as
          one disclosure however it is reached. */}
      <div className="meridian-sidebar__chrome">
        <button
          type="button"
          className="meridian-sidebar__collapse"
          aria-expanded={true}
          onClick={() => {
            model.setColumnCollapsed(true);
          }}
        >
          Collapse the session sidebar
        </button>
      </div>
      <div className="meridian-sidebar__filter">
        <label className="meridian-visually-hidden" htmlFor={filterFieldId}>
          Filter the sidebar by title or path
        </label>
        <input
          id={filterFieldId}
          ref={filterFieldReference}
          className="meridian-sidebar__filter-field"
          type="search"
          // `search` rather than `text` so the platform's own clear affordance is there.
          // This is the sidebar filter the library axes name beside the palette,
          // settings search, and find — not a global search, which is a growth item —
          // and the placeholder says which of the two it is.
          placeholder="Filter sections"
          value={snapshot.filterQuery}
          onChange={(event) => {
            model.setFilterQuery(event.currentTarget.value);
          }}
        />
      </div>
      <ul className="meridian-sidebar__sections">
        {SIDEBAR_SECTION_IDS.map((sectionId) => (
          <SidebarSection
            key={sectionId}
            sectionId={sectionId}
            render={sectionRegistry.descriptorFor(sectionId)?.render}
            isOpen={model.isSectionOpen(sectionId)}
            isCursored={snapshot.cursorSectionId === sectionId}
            attention={snapshot.attentionBySectionId[sectionId]}
            rollup={rollupBySectionId[sectionId]}
            bulk={bulkSelectionFace}
            dragRow={bindRowDrag}
            filterQuery={snapshot.filterQuery}
            sessionStore={props.sessionStore}
            bridge={props.bridge}
            frameStore={props.frameStore}
            openPane={props.openPane}
            onPress={pressSection}
            registerDisclosure={registerDisclosure}
          />
        ))}
      </ul>
      {/* Below the sections rather than above them: the bar is the consequence of what
          is selected in the tree, and a bar at the top would move the whole column
          down the first time somebody ticked a row. */}
      <BulkActionBar model={bulkSelection} bridge={props.bridge} />
    </nav>
  );
}
