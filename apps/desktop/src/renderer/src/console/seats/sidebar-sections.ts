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

// Consumed by T-023p-1C-4, T-023p-1C-5
/** One sidebar section. Derived from the enumeration, never restated. */
export type SidebarSectionId = (typeof SIDEBAR_SECTION_IDS)[number];

// Consumed by T-023p-1C-4, T-023p-1C-5
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

// Consumed by T-023p-1C-4, T-023p-1C-5
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
}

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

/** The process-wide registry the three contributing families call at module scope. */
export const sidebarSectionRegistry: SidebarSectionRegistry = new SidebarSectionRegistry();

// Consumed by T-023p-1C-3, T-023p-1C-4, T-023p-1C-5
/** The call a family makes to fill one sidebar section. */
export function registerSidebarSection(descriptor: SidebarSectionDescriptor): void {
  sidebarSectionRegistry.register(descriptor);
}

// Consumed by T-023p-1C-3
/** One section's body, or `undefined` while nobody has filled it. */
export function sidebarSectionRenderer(
  id: SidebarSectionId,
): ((context: SidebarSectionContext) => React.ReactNode) | undefined {
  return sidebarSectionRegistry.descriptorFor(id)?.render;
}
