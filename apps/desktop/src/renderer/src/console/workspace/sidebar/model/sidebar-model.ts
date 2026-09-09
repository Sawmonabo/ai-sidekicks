// The sidebar's own state: what is shut, where the cursor is, what the filter holds,
// how wide the column is, and which sections are asking for a look.
//
// A CLASS AND NOT REACT STATE. `apps/desktop/AGENTS.md` puts stateful logic in an
// encapsulated class, and this state has four properties that make the rule bite here
// rather than merely apply: the collapsed set is DURABLE and its load is asynchronous,
// the cursor is addressed by keyboard commands that run outside React's tree, the
// auto-open rule is a decision over the whole set rather than a value one component
// holds, and every one of those is worth testing without a renderer. The component
// subscribes; it owns nothing.
//
// FOUR DECISIONS THIS CLASS MAKES
//
//   1. **Collapse is an inverted set.** What is stored is what the person SHUT, so a
//      section minted after the last save is open — which is the arm that matters,
//      because the new section is the one nobody has seen. The grammar is
//      `sidebar-layout-record.ts`'; the rule is this class's.
//   2. **Filtering never mutates the collapsed set.** Filtering auto-expands and
//      clearing rolls back, and rollback is free if the filter is read as an OVERRIDE
//      at the point of the question rather than written into the state — a filter that
//      expanded by mutating would have to remember what it changed, and would get it
//      wrong the moment somebody collapsed a section mid-filter.
//   3. **Attention opens a section once, and never re-opens one that was shut.** A
//      section that keeps calling must not fight the person who just collapsed it. The
//      moment somebody touches a section, that section is theirs; before that, "a
//      section carrying an amber or red item is open" applies.
//   4. **The durable read fills in what nothing has decided, and overrides nothing.**
//      Opening a database and reading a record is not instant, and the sidebar is on
//      screen and interactive throughout. A restore that published what was on disk
//      would silently undo a resize, a collapse, or a section press made in that
//      window — the person watches their own act reverse itself a moment later, which
//      is worse than not restoring at all. So the read is applied per axis and per
//      section, only where nothing has moved since construction.
//
// THIS CLASS STORES NOTHING. It holds state and emits; the durable write is
// `persistence/use-sidebar-layout.ts`', which coalesces a drag's worth of changes into
// one write in flight. A model that wrote for itself would be a second writer beside
// the one the deck already shares, with its own idea of when a gesture is over.

import { Emitter, type Unsubscribe } from "../../../core/index.js";
import {
  SIDEBAR_SECTION_IDS,
  type SidebarSectionDescriptor,
  type SidebarSectionId,
} from "../../../seats/index.js";
import {
  INITIAL_SIDEBAR_LAYOUT_STATE,
  clampSidebarWidthPercent,
  collapsedSectionSetsMatch,
  type DecodedSidebarLayout,
  type SidebarLayoutState,
  type SidebarRestoreRefusal,
} from "./sidebar-layout-record.js";

/**
 * What a section reports when it is calling for somebody.
 *
 * Derived from the seat's own optional reader rather than restated: the closed set is
 * declared once, on the contract the families write against, and this alias is how the
 * sidebar names it without a second union that could drift from it.
 */
export type SidebarSectionAttention = NonNullable<
  ReturnType<NonNullable<SidebarSectionDescriptor["attention"]>>
>;

/** What each section reports right now. Absent means "not calling", never "unknown". */
export type SidebarAttentionBySectionId = Readonly<
  Partial<Record<SidebarSectionId, SidebarSectionAttention>>
>;

/** The whole of what the sidebar renders from. Replaced, never mutated in place. */
export interface SidebarSnapshot {
  /** The width, the column collapse, and the shut sections — the durable triple. */
  readonly state: SidebarLayoutState;
  /** Where the DOM-free cursor is. Always a member of the declared set. */
  readonly cursorSectionId: SidebarSectionId;
  /** The filter field's text, verbatim. Empty means no filter is on. */
  readonly filterQuery: string;
  /** What each section last answered. Absent means it is not calling. */
  readonly attentionBySectionId: SidebarAttentionBySectionId;
  /** What the restore dropped, rendered in the sidebar rather than swallowed. */
  readonly restoreRefusals: readonly SidebarRestoreRefusal[];
  /** Whether the record has been read — the moment the surface announces once. */
  readonly hasSettled: boolean;
}

export class SidebarModel {
  readonly #emitter = new Emitter<SidebarSnapshot>("sidebar model");
  /** Sections the person has opened or shut themselves, so attention stops deciding. */
  readonly #personallySetSectionIds = new Set<SidebarSectionId>();
  /**
   * Sections whose state has been decided since construction, by anybody.
   *
   * Wider than `#personallySetSectionIds` on purpose: the auto-open rule is a decision
   * too, and a restore that shut a section attention had just opened would leave it
   * shut. This set is what decision 4 re-imposes over the durable read.
   */
  readonly #decidedSectionIds = new Set<SidebarSectionId>();
  #widthWasDecided = false;
  #columnCollapseWasDecided = false;
  #snapshot: SidebarSnapshot = {
    state: INITIAL_SIDEBAR_LAYOUT_STATE,
    cursorSectionId: SIDEBAR_SECTION_IDS[0],
    filterQuery: "",
    attentionBySectionId: {},
    restoreRefusals: [],
    hasSettled: false,
  };

  public get snapshot(): SidebarSnapshot {
    return this.#snapshot;
  }

  public subscribe(listener: (snapshot: SidebarSnapshot) => void): Unsubscribe {
    return this.#emitter.subscribe(listener);
  }

  /**
   * Whether a section is open right now.
   *
   * The filter is an OVERRIDE read here rather than a mutation written into the
   * collapsed set — decision 2. A person filtering sees every section that could hold
   * a match; clearing the field puts the sidebar back exactly as they left it, with no
   * bookkeeping to get wrong.
   */
  public isSectionOpen(sectionId: SidebarSectionId): boolean {
    return (
      this.#snapshot.filterQuery !== "" || !this.#snapshot.state.collapsedSectionIds.has(sectionId)
    );
  }

  /**
   * Adopt what the record held, and mark the sidebar settled either way.
   *
   * Answers whether what is now on screen DIFFERS from what the record held, which is
   * the caller's write-back gate: a restore that adopted the record exactly has nothing
   * to file, and filing it anyway spends a durable write on every session a person
   * opens — and writes back the NARROWED value where the decode dropped an axis, so
   * the record loses what a later build could have read.
   *
   * Settled is set even where nothing was saved: "nobody has arranged this sidebar yet"
   * is an answer, and a surface that waited for a record that will never exist would
   * announce nothing on every first visit.
   */
  public restore(decoded: DecodedSidebarLayout): boolean {
    // Decision 4: what was decided while the read was in flight outranks the read. The
    // restored value is the base and the decisions are re-imposed over it, per axis and
    // per section, so a section nobody has touched still comes back the way it was left.
    const collapsedSectionIds = new Set(decoded.state.collapsedSectionIds);
    for (const sectionId of this.#decidedSectionIds) {
      if (this.#snapshot.state.collapsedSectionIds.has(sectionId)) {
        collapsedSectionIds.add(sectionId);
      } else {
        collapsedSectionIds.delete(sectionId);
      }
    }
    const state: SidebarLayoutState = {
      widthPercent: this.#widthWasDecided
        ? this.#snapshot.state.widthPercent
        : decoded.state.widthPercent,
      isCollapsed: this.#columnCollapseWasDecided
        ? this.#snapshot.state.isCollapsed
        : decoded.state.isCollapsed,
      collapsedSectionIds,
    };
    this.#publish({ state, restoreRefusals: decoded.refusals, hasSettled: true });
    return !layoutStatesMatch(state, decoded.state);
  }

  /** Open a shut section or shut an open one. The person's own act, so it sticks. */
  public toggleSection(sectionId: SidebarSectionId): void {
    this.setSectionCollapsed(sectionId, !this.#snapshot.state.collapsedSectionIds.has(sectionId));
  }

  /**
   * Set one section's collapse state.
   *
   * Records that a person decided it, which is what stops a section that keeps calling
   * from re-opening itself over their shoulder. Recorded before the no-op check, for
   * `recordWidthPercent`'s reason: asking for the state a section is already in is
   * still a decision, and decision 4 must not let the durable read move it afterwards.
   */
  public setSectionCollapsed(sectionId: SidebarSectionId, isCollapsed: boolean): void {
    this.#personallySetSectionIds.add(sectionId);
    this.#decidedSectionIds.add(sectionId);
    this.#applySectionCollapse(sectionId, isCollapsed);
  }

  /** Shut the whole column down to the rail's width, or open it again. */
  public setColumnCollapsed(isCollapsed: boolean): void {
    this.#columnCollapseWasDecided = true;
    if (this.#snapshot.state.isCollapsed === isCollapsed) {
      return;
    }
    this.#publishState({ ...this.#snapshot.state, isCollapsed });
  }

  public toggleColumnCollapsed(): void {
    this.setColumnCollapsed(!this.#snapshot.state.isCollapsed);
  }

  /** Adopt the width the workspace's split settled on, clamped to the usable band. */
  public recordWidthPercent(widthPercent: number): void {
    this.#widthWasDecided = true;
    const clamped = clampSidebarWidthPercent(widthPercent);
    if (this.#snapshot.state.widthPercent === clamped) {
      return;
    }
    this.#publishState({ ...this.#snapshot.state, widthPercent: clamped });
  }

  /**
   * Take the sections' own readings of how loudly they are asking to be looked at.
   *
   * The whole map at once rather than one report per section, because the sidebar reads
   * every descriptor in one render pass and a per-section call would publish once per
   * section and re-render the column eight times. Idempotent: an unchanged map moves
   * nothing, which is what lets the caller hand it over from an effect on every pass.
   *
   * Opens a section that has STARTED calling, and only while the person has not decided
   * that section themselves — decision 3. A section that goes on calling at the same
   * level moves nothing, so a person may shut it and have it stay shut.
   */
  public syncAttention(attentionBySectionId: SidebarAttentionBySectionId): void {
    const previous = this.#snapshot.attentionBySectionId;
    if (attentionsMatch(previous, attentionBySectionId)) {
      return;
    }
    // Opened in ONE publish beside the reading that opened them, rather than by calling
    // the collapse act per section: this runs from the column's render pass, and a
    // publish per newly-calling section would re-render the whole column once per
    // section for a single change in the projection behind them.
    const collapsedSectionIds = new Set(this.#snapshot.state.collapsedSectionIds);
    for (const sectionId of SIDEBAR_SECTION_IDS) {
      const isNewlyCalling =
        attentionBySectionId[sectionId] !== undefined &&
        attentionBySectionId[sectionId] !== previous[sectionId];
      if (isNewlyCalling && !this.#personallySetSectionIds.has(sectionId)) {
        collapsedSectionIds.delete(sectionId);
        this.#decidedSectionIds.add(sectionId);
      }
    }
    this.#publish({
      attentionBySectionId,
      state: { ...this.#snapshot.state, collapsedSectionIds },
    });
  }

  /** What a section last answered, or `undefined` while it is not calling. */
  public attentionFor(sectionId: SidebarSectionId): SidebarSectionAttention | undefined {
    return this.#snapshot.attentionBySectionId[sectionId];
  }

  /** Move the cursor by whole sections, stopping at the ends rather than wrapping. */
  public moveCursor(offset: number): void {
    const position = SIDEBAR_SECTION_IDS.indexOf(this.#snapshot.cursorSectionId);
    const next = SIDEBAR_SECTION_IDS[clamp(position + offset, 0, SIDEBAR_SECTION_IDS.length - 1)];
    if (next !== undefined) {
      this.setCursor(next);
    }
  }

  public setCursor(sectionId: SidebarSectionId): void {
    if (this.#snapshot.cursorSectionId !== sectionId) {
      this.#publish({ cursorSectionId: sectionId });
    }
  }

  /** The filter text, verbatim. Never persisted — it is what a person typed. */
  public setFilterQuery(filterQuery: string): void {
    if (this.#snapshot.filterQuery !== filterQuery) {
      this.#publish({ filterQuery });
    }
  }

  #applySectionCollapse(sectionId: SidebarSectionId, isCollapsed: boolean): void {
    const collapsedSectionIds = new Set(this.#snapshot.state.collapsedSectionIds);
    if (isCollapsed) {
      collapsedSectionIds.add(sectionId);
    } else {
      collapsedSectionIds.delete(sectionId);
    }
    if (collapsedSectionIds.size === this.#snapshot.state.collapsedSectionIds.size) {
      return;
    }
    this.#decidedSectionIds.add(sectionId);
    this.#publishState({ ...this.#snapshot.state, collapsedSectionIds });
  }

  #publishState(state: SidebarLayoutState): void {
    this.#publish({ state });
  }

  #publish(change: Partial<SidebarSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...change };
    this.#emitter.emit(this.#snapshot);
  }
}

function clamp(value: number, lowest: number, highest: number): number {
  return Math.min(Math.max(value, lowest), highest);
}

/**
 * Whether two arrangements are the same one.
 *
 * Written as a field-by-field conjunction rather than over `Object.entries`, so a
 * fourth axis on {@link SidebarLayoutState} fails to compile here instead of being
 * silently declared equal.
 */
function layoutStatesMatch(left: SidebarLayoutState, right: SidebarLayoutState): boolean {
  return (
    left.widthPercent === right.widthPercent &&
    left.isCollapsed === right.isCollapsed &&
    collapsedSectionSetsMatch(left.collapsedSectionIds, right.collapsedSectionIds)
  );
}

/** Whether two attention readings say the same thing about every declared section. */
function attentionsMatch(
  left: SidebarAttentionBySectionId,
  right: SidebarAttentionBySectionId,
): boolean {
  return SIDEBAR_SECTION_IDS.every((sectionId) => left[sectionId] === right[sectionId]);
}
