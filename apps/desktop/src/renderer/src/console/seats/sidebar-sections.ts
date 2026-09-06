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

import { KeyedRegistry } from "../core/index.js";
import { type ConsoleBridge } from "../bridge/index.js";
import { type SessionStore } from "../store/index.js";
import { type ConsolePaneOpener } from "./pane-registry.js";

// Consumed by T-023p-1C-3
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
 * `pane-kinds.ts` gives about its own set.
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

// Consumed by T-023p-1C-3, T-023p-1C-4, T-023p-1C-5
/** One sidebar section. Derived from the enumeration, never restated. */
export type SidebarSectionId = (typeof SIDEBAR_SECTION_IDS)[number];

/**
 * How loudly a section is asking to be looked at, as the section's own read
 * answers it.
 *
 * The vocabulary is the attention palette's, not a severity scale of its own:
 * `Spec-023 §The surface set` says "a section carrying an amber or red item is
 * open and every other section is collapsed", and Meridian has exactly two
 * attention marks. `calm` is the third member because "nothing needs a look"
 * has to be sayable — a section that could only report amber or red could never
 * take back an earlier report.
 */
export const SIDEBAR_SECTION_ATTENTIONS = ["red", "amber", "calm"] as const;

/** One attention level. Derived from the enumeration, never restated. */
export type SidebarSectionAttention = (typeof SIDEBAR_SECTION_ATTENTIONS)[number];

// Consumed by T-023p-1C-3, T-023p-1C-4, T-023p-1C-5
/** Everything a section body is handed. */
export interface SidebarSectionContext {
  readonly sessionStore: SessionStore;
  readonly bridge: ConsoleBridge;
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
   * Tell the sidebar how loudly this section is asking to be looked at.
   *
   * The split is deliberate and is the same one `isOpen` names: the section owns
   * the DATUM, because the rollup is a property of the section's own read, and
   * the sidebar owns the STATE, because "a section carrying an amber or red item
   * is open, every other section is collapsed" is a rule over the whole set.
   * Without this the rule is unreachable — nothing else in the sidebar can see
   * inside a section's read.
   *
   * Call it from an effect rather than during a render: it moves the sidebar's
   * state, and a section that reported while rendering would be writing to its
   * parent mid-pass. Reporting the same level twice is free — the sidebar
   * compares before it moves anything.
   *
   * Additive-optional for `filterQuery`'s reason; a section that never calls it
   * is `calm`, which is the fail-closed answer.
   */
  readonly reportAttention?: (attention: SidebarSectionAttention) => void;
}

// Consumed by T-023p-1C-3, T-023p-1C-4, T-023p-1C-5
export interface SidebarSectionDescriptor {
  readonly id: SidebarSectionId;
  /** The task or family that owns it, so an unfilled section names someone. */
  readonly owner: string;
  readonly render: (context: SidebarSectionContext) => React.ReactNode;
}

export class SidebarSectionRegistry {
  // `"owner-scoped"`, for `surface-registry.ts`'s reason: a hot reload
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
