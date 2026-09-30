// A row its owner has closed says so before the press and refuses in the owner's words. The
// registry never projects eligibility, but a contributor that already knows the act is closed (the
// supervisor said so) says so on the row. The row stays listed, unlike a `when` withdrawal, which
// means the act does not exist in this scope. The refusal carries the row's sentence, not the
// palette's.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settle } from "@test/helpers/settle.js";
import { CommandRegistry } from "@renderer/registries/commands/command-registry.js";
import { type CommandDefinition } from "@renderer/registries/commands/command-types.js";
import { CommandPalette } from "./CommandPalette.js";
import type { WhenClauseContext } from "@renderer/registries/commands/when-clause/when-clause.js";

const ON_SESSION: WhenClauseContext = {
  sessionActive: true,
  onSessions: false,
  onSession: true,
  onWorkflows: false,
  onSettings: false,
};

const COMMAND_ID = "test.pauseTheRun";
const COMMAND_TITLE = "Pause the run";

/** A contributor's own sentence, shaped like a runtime-stopped block's. */
const CLOSED_SENTENCE =
  "The local runtime has been stopped, so run controls cannot be sent until it is running again.";

/** The row, offered here, closed or open depending on what its owner supplied. */
function pauseCommand(ran: string[], unavailable: string | undefined): CommandDefinition {
  return {
    id: COMMAND_ID,
    title: COMMAND_TITLE,
    group: "Run",
    when: "onSession",
    ...(unavailable === undefined ? {} : { unavailable }),
    run: () => {
      ran.push(COMMAND_ID);
    },
  };
}

function openPaletteOver(command: CommandDefinition): void {
  const registry = new CommandRegistry();
  registry.register(command);
  render(
    <CommandPalette
      registry={registry}
      open
      onOpenChange={() => undefined}
      platform="darwin"
      context={ON_SESSION}
      scopeLabel="Session mercury"
    />,
  );
}

/** The one row the palette is offering. */
function theRow(): HTMLElement {
  return screen.getByRole("option", { name: new RegExp(COMMAND_TITLE, "u") });
}

/** The refusal the palette rendered inline, or `undefined` where it rendered none. */
function refusalText(): string | undefined {
  return document.querySelector(".command-palette__refusal")?.textContent ?? undefined;
}

describe("a palette row its owner has closed", () => {
  it("carries the owner's sentence and reads as disabled before anybody presses it", async () => {
    openPaletteOver(pauseCommand([], CLOSED_SENTENCE));
    await settle();

    expect(theRow().getAttribute("aria-disabled")).toBe("true");
    expect(theRow().textContent).toContain(CLOSED_SENTENCE);
  });

  it("runs nothing when pressed, and refuses in those same words", async () => {
    const ran: string[] = [];
    openPaletteOver(pauseCommand(ran, CLOSED_SENTENCE));
    await settle();

    fireEvent.click(theRow());
    await settle();

    expect(ran).toStrictEqual([]);
    expect(refusalText()).toContain(CLOSED_SENTENCE);
  });
});

describe("negative control: the same row with nothing closing it", () => {
  it("reads as enabled, carries no sentence, and runs on the press", async () => {
    // Without this, the cases above would pass over a list that disabled every row.
    const ran: string[] = [];
    openPaletteOver(pauseCommand(ran, undefined));
    await settle();

    expect(theRow().getAttribute("aria-disabled")).toBe("false");
    expect(theRow().textContent).not.toContain(CLOSED_SENTENCE);

    fireEvent.click(theRow());
    await settle();

    expect(ran).toStrictEqual([COMMAND_ID]);
    expect(refusalText()).toBeUndefined();
  });
});
