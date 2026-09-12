// The session sidebar's sections, and the seat each one is filled through.
//
// `Spec-023 §Console Design (Meridian)` §The surface set: "The session sidebar
// shows the session's other work as independently loaded sections — goal,
// channels, runs, agents, repos and worktrees, approvals, artifacts, members —
// each a composition of its own read, opening panes; a section carrying an amber
// or red item is open and every other section is collapsed."
//
// THREE FAMILIES FILL THIS ONE SIDEBAR
//
// The sidebar itself is the composer family's (T-023p-1C-3), and it renders
// sections it does not own: repos and artifacts are the repos family's
// (T-023p-1C-5), channels, agents, and members the collaboration family's
// (T-023p-1C-4), and goal, runs, and approvals its own. Without a seat those
// branches would each have to edit the sidebar component, which is one file and
// therefore a conflict per branch.
//
// THE SET IS THE SPEC'S SET, IN THE SPEC'S ORDER
//
// All eight, including `goal` and `approvals`. This tuple drives
// `SidebarSectionId`, registration, and render order, so a section missing from it
// cannot be registered at all: a conforming sidebar could not be built against a
// substrate that has no seat for two sections the spec requires, and the family
// that owns them would have to reopen this shared contract to add them — or route
// them somewhere the spec did not put them.
//
// An approvals PANE and the frame's approval banner are not substitutes for the
// section and never were: the pane is a whole surface a person navigates to and the
// banner is room-wide attention, while the section is the sidebar's own
// independently loaded read of what this session is waiting on.

import { KeyedRegistry, type ConsoleRefusal } from "../../core/index.js";
import { type ConsoleBridge } from "../../bridge/index.js";
import { type FrameStore, type SessionStore } from "../../store/index.js";
import { type ConsolePaneAddress, type ConsolePaneOpener } from "../pane/index.js";

/**
 * Every sidebar section, in render order.
 *
 * The order IS the sidebar's order, so this tuple is what a person sees — and it
 * is `Spec-023 §Console Design (Meridian)` §The surface set's own order, quoted in
 * this module's header and compared to the transcription in `sidebar-sections.test.ts`
 * by an ordered comparison. `repos` is the spec's "repos and worktrees": one
 * section, and the id names the entity kind its cards open panes for.
 *
 * The tuple is the declaration and the union is derived from it, for the reason
 * `seats/pane/pane-kinds.ts` gives about its own set.
 */
export const SIDEBAR_SECTION_IDS = [
  "goal",
  "channels",
  "runs",
  "agents",
  "repos",
  "approvals",
  "artifacts",
  "members",
] as const;

/** One sidebar section. Derived from the enumeration, never restated. */
export type SidebarSectionId = (typeof SIDEBAR_SECTION_IDS)[number];

/** Everything a section body is handed. */
export interface SidebarSectionContext {
  readonly sessionStore: SessionStore;
  readonly bridge: ConsoleBridge;
  /**
   * This window's own store, for the one question a section cannot answer from the
   * session's: whether a mutating call can leave the machine at all.
   *
   * `store/shell/shell-state.ts` says why the value lives where it does — "a view family
   * reads it to disable a control it is about to offer" — and this is the seat that
   * makes that reachable from a section, which holds a SESSION store and a bridge and
   * neither of those knows the supervisor's condition. Handed down rather than
   * imported, for `openPane`'s reason: a sidebar rendered in an auxiliary window
   * reports THAT window's shell.
   *
   * Required rather than additive-optional, unlike the two members below it. Those two
   * narrow what a section renders and a section ignoring them simply does less; this
   * one decides whether a control is offered, and a section handed no signal would
   * either fail closed — disabling every mutation in a console that works — or fail
   * open, which is the state this member was added to stop being the only option.
   */
  readonly frameStore: FrameStore;
  /**
   * How a section's cards open panes — "each a composition of its own read,
   * opening panes". Handed down rather than imported so a sidebar rendered in an
   * auxiliary window opens panes in THAT window's deck.
   */
  readonly openPane: ConsolePaneOpener;
  /**
   * Whether the sidebar has this section open.
   *
   * The sidebar decides it, not the section: the rule is a property of the whole
   * sidebar ("a section carrying an amber or red item is open and every other
   * section is collapsed"), so a section that decided its own state would be a
   * second source of truth for a rule stated over the set.
   */
  readonly isOpen: boolean;
  /**
   * What the sidebar's filter field currently holds, verbatim.
   *
   * The field is the SIDEBAR's — one filter above the whole tree, owned by
   * `workspace/sidebar/Sidebar.tsx` — and the matching is each SECTION's, because
   * only the section knows what its own rows are called and what a match over them
   * means; the composer family's own reading of it is in
   * `workspace/sidebar/sections/RunsSection.tsx`. Empty means no filter is on; a
   * section that ignores this member simply does not narrow.
   *
   * Additive-optional so a section authored before this seam existed still
   * compiles. The sidebar always supplies it.
   */
  readonly filterQuery?: string;
  /**
   * The column's shared bulk selection, as the narrow face a row drives it through.
   *
   * The SELECTION is the sidebar's because a bulk act crosses sections; the ROWS are
   * each section's because only the section knows which of its items admit an act at
   * all. A section with no bulk-eligible rows never reads this member.
   *
   * Additive-optional so a section authored before this seam existed still compiles.
   * The sidebar always supplies it.
   */
  readonly bulk?: SidebarBulkSelection;
  /**
   * How a row of this section becomes draggable onto the deck.
   *
   * Additive-optional beside {@link bulk} and for the same reason. A section whose
   * rows open nothing never reads it; a section that does gets the column's one
   * gesture rather than binding a second drag library of its own.
   */
  readonly dragRow?: SidebarRowDragBinder;
}

export interface SidebarSectionDescriptor {
  readonly id: SidebarSectionId;
  /** The task or family that owns it, so an unfilled section names someone. */
  readonly owner: string;
  readonly render: (context: SidebarSectionContext) => React.ReactNode;
  /**
   * What this section is calling for, or nothing.
   *
   * The spec's stronger rule — "a section carrying an amber or red item is open
   * and every other section is collapsed" — is stated over the whole SET, so the
   * sidebar has to decide it. But only the family that owns a section can say
   * whether its items are calling for anybody: the projection is that family's, and
   * a sidebar that re-derived it would be a second source of truth for it. So the
   * family REPORTS a fact and the sidebar makes the decision, which is the same
   * split `isOpen` above is written under and the reason this is a reader rather
   * than a stored flag.
   *
   * The two values are the two hues rule 3 spends on urgency — amber for "a person
   * is needed", red for "something failed" — and nothing else. `neutral` and
   * `accent` are absent on purpose: a section that carries neither returns
   * `undefined`, and offering a tone that means "no attention" would let a family
   * report attention by reporting its absence.
   *
   * The context is the section's own minus the two members the sidebar decides:
   * `isOpen` is what this answer helps settle, so a reader that could see it would
   * be reading its own output, and `openPane` is an act rather than a fact. Derived
   * by subtraction rather than declared again, so a member added above is carried
   * here with nothing to keep in step.
   *
   * OPTIONAL, AND CHEAP. It is called during the sidebar's render, over state the
   * family already holds — never a read, never a subscription. A section that has
   * no projection to answer from omits it, which is not the same claim as reporting
   * no attention and is why the member is optional rather than defaulted.
   */
  readonly attention?: (
    context: Omit<SidebarSectionContext, "isOpen" | "openPane">,
  ) => "attention" | "failure" | undefined;
  /**
   * This section's items as a tree, for the column to fold.
   *
   * The design track asks for "rollup status per section: child-to-parent over the
   * session › channel › run tree; grouping pinned, needs-attention, running, then
   * the rest". The TREE is the family's — only it knows what its rows are and how
   * they nest — and the FOLD is the column's, because what the fold decides is the
   * open-or-collapsed rule stated over the whole set.
   *
   * A section that supplies one need not also supply {@link attention}: the column
   * folds the tree's own levels child-to-parent and reaches the same answer from the
   * same facts. A section that supplies both is answering one question twice, so the
   * column takes `attention` as the section's explicit claim and the fold as its
   * fallback rather than merging them.
   *
   * Read on the same terms as {@link attention}: during the column's render, over
   * state the family already holds, never a read and never a subscription.
   */
  readonly rollup?: (
    context: Omit<SidebarSectionContext, "isOpen" | "openPane">,
  ) => readonly SidebarRollupNode[];
}

export class SidebarSectionRegistry {
  // `"owner-scoped"`, for `seats/surface/surface-registry.ts`'s reason: a hot reload
  // re-runs the owning family's module and must replace, while two owners on one
  // section is a conflict rather than a swap decided by import order.
  readonly #descriptorsById = new KeyedRegistry<SidebarSectionId, SidebarSectionDescriptor>({
    duplicatePolicy: "owner-scoped",
    describeWhat: "sidebar section",
    ownerOf: (descriptor) => descriptor.owner,
    duplicateHint: "the sidebar renders one body per section, in declaration order",
  });

  /** Claim a section. A second claim by a different owner is an error, not a swap. */
  public register(descriptor: SidebarSectionDescriptor): void {
    this.#descriptorsById.register(descriptor.id, descriptor);
  }

  public unregister(id: SidebarSectionId): void {
    this.#descriptorsById.unregister(id);
  }

  public descriptorFor(id: SidebarSectionId): SidebarSectionDescriptor | undefined {
    return this.#descriptorsById.get(id);
  }

  /** Which sections have a body, in declaration order — which is render order. */
  public registeredSectionIds(): readonly SidebarSectionId[] {
    return SIDEBAR_SECTION_IDS.filter((id) => this.#descriptorsById.has(id));
  }
}

/** The process-wide registry the three contributing families call at module scope. */
export const sidebarSectionRegistry: SidebarSectionRegistry = new SidebarSectionRegistry();

// Consumed by T-023p-1C-3
/** One section's body, or `undefined` while nobody has filled it. */
export function sidebarSectionRenderer(
  id: SidebarSectionId,
): ((context: SidebarSectionContext) => React.ReactNode) | undefined {
  return sidebarSectionRegistry.descriptorFor(id)?.render;
}

// --------------------------------------------------------------------------
// The rollup tree, and the bulk-selection seam.
// --------------------------------------------------------------------------
//
// `Spec-023 §Console Design (Meridian)` puts two more things on this seat, and both
// are the same split as `attention` above: the family REPORTS and the sidebar
// DECIDES.
//
//   • The rollup. The section's items as a session › channel › run tree, grouped.
//     One attention value per section cannot express "which of my children is
//     calling", so a section that carries a tree reports the tree and the column
//     folds it child-to-parent. The fold is the sidebar's because the rule it
//     serves — "a section carrying an amber or red item is open and every other
//     section is collapsed" — is stated over the whole set.
//   • Bulk selection. A bulk act crosses sections (three queued items here, two
//     invites there), so the selection cannot live inside one section's body. The
//     column owns it and hands each section a narrow face: is this row selected,
//     toggle it, and what did its own reply say. A section that never calls it is
//     a section with no bulk-eligible rows, which is not an error.

/**
 * How a rollup's items group, in the order a person reads them.
 *
 * The design track's own order and its own four groups. Declared as a tuple so the
 * union is derived from it and the render order is the declaration — the same shape
 * `SIDEBAR_SECTION_IDS` takes, for the same reason.
 */
export const SIDEBAR_ROLLUP_GROUPS = ["pinned", "needs-attention", "running", "rest"] as const;

/** One rollup group. Derived from the enumeration, never restated. */
export type SidebarRollupGroup = (typeof SIDEBAR_ROLLUP_GROUPS)[number];

/**
 * One node of a section's rollup — a session, a channel, a run, or a leaf entity.
 *
 * `attention` is this node's OWN reading and never its children's: the fold walks
 * child-to-parent, so a parent that restated a child's level would be a second
 * source of truth for the same fact and the two would disagree the moment a child
 * settled. A node that carries nothing itself omits it.
 *
 * `opens` is what a press or a drop of this node opens. Absent means the node is
 * structure — a channel that groups runs and is not itself a pane — and both the
 * press and the drop decline rather than opening something else.
 */
export interface SidebarRollupNode {
  /** Unique within its section. The selection and the drag both key on it. */
  readonly nodeId: string;
  /** What a person reads on the row, and what a bulk confirm names it by. */
  readonly label: string;
  readonly group: SidebarRollupGroup;
  readonly attention?: "attention" | "failure";
  readonly opens?: ConsolePaneAddress;
  readonly children?: readonly SidebarRollupNode[];
}

/**
 * One row a person can drag onto the deck.
 *
 * Declared on the seat rather than in the column, because the SECTION is what binds
 * its own row elements and a contract a view family writes against cannot live above
 * it. What the column owns is the binding itself — the library, the payload key, and
 * what a settled drop does.
 */
export interface SidebarRowDragTarget {
  /** Unique within the column while the row is on screen. Keys the bound source. */
  readonly nodeId: string;
  /** What a person reads on the row — what the drop announcement names it by. */
  readonly label: string;
  /** What the drop opens. A row that opens nothing is not a drag target at all. */
  readonly opens: ConsolePaneAddress;
}

/**
 * How a section makes one of its rows draggable.
 *
 * Answers the ref callback the row hands its element to. The callback is STABLE for a
 * row id, so a section may call this during render without rebinding the gesture on
 * every pass — the column's own cache is what makes that true, and it is why this is a
 * binder handed down rather than a hook a section would call.
 */
export type SidebarRowDragBinder = (
  target: SidebarRowDragTarget,
) => (element: HTMLElement | null) => void;

/**
 * Which acts a bulk selection can carry, and what each one is.
 *
 * Closed, and closed at the two the design track names: cancel several queued
 * items, retire several worktrees. Both are destructive, which is why there is no
 * `isDestructive` member — a boolean that is `true` on every row is a member nothing
 * reads.
 */
export const SIDEBAR_BULK_ACTS = ["cancel-queue-item", "retire-worktree"] as const;

/** One bulk act. Derived from the enumeration, never restated. */
export type SidebarBulkAct = (typeof SIDEBAR_BULK_ACTS)[number];

/**
 * One row a bulk act can be run against.
 *
 * The ENTITY id and never a request: the act's own table below the sidebar knows
 * which method carries which member, and a seat that shaped a request would put a
 * wire shape on a contract the view families write against.
 */
export interface SidebarBulkItem {
  readonly sectionId: SidebarSectionId;
  readonly act: SidebarBulkAct;
  /** The entity id the act's request carries. Held as a string; widened at the door. */
  readonly itemId: string;
  /** What the destructive preview names this row by. */
  readonly label: string;
}

/** What one selected row's act settled as, or that it is still in flight. */
export type SidebarBulkOutcome =
  | { readonly state: "running" }
  | { readonly state: "done" }
  | { readonly state: "refused"; readonly refusal: ConsoleRefusal };

/**
 * The face a section row drives the shared selection through.
 *
 * Narrow on purpose. A section may ask whether one of its rows is selected, put a
 * row in or out, and read what that row's own reply said — and it may not enumerate
 * the selection, clear it, or run anything. Running is the column's: the confirm
 * names every item across every section, and a section that could run would be
 * running a set it cannot see.
 */
export interface SidebarBulkSelection {
  readonly isSelected: (item: SidebarBulkItem) => boolean;
  readonly toggle: (item: SidebarBulkItem) => void;
  /** What this row's own act settled as, or `undefined` while it has not been run. */
  readonly outcomeFor: (item: SidebarBulkItem) => SidebarBulkOutcome | undefined;
}
