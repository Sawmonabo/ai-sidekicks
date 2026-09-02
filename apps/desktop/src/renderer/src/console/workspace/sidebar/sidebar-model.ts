// The sidebar's own state: what is collapsed, where the cursor is, what the
// filter holds, how wide the column is, and which sections are asking for a look.
//
// A CLASS AND NOT REACT STATE. `apps/desktop/AGENTS.md` puts stateful logic in an
// encapsulated class, and this state has four properties that make the rule bite
// here rather than merely apply: the collapsed set is DURABLE and its load is
// asynchronous, the cursor is addressed by keyboard commands that run outside
// React's tree, the auto-open rule is a decision over the whole set rather than a
// value one component holds, and every one of those is worth testing without a
// renderer. The component subscribes; it owns nothing.
//
// THREE DECISIONS THIS CLASS MAKES
//
//   1. **Collapse is an inverted set.** THIS CLASS'S OWN RULE, because no
//      committed document states it: expansion persists as an inverted set
//      (collapsed ids), so a new section defaults open when it carries attention —
//      which is how `Spec-023 §The surface set`'s "a section carrying an amber or
//      red item is open" survives a section minted after the last save. What is stored is what
//      the person SHUT. A section minted after the last save is therefore open,
//      which is the arm that matters, because the new section is the one nobody
//      has seen.
//   2. **Filtering never mutates the collapsed set.** Also this class's own:
//      filtering auto-expands and clearing rolls back. Rollback is free if the filter
//      is read as an override at the point of the question rather than written
//      into the state — a filter that expanded by mutating would have to
//      remember what it changed, and would get it wrong the moment somebody
//      collapsed a section mid-filter.
//   3. **Attention opens a section once, and never re-opens one that was shut.**
//      A section reporting amber repeatedly must not fight the person who just
//      collapsed it. The moment somebody touches a section, that section is
//      theirs; before that, the rule "a section carrying an amber or red item is
//      open" applies.
//   4. **The durable read fills in what nothing has decided, and overrides
//      nothing.** Opening a database and reading two records is not instant, and
//      the sidebar is on screen and interactive throughout. A restore that
//      published what was on disk would silently undo a resize or a collapse made
//      in that window — the person watches their own act reverse itself a moment
//      later, which is worse than not restoring at all. So the read is applied
//      only to axes nothing has moved since construction, and every section that
//      has been decided keeps the state it is in.
//
// PERSISTENCE IS FIRE-AND-FORGET, AND REFUSALS ARE KEPT. Every durable byte goes
// through `UiStateStore`, whose `write` declares its failure as a returned value.
// The model does not await it — a person collapsing a section must not wait on a
// disk — but it does hold the last refusal, so a store that cannot keep the
// sidebar's shape says so on screen instead of silently forgetting.

import { Emitter, refuse, type ConsoleRefusal, type Unsubscribe } from "../../core/index.js";
import { type UiStateStore } from "../../persistence/index.js";
import {
  SIDEBAR_SECTION_IDS,
  type SidebarSectionAttention,
  type SidebarSectionId,
} from "../../seats/index.js";
import {
  SIDEBAR_COLLAPSED_SECTIONS_KEY,
  SIDEBAR_DEFAULT_WIDTH_PX,
  SIDEBAR_MAX_WIDTH_PX,
  SIDEBAR_MIN_WIDTH_PX,
  SIDEBAR_WIDTH_KEY,
} from "./sidebar-constants.js";
import {
  decodeCollapsedSectionIds,
  decodeSidebarWidth,
  encodeCollapsedSectionIds,
  encodeSidebarWidth,
  type SidebarLayoutValue,
} from "./sidebar-persistence.js";

/**
 * The subsystem name every refusal this module raises carries, and the one code
 * it can raise.
 *
 * Declared as a closed set for `core/refusal.ts`'s stated arrangement — "each
 * producer keeps its own closed code union and widens into this shape at its
 * boundary" — rather than as a literal at the single construction site, so the
 * sidebar's refusal vocabulary is countable rather than discoverable by grep.
 */
const SIDEBAR_REFUSAL_ORIGIN = "sidebar";

/** Why the sidebar could not keep its own shape. Rendered verbatim; never swallowed. */
export const SIDEBAR_REFUSAL_CODES = ["persistence-write-failed"] as const;

/** What one durable write settles as, derived from the chokepoint rather than restated. */
type SidebarWriteResult = Awaited<ReturnType<UiStateStore["write"]>>;

/**
 * Whether an attention level is the kind that opens a section on its own.
 *
 * A total table over the closed vocabulary rather than a `!== "calm"` test: a
 * fourth level added to the seat's enumeration must not silently inherit either
 * answer, and this is the one place the sidebar decides what "needs a look"
 * means.
 */
const OPENS_SECTION_BY_ATTENTION: Readonly<Record<SidebarSectionAttention, boolean>> = {
  red: true,
  amber: true,
  calm: false,
};

/** The whole of what the sidebar renders from. Replaced, never mutated in place. */
export interface SidebarSnapshot {
  /** The ids the person has shut. Inverted, so an unknown id reads as open. */
  readonly collapsedSectionIds: ReadonlySet<SidebarSectionId>;
  /** Where the DOM-free cursor is. Always a member of the declared set. */
  readonly cursorSectionId: SidebarSectionId;
  /** The filter field's text, verbatim. Empty means no filter is on. */
  readonly filterQuery: string;
  /** The sidebar's width in CSS pixels, already clamped to the bounds. */
  readonly widthPx: number;
  /** What each section last reported. Absent means it has never reported. */
  readonly attentionBySectionId: ReadonlyMap<SidebarSectionId, SidebarSectionAttention>;
  /** True once the durable read has settled, either way. */
  readonly isRestored: boolean;
  /** The last durable write the store refused, or `undefined`. Rendered, never swallowed. */
  readonly persistenceRefusal: ConsoleRefusal | undefined;
}

export interface SidebarModelOptions {
  /**
   * The persistence chokepoint, or `undefined` for a sidebar with no durable
   * home.
   *
   * `undefined` is a real configuration rather than a test affordance: an
   * auxiliary window renders a sidebar and I-023-12 gives it no shared store, and
   * a model that demanded one would either force a second database open or
   * tempt a caller into reaching around the chokepoint.
   */
  readonly uiStateStore?: UiStateStore;
  /** The session partition the collapsed set is written under. */
  readonly sessionId: string;
}

export class SidebarModel {
  readonly #emitter = new Emitter<SidebarSnapshot>("sidebar model");
  readonly #uiStateStore: UiStateStore | undefined;
  readonly #sessionId: string;
  /** Sections the person has opened or shut themselves, so attention stops deciding. */
  readonly #personallySetSectionIds = new Set<SidebarSectionId>();
  /**
   * Sections whose state has been decided since construction, by anybody.
   *
   * Wider than `#personallySetSectionIds` on purpose: the auto-open rule is a
   * decision too, and a restore that shut a section attention had just opened
   * would leave it shut, because a section reporting the same level twice moves
   * nothing. This set is what decision 4 re-imposes over the durable read.
   */
  readonly #decidedSectionIds = new Set<SidebarSectionId>();
  /** Whether the width has been set since construction. Decision 4, width axis. */
  #widthWasDecided = false;
  #snapshot: SidebarSnapshot;

  public constructor(options: SidebarModelOptions) {
    this.#uiStateStore = options.uiStateStore;
    this.#sessionId = options.sessionId;
    this.#snapshot = {
      // Everything shut until the durable read answers. The alternative — open
      // until proven collapsed — flashes the whole tree open on every load and
      // then shuts it, which reads as a bug rather than as a restore.
      collapsedSectionIds: new Set(SIDEBAR_SECTION_IDS),
      cursorSectionId: SIDEBAR_SECTION_IDS[0],
      filterQuery: "",
      widthPx: SIDEBAR_DEFAULT_WIDTH_PX,
      attentionBySectionId: new Map(),
      isRestored: this.#uiStateStore === undefined,
      persistenceRefusal: undefined,
    };
  }

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
   * collapsed set — decision 2 in this file's header. A person filtering sees
   * every section that could hold a match; clearing the field puts the sidebar
   * back exactly as they left it, with no bookkeeping to get wrong.
   */
  public isSectionOpen(id: SidebarSectionId): boolean {
    return this.#snapshot.filterQuery !== "" || !this.#snapshot.collapsedSectionIds.has(id);
  }

  /** Read the durable shape. Never throws; a store that cannot answer leaves the defaults. */
  public async restore(): Promise<void> {
    const store = this.#uiStateStore;
    if (store === undefined) {
      return;
    }
    const [collapsedRecord, widthRecord] = await Promise.all([
      store.read(this.#sessionId, SIDEBAR_COLLAPSED_SECTIONS_KEY),
      store.readGlobal(SIDEBAR_WIDTH_KEY),
    ]);
    // Decision 4: what was decided while the read was in flight outranks the
    // read. The restored set is the base and the decisions are re-imposed over
    // it, rather than the other way round, so a section nobody has touched still
    // comes back the way it was left.
    const collapsedSectionIds = new Set(
      // Nothing readable on disk means the default this class starts at, not an
      // empty set: an empty set is "the person shut nothing", which would open
      // every section on a machine that has never seen this session.
      decodeCollapsedSectionIds(collapsedRecord?.value) ?? SIDEBAR_SECTION_IDS,
    );
    for (const id of this.#decidedSectionIds) {
      if (this.#snapshot.collapsedSectionIds.has(id)) {
        collapsedSectionIds.add(id);
      } else {
        collapsedSectionIds.delete(id);
      }
    }
    this.#publish({
      collapsedSectionIds,
      widthPx: this.#widthWasDecided
        ? this.#snapshot.widthPx
        : clampWidth(decodeSidebarWidth(widthRecord?.value) ?? SIDEBAR_DEFAULT_WIDTH_PX),
      isRestored: true,
    });
  }

  /** Open a shut section or shut an open one. The person's own act, so it sticks. */
  public toggleSection(id: SidebarSectionId): void {
    this.setSectionCollapsed(id, this.#snapshot.collapsedSectionIds.has(id) === false);
  }

  /**
   * Set one section's collapse state.
   *
   * Records that a person decided it, which is what stops a section that keeps
   * reporting amber from re-opening itself over their shoulder.
   */
  public setSectionCollapsed(id: SidebarSectionId, isCollapsed: boolean): void {
    this.#personallySetSectionIds.add(id);
    // Recorded here rather than only on a real change, for `setWidth`'s reason:
    // asking for the state a section is already in is still a decision, and
    // decision 4 must not let the durable read move it afterwards.
    this.#decidedSectionIds.add(id);
    this.#applyCollapse(id, isCollapsed);
  }

  /**
   * Take a section's own reading of how loudly it is asking to be looked at.
   *
   * Opens the section on amber or red exactly once, and only while the person has
   * not decided that section themselves. Idempotent: the same level twice moves
   * nothing, which is what lets a section call this from an effect on every read.
   */
  public reportAttention(id: SidebarSectionId, attention: SidebarSectionAttention): void {
    if (this.#snapshot.attentionBySectionId.get(id) === attention) {
      return;
    }
    const attentionBySectionId = new Map(this.#snapshot.attentionBySectionId);
    attentionBySectionId.set(id, attention);
    this.#publish({ attentionBySectionId });
    if (OPENS_SECTION_BY_ATTENTION[attention] && !this.#personallySetSectionIds.has(id)) {
      this.#applyCollapse(id, false);
    }
  }

  /** What a section last reported, or `calm` while it has never reported. */
  public attentionFor(id: SidebarSectionId): SidebarSectionAttention {
    return this.#snapshot.attentionBySectionId.get(id) ?? "calm";
  }

  /** Move the cursor by whole sections, stopping at the ends rather than wrapping. */
  public moveCursor(offset: number): void {
    const position = SIDEBAR_SECTION_IDS.indexOf(this.#snapshot.cursorSectionId);
    const next = SIDEBAR_SECTION_IDS[clamp(position + offset, 0, SIDEBAR_SECTION_IDS.length - 1)];
    if (next !== undefined) {
      this.setCursor(next);
    }
  }

  public setCursor(id: SidebarSectionId): void {
    if (this.#snapshot.cursorSectionId !== id) {
      this.#publish({ cursorSectionId: id });
    }
  }

  /** The filter text, verbatim. Never persisted — it is what a person typed. */
  public setFilterQuery(filterQuery: string): void {
    if (this.#snapshot.filterQuery !== filterQuery) {
      this.#publish({ filterQuery });
    }
  }

  /** Resize, clamped to the bounds and written to the window-wide partition. */
  public setWidth(widthPx: number): void {
    // Recorded before the no-op check: asking for the width it already has is
    // still a decision, and a restore that then moved it would be moving a width
    // somebody chose.
    this.#widthWasDecided = true;
    const clamped = clampWidth(Math.round(widthPx));
    if (this.#snapshot.widthPx === clamped) {
      return;
    }
    this.#publish({ widthPx: clamped });
    this.#writeGlobal(SIDEBAR_WIDTH_KEY, "layout", encodeSidebarWidth(clamped));
  }

  #applyCollapse(id: SidebarSectionId, isCollapsed: boolean): void {
    const collapsedSectionIds = new Set(this.#snapshot.collapsedSectionIds);
    if (isCollapsed) {
      collapsedSectionIds.add(id);
    } else {
      collapsedSectionIds.delete(id);
    }
    if (collapsedSectionIds.size === this.#snapshot.collapsedSectionIds.size) {
      return;
    }
    this.#decidedSectionIds.add(id);
    this.#publish({ collapsedSectionIds });
    this.#write(
      SIDEBAR_COLLAPSED_SECTIONS_KEY,
      "expansion",
      encodeCollapsedSectionIds(collapsedSectionIds),
    );
  }

  #write(key: string, valueClass: "expansion", value: readonly string[]): void {
    const store = this.#uiStateStore;
    if (store === undefined) {
      return;
    }
    this.#settleWrite(store.write(this.#sessionId, key, valueClass, value));
  }

  #writeGlobal(key: string, valueClass: "layout", value: SidebarLayoutValue): void {
    const store = this.#uiStateStore;
    if (store === undefined) {
      return;
    }
    this.#settleWrite(store.writeGlobal(key, valueClass, value));
  }

  /**
   * Hold whatever the write settled as, without making the caller wait.
   *
   * `write` returns its refusal as a value and rejects only on a defect, so both
   * arms are handled: a refusal is kept and rendered, and a rejection becomes a
   * refusal-shaped record rather than an unhandled promise. A model that only
   * caught one of the two would go quiet on the other.
   */
  #settleWrite(pending: Promise<SidebarWriteResult>): void {
    void pending.then(
      (result) => {
        if (result.outcome === "refused") {
          this.#publish({ persistenceRefusal: result.refusal });
        }
      },
      (failure: unknown) => {
        this.#publish({
          persistenceRefusal: refuse(
            SIDEBAR_REFUSAL_ORIGIN,
            // `satisfies` rather than a bare literal: this is the module's one
            // refusal site, so without it the closed vocabulary above binds
            // nothing and dropping a member from it would break no code.
            "persistence-write-failed" satisfies (typeof SIDEBAR_REFUSAL_CODES)[number],
            failure instanceof Error
              ? failure.message
              : "the durable store failed without saying why",
          ),
        });
      },
    );
  }

  #publish(change: Partial<SidebarSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...change };
    this.#emitter.emit(this.#snapshot);
  }
}

function clamp(value: number, lowest: number, highest: number): number {
  return Math.min(Math.max(value, lowest), highest);
}

/** The sidebar's own bound, applied wherever a width enters — a resize or a restore. */
function clampWidth(widthPx: number): number {
  return clamp(widthPx, SIDEBAR_MIN_WIDTH_PX, SIDEBAR_MAX_WIDTH_PX);
}
