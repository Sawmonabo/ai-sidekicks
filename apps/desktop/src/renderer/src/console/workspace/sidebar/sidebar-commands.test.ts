// What the palette offers for the sidebar, and what a press reaches when none is
// mounted.
//
// The refusal arm is the half that fails silently: a chord pressed from a window with
// no sidebar has nothing to act on, and a command that quietly did nothing would be
// indistinguishable from one that ran.

import { describe, expect, it, vi, type Mock } from "vitest";

import type { ConsoleCommand, KeyBinding } from "../../palette/index.js";
import type {
  ConsoleCommandSurface,
  ConsoleFamilyCommandContribution,
} from "../../frame/command-surface.js";
import {
  MountedSidebarSeat,
  SIDEBAR_COMMAND_OWNER,
  SIDEBAR_NOT_MOUNTED_REFUSAL,
  registerSidebarCommands,
  sidebarCommands,
  type SidebarActs,
} from "./sidebar-commands.js";

/** A surface that records what a family contributed, rather than a window's registry. */
class RecordingCommandSurface implements ConsoleCommandSurface {
  contribution: ConsoleFamilyCommandContribution | undefined;

  public contribute(contribution: ConsoleFamilyCommandContribution): void {
    this.contribution = contribution;
  }
}

/** One sidebar's acts, each a spy, so a case can say which surface performed. */
interface SpyingSidebarActs extends SidebarActs {
  readonly focusSidebar: Mock<() => void>;
  readonly toggleSidebarCollapsed: Mock<() => void>;
}

function acts(): SpyingSidebarActs {
  return { focusSidebar: vi.fn<() => void>(), toggleSidebarCollapsed: vi.fn<() => void>() };
}

function commandById(commands: readonly ConsoleCommand[], id: string): ConsoleCommand {
  const command = commands.find((candidate) => candidate.id === id);
  expect(command).not.toBeUndefined();
  return command as ConsoleCommand;
}

describe("the sidebar's palette rows", () => {
  it("offers focus and collapse, both scoped to a window with a session", () => {
    const commands = sidebarCommands(acts());
    expect(commands.map((command) => command.id)).toStrictEqual([
      "workspace.focusSidebar",
      "workspace.toggleSidebar",
    ]);
    for (const command of commands) {
      expect(command.when).toBe("sessionActive");
    }
  });

  it("runs the act the row names", () => {
    const sidebarActs = acts();
    const commands = sidebarCommands(sidebarActs);
    commandById(commands, "workspace.focusSidebar").run();
    commandById(commands, "workspace.toggleSidebar").run();
    expect(sidebarActs.focusSidebar).toHaveBeenCalledTimes(1);
    expect(sidebarActs.toggleSidebarCollapsed).toHaveBeenCalledTimes(1);
  });

  it("claims no chord, so it takes none of the seven a person has learned", () => {
    const surface = new RecordingCommandSurface();
    registerSidebarCommands(surface, new MountedSidebarSeat());
    expect(surface.contribution?.owner).toBe(SIDEBAR_COMMAND_OWNER);
    expect(surface.contribution?.keyBindings).toStrictEqual([] as readonly KeyBinding[]);
  });
});

describe("which sidebar a command acts on", () => {
  it("performs on the newest mounted sidebar", () => {
    const seat = new MountedSidebarSeat();
    const first = acts();
    const second = acts();
    seat.adopt(first);
    seat.adopt(second);

    expect(seat.perform("focusSidebar")).toStrictEqual({
      status: "performed",
      act: "focusSidebar",
    });
    expect(second.focusSidebar).toHaveBeenCalledTimes(1);
    expect(first.focusSidebar).not.toHaveBeenCalled();
  });

  it("releases by identity, so an earlier unmount does not drop the newest", () => {
    const seat = new MountedSidebarSeat();
    const first = acts();
    const second = acts();
    const releaseFirst = seat.adopt(first);
    seat.adopt(second);
    releaseFirst();

    seat.perform("toggleSidebarCollapsed");
    expect(second.toggleSidebarCollapsed).toHaveBeenCalledTimes(1);
  });

  it("refuses rather than doing nothing when no sidebar is mounted", () => {
    const outcome = new MountedSidebarSeat().perform("focusSidebar");
    expect(outcome).toStrictEqual({ status: "refused", refusal: SIDEBAR_NOT_MOUNTED_REFUSAL });
  });

  it("negative control: a seat holding one sidebar performs rather than refusing", () => {
    // Without this the case above would pass over a seat that refused every press.
    const seat = new MountedSidebarSeat();
    seat.adopt(acts());
    expect(seat.perform("focusSidebar").status).toBe("performed");
  });
});
