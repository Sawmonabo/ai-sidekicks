// A row that cannot run says so BEFORE the press, and refuses in its owner's words.
//
// The registry's rule is that eligibility is never projected — a command whose daemon
// call may be refused is still offered, and the refusal renders when it comes back.
// This is the other case: a contributor that ALREADY KNOWS the act is closed, because
// the window's supervisor said so. Leaving that row indistinguishable from a live one
// makes a person press a control to be told what the console could have told them
// while they were reading it.
//
// LISTED, NOT WITHDRAWN. The row keeps its place and its accessible name and carries
// its owner's sentence, so "where did Pause go" has an answer on screen. Withdrawing it
// is what the `when` clause is for, and that says something different: the act does not
// exist in this scope, rather than exists and cannot be sent right now.
//
// THE SENTENCE IS THE CONTRIBUTOR'S. The latch's own refusal table has a line for each
// of its other two arms and deliberately none for this one — a static line here would
// replace a cause the console actually knows with one it invented — so the second case
// asserts the refusal carries the row's words rather than any of the palette's.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settle } from "../../core/settle.test-support.js";
import { CommandRegistry, type ConsoleCommand } from "../commands/index.js";
import { PaletteOverlay } from "./PaletteOverlay.js";
import type { WhenClauseContext } from "../when-clause/index.js";

const ON_WORKSPACE: WhenClauseContext = {
  sessionActive: true,
  onSessions: false,
  onWorkspace: true,
  onWorkflows: false,
  onSettings: false,
  inAuxiliaryWindow: false,
};

const COMMAND_ID = "test.pauseTheRun";
const COMMAND_TITLE = "Pause the run";

/** A contributor's own sentence, of the shape a shell block supplies. */
const CLOSED_SENTENCE =
  "The local runtime has been stopped, so run controls cannot be sent until it is running again.";

/** The row, offered here, closed or open depending on what its owner supplied. */
function pauseCommand(ran: string[], unavailable: string | undefined): ConsoleCommand {
  return {
    id: COMMAND_ID,
    title: COMMAND_TITLE,
    group: "Run",
    when: "onWorkspace",
    ...(unavailable === undefined ? {} : { unavailable }),
    run: () => {
      ran.push(COMMAND_ID);
    },
  };
}

function openPaletteOver(command: ConsoleCommand): void {
  const registry = new CommandRegistry();
  registry.register(command);
  render(
    <PaletteOverlay
      registry={registry}
      open
      onOpenChange={() => undefined}
      platform="darwin"
      context={ON_WORKSPACE}
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
  return document.querySelector(".console-palette__refusal")?.textContent ?? undefined;
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
    // Without this the two cases above would pass over a list that disabled every row
    // and a dispatch that refused unconditionally.
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
