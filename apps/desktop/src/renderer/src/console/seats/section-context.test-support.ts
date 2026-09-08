// One sidebar-section context, for every suite in any family that mounts a section.
//
// The pane seat beside this one records what happens when a mount context has no
// home: the builders multiply, one per family, and then drift on the members nobody
// is looking at. A section context is the same role one seat lower — five members, a
// section body reaching every one of them on its first hook — and it had grown the
// same way, a copy per family with each family's own idea of which members a case
// has to state and which it may inherit.
//
// IT LIVES IN `seats/` for the pane seat's reason. `SidebarSectionContext` is
// declared in `seats/sidebar-sections.ts`, the sections that consume it are in VIEW
// families, and `console-view-family-isolation` forbids a sibling importing a
// sibling — so a builder for it belongs beside the type it builds and nowhere else.
//
// A FAMILY WRAPS THIS RATHER THAN REPLACING IT. What differs between families is
// which collaborators a case names and which it takes as read — the bridge a family
// mounts against, whether its sections open closed or open — and those are one-line
// wrappers over this, in the family that owns the answer. That is the shape
// `approvals/pane/approvals-pane.test-support.tsx` already takes over the pane seat.

import { type ConsoleBridge } from "../bridge/index.js";
import { type ConsolePaneOpener } from "./pane-address.js";
import { type SidebarSectionContext } from "./sidebar-sections.js";
import { FrameStore, type SessionStore } from "../store/index.js";

/** What a mounting suite decides, and what it may leave to this module. */
export interface SectionBindings {
  /**
   * Whether the sidebar has this section open.
   *
   * Required and carrying no default, because it is the one member a section's own
   * behaviour turns on: a collapsed section reads nothing and renders nothing, so a
   * builder that guessed here would decide the subject of half the cases using it.
   */
  readonly isOpen: boolean;
  /**
   * Both required, because a section body reaches both on its first hook: it
   * resolves its clock off the bridge and subscribes to the store. A default for
   * either would be a fixture this module chose for a case it cannot see, and a
   * context missing one throws before any assertion runs.
   */
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
  /**
   * The window's store, or a fresh one.
   *
   * A fresh store is born UNREPORTED and therefore blocks nothing, which is the
   * state a shipped window is in until the supervisor says otherwise — so a case
   * about ordinary rendering gets the shell out of its way, and a case about a write
   * closed by an outage hands in a store it has driven to that condition.
   *
   * `| undefined` spelled out beside the `?` for `pane-context.test-support.ts`'s
   * reason: under `exactOptionalPropertyTypes` a caller forwarding its own optional
   * member passes the property PRESENT and undefined, which the bare `?` rejects.
   */
  readonly frameStore?: FrameStore | undefined;
  /**
   * How this section opens panes, where a case OBSERVES it.
   *
   * Opening a pane is the deck's act, so most section cases have nothing to say
   * here; a case about a card's own way into a pane hands one in rather than
   * rebuilding the context around it.
   */
  readonly openPane?: ConsolePaneOpener | undefined;
}

/** The context a section body is mounted with. */
export function sectionContext(bindings: SectionBindings): SidebarSectionContext {
  return {
    isOpen: bindings.isOpen,
    bridge: bindings.bridge,
    sessionStore: bindings.sessionStore,
    frameStore: bindings.frameStore ?? new FrameStore(),
    openPane: bindings.openPane ?? (() => undefined),
  };
}
