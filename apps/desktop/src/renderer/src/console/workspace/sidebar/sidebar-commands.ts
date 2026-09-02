// What the session sidebar contributes to the palette, and how a press reaches it.
//
// The two acts are the ones a person cannot otherwise reach without a pointer: put
// the keyboard into the sidebar, and collapse or expand it. Both are contributed at
// COMPOSITION time so they are in the palette and its chord table from the first
// frame, and both resolve their target at PRESS time, because the sidebar comes and
// goes with the route while the command is built once per window.
//
// WHY THE SEAT, AND WHY IT IS THIS FAMILY'S OWN. `ledger/structure/mounted-ledger.ts`
// is the same shape for the same reason, and this is deliberately a copy of its
// SHAPE rather than a use of it: that holder carries the ledger's nine acts and is
// resolved by the ledger's own commands, both inside one family. The sidebar's acts
// and the sidebar's commands are likewise one family's, so nothing here crosses a
// family boundary and nothing here belongs in `seats/` — a seat exists for a contract
// two view families hand each other, and there is no second family in this story.
//
// WHY THE CONTRIBUTION IS NOT MADE FROM `ledger/index.ts`. That barrel is where the
// ledger contributes its own commands, and it is the console's only composition-time
// entry point that mounts this surface — but `ledger/` and `workspace/` are sibling
// VIEW families, and `console-view-family-isolation` in `.dependency-cruiser.mjs`
// fails an import between two of them outright. The contribution is therefore made
// from this family, at the module scope `Workspace.tsx` evaluates when the
// composition root imports it, which is the same moment.
//
// AN EMPTY SEAT IS A REFUSAL, NOT A SILENCE. `perform` answers with the refusal and
// the caller states it: a chord pressed from the settings page must say that this
// window has no sidebar rather than do nothing.

import { useEffect } from "react";

import { refuse, type ConsoleRefusal } from "../../core/index.js";
import { raiseConsoleActRefusal, type ConsoleCommandSurface } from "../../frame/command-surface.js";
import { type ConsoleCommand } from "../../palette/index.js";

/**
 * The acts a mounted sidebar offers. One function per command, named for the act
 * rather than for the control that triggers it.
 */
export interface SidebarActs {
  /** Put the keyboard on the sidebar's first section header. */
  readonly focusSidebar: () => void;
  readonly toggleSidebarCollapsed: () => void;
}

/** One act, by name. Every member is a niladic call, so the name is the whole request. */
export type SidebarActName = keyof SidebarActs;

/** What asking the seat to perform an act produced. */
export type SidebarActOutcome =
  | { readonly status: "performed"; readonly act: SidebarActName }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/**
 * What an act says when no sidebar is mounted.
 *
 * One value rather than one per act: a person pressing a sidebar chord from the
 * settings page needs to know the sidebar is not here, and naming which of the two
 * acts they reached for would answer a question they did not ask.
 */
export const SIDEBAR_NOT_MOUNTED_REFUSAL: ConsoleRefusal = refuse(
  "workspace",
  "workspace.no_mounted_sidebar",
  "No session sidebar is open in this window. Open a session and try again.",
);

/**
 * The mounted sidebars, in mount order.
 *
 * A class rather than a module-level array, and release is by IDENTITY rather than
 * by position: a StrictMode double mount and a route change must not leave the seat
 * holding a surface that is gone. The newest mount is the one a chord acts on.
 */
export class MountedSidebarSeat {
  readonly #mounted: SidebarActs[] = [];

  public adopt(acts: SidebarActs): () => void {
    this.#mounted.push(acts);
    return () => {
      const position = this.#mounted.lastIndexOf(acts);
      if (position >= 0) {
        this.#mounted.splice(position, 1);
      }
    };
  }

  public perform(act: SidebarActName): SidebarActOutcome {
    const newest = this.#mounted.at(-1);
    if (newest === undefined) {
      return { status: "refused", refusal: SIDEBAR_NOT_MOUNTED_REFUSAL };
    }
    newest[act]();
    return { status: "performed", act };
  }
}

/** This window's seat. Module scope is window scope: an auxiliary window is a process. */
export const mountedSidebar: MountedSidebarSeat = new MountedSidebarSeat();

/** Adopt the seat for as long as this sidebar is mounted. */
export function useMountedSidebar(
  acts: SidebarActs,
  seat: MountedSidebarSeat = mountedSidebar,
): void {
  useEffect(() => seat.adopt(acts), [acts, seat]);
}

/**
 * The palette group these rows sit under.
 *
 * One binding rather than a literal per command: the group is also a secondary match
 * field, so two spellings would split the surface's rows across two categories.
 */
export const SIDEBAR_COMMAND_GROUP = "Session";

/**
 * The `when` clause both commands carry.
 *
 * Fail-closed by construction: the palette answers `false` for a key the context does
 * not carry, so a window with no session offers neither of these rather than offering
 * acts with nothing to act on.
 */
const WHEN_SESSION_ACTIVE = "sessionActive";

/**
 * The owner string this contribution carries.
 *
 * The contribution door is owner-scoped, so composing twice — a hot reload, a second
 * test — replaces these rows instead of raising on their ids.
 */
export const SIDEBAR_COMMAND_OWNER = "workspace-sidebar";

/** Build the two commands, given the acts each one performs. */
export function sidebarCommands(acts: SidebarActs): readonly ConsoleCommand[] {
  return [
    {
      id: "workspace.focusSidebar",
      title: "Focus the session sidebar",
      group: SIDEBAR_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["sidebar", "sections", "keyboard"],
      run: acts.focusSidebar,
    },
    {
      id: "workspace.toggleSidebar",
      title: "Collapse or expand the session sidebar",
      group: SIDEBAR_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["sidebar", "collapse", "expand", "hide"],
      run: acts.toggleSidebarCollapsed,
    },
  ];
}

/**
 * Contribute the sidebar's commands to a window.
 *
 * No chord is claimed. The three the frame binds and the four the ledger binds are
 * the ones a person builds muscle memory for; a fifth and sixth on a surface reachable
 * by one Tab press would spend two chords on a keystroke that is already free.
 */
export function registerSidebarCommands(
  surface: ConsoleCommandSurface,
  seat: MountedSidebarSeat = mountedSidebar,
): void {
  surface.contribute({
    owner: SIDEBAR_COMMAND_OWNER,
    commands: sidebarCommands(actsOnTheMountedSidebar(seat)),
    keyBindings: [],
  });
}

/**
 * The act set every contributed command runs through.
 *
 * Written out rather than derived from a name list, so a THIRD act added to
 * `SidebarActs` fails to compile here instead of being contributed as a command that
 * reaches the mounted sidebar through nothing.
 */
function actsOnTheMountedSidebar(seat: MountedSidebarSeat): SidebarActs {
  return {
    focusSidebar: () => {
      performOnMountedSidebar(seat, "focusSidebar");
    },
    toggleSidebarCollapsed: () => {
      performOnMountedSidebar(seat, "toggleSidebarCollapsed");
    },
  };
}

/** Perform one act, and state the refusal where a person can see it. */
function performOnMountedSidebar(seat: MountedSidebarSeat, act: SidebarActName): void {
  const outcome = seat.perform(act);
  if (outcome.status === "refused") {
    raiseConsoleActRefusal(outcome.refusal);
  }
}
