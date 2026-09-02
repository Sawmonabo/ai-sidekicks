// The session sidebar's sections, and the seat each one is filled through.
//
// `Spec-023 §Console Design (Meridian)` §The surface set: "The session sidebar
// shows the session's other work as independently loaded sections — goal,
// channels, runs, agents, repos and worktrees, approvals, artifacts, members —
// each a composition of its own read, opening panes; a section carrying an amber
// or red item is open and every other section is collapsed."
//
// FOUR FAMILIES FILL THIS ONE SIDEBAR
//
// The sidebar itself is the composer family's (T-023p-1C-3), and it renders
// sections it does not own: repos and artifacts are the repos family's
// (T-023p-1C-5), channels, agents, and members the collaboration family's
// (T-023p-1C-4), and runs its own. Without a seat those four branches would each
// have to edit the sidebar component, which is one file and therefore three
// conflicts.
//
// WHY THE SECTION IDS ARE A SMALLER SET THAN THE SPEC'S SENTENCE
//
// The spec's list names eight things; this set has six. `goal` and `approvals`
// are not sections with owners in Phase 1C — the goal is session chrome the
// workspace renders above the sections, and approvals reach the person through
// the approvals PANE and the frame's banner rather than through a sidebar
// section. A section id minted for a body no task will register would be a seat
// that can never be filled and a hole the sidebar would have to explain. When
// either grows an owner it joins this tuple in that owner's PR.

import { KeyedRegistry } from "../../core/index.js";
import { type ConsoleBridge } from "../../bridge/index.js";
import { type SessionStore } from "../../store/index.js";
import { type ConsolePaneOpener } from "./pane-registry.js";

/**
 * Every sidebar section, in render order.
 *
 * The order IS the sidebar's order, so this tuple is what a person sees. The
 * tuple is the declaration and the union is derived from it, for the reason
 * `pane-kinds.ts` gives about its own set.
 */
export const SIDEBAR_SECTION_IDS = [
  "channels",
  "agents",
  "runs",
  "repos",
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
}

// Consumed by T-023p-1C-3, T-023p-1C-4, T-023p-1C-5
export interface SidebarSectionDescriptor {
  readonly id: SidebarSectionId;
  /** The task or family that owns it, so an unfilled section names someone. */
  readonly owner: string;
  readonly render: (context: SidebarSectionContext) => React.ReactNode;
}

// Consumed by T-023p-1C-3
export class SidebarSectionRegistry {
  // `"owner-scoped"`, for `frame/surface-registry.ts`'s reason: a hot reload
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

/** The process-wide registry the four contributing families call at module scope. */
export const sidebarSectionRegistry: SidebarSectionRegistry = new SidebarSectionRegistry();

// Consumed by T-023p-1C-3, T-023p-1C-4, T-023p-1C-5
/** The call a family makes to fill one sidebar section. */
export function registerSidebarSection(descriptor: SidebarSectionDescriptor): void {
  sidebarSectionRegistry.register(descriptor);
}

/** One section's body, or `undefined` while nobody has filled it. */
export function sidebarSectionRenderer(
  id: SidebarSectionId,
): ((context: SidebarSectionContext) => React.ReactNode) | undefined {
  return sidebarSectionRegistry.descriptorFor(id)?.render;
}
