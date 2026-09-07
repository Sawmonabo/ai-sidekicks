// The highlighted row warms what its command would open.
//
// The trigger is what needs a case, and it needs one here rather than in the frame:
// `command.preload` is declared on the contribution shape and called by exactly one
// caller, and that caller is a Base UI callback whose firing depends on the combobox's
// own highlight rules. A unit over `warmHighlighted` would assert a lookup against
// itself; what is in question is whether the highlight reaches it at all.
//
// AND THE MOMENT IS THE CLAIM, not merely the call. `autoHighlight` puts the highlight
// on the best match as a person types, which is what makes this the moment their intent
// is legible and the act has not happened — so the first case asserts the warm fired
// with the dialog still open and `run` never called.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settle } from "../core/settle.test-support.js";
import { CommandRegistry } from "./command-registry.js";
import { PaletteOverlay } from "./PaletteOverlay.js";
import { type ConsoleCommand } from "./contributions.js";
import { type WhenClauseContext } from "./when-clause.js";

/** Every clause key false: these commands carry no `when`, so nothing is filtered out. */
const CONTEXT: WhenClauseContext = {
  sessionActive: false,
  onSessions: false,
  onWorkspace: false,
  onWorkflows: false,
  onSettings: false,
  inAuxiliaryWindow: false,
};

/** What each command was asked to do, in the order it was asked. */
interface WarmLedger {
  readonly warmed: string[];
  readonly ran: string[];
}

function commandsUnder(ledger: WarmLedger): readonly ConsoleCommand[] {
  const declare = (id: string, title: string, withPreload: boolean): ConsoleCommand => ({
    id,
    title,
    group: "Navigate",
    run: () => {
      ledger.ran.push(id);
    },
    ...(withPreload
      ? {
          preload: () => {
            ledger.warmed.push(id);
          },
        }
      : {}),
  });
  return [
    declare("test.goToSettings", "Go to Settings", true),
    declare("test.goToWorkflows", "Go to Workflows", true),
    // The common case: a command whose act opens nothing loadable declares no warm,
    // and the palette must not require one.
    declare("test.useLightScheme", "Use the light colour scheme", false),
  ];
}

/**
 * What a person typing into the palette's input does to the query.
 *
 * `input` carrying an `inputType`, and not `change`, because the combobox reads that
 * member to tell TYPED input from a programmatic write: its automatic highlight is
 * armed only for the former, so a `change` event narrows the list and highlights
 * nothing, and a case built on one would report a warm that never fires as a warm that
 * cannot.
 */
function typeQuery(query: string): void {
  fireEvent.input(screen.getByRole("combobox"), {
    target: { value: query },
    inputType: "insertText",
  });
}

async function openPaletteOver(ledger: WarmLedger): Promise<void> {
  const registry = new CommandRegistry();
  registry.registerAll(commandsUnder(ledger));
  render(
    <PaletteOverlay
      registry={registry}
      context={CONTEXT}
      open
      onOpenChange={() => undefined}
      platform="darwin"
    />,
  );
  await settle();
}

describe("the palette — the highlighted row's warm", () => {
  it("warms nothing while the palette is merely open", async () => {
    // The moment is the claim. An open palette with no query highlights no row, so
    // there is no intent to read yet and nothing is fetched — a palette that warmed its
    // whole list on open would pay for every loader-backed body at once, which is the
    // entry graph this boundary exists to empty.
    const ledger: WarmLedger = { warmed: [], ran: [] };
    await openPaletteOver(ledger);
    expect(ledger.warmed).toStrictEqual([]);
    expect(ledger.ran).toStrictEqual([]);
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
  });

  it("warms the row the query highlights, without running it", async () => {
    const ledger: WarmLedger = { warmed: [], ran: [] };
    await openPaletteOver(ledger);

    typeQuery("workflows");
    await settle();

    // The chunk is in flight while the row is still being read: the highlighted
    // command's own body was warmed, and nothing was performed.
    expect(ledger.warmed).toStrictEqual(["test.goToWorkflows"]);
    expect(ledger.ran).toStrictEqual([]);
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
  });

  it("follows the highlight down the list", async () => {
    const ledger: WarmLedger = { warmed: [], ran: [] };
    await openPaletteOver(ledger);

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    await settle();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    await settle();

    // One warm per row passed over, in the order they were passed over — a warm keyed
    // to the list rather than to the highlight would have fetched every body at the
    // first press.
    expect(ledger.warmed).toStrictEqual(["test.goToSettings", "test.goToWorkflows"]);
    expect(ledger.ran).toStrictEqual([]);
  });

  it("negative control: a command with no warm is highlighted without one", async () => {
    // Two claims in one, and both are about the absence: a palette that called a
    // missing `preload` would throw here, and one that recorded a warm for a command
    // declaring none would have had to invent it.
    const ledger: WarmLedger = { warmed: [], ran: [] };
    await openPaletteOver(ledger);

    typeQuery("light colour");
    await settle();

    expect(ledger.warmed).toStrictEqual([]);
    expect(screen.getByRole("option", { name: /Use the light colour scheme/u })).toBeTruthy();
  });

  it("negative control: registering a command warms nothing on its own", async () => {
    // Without this, every case above would pass over a registry that warmed each
    // command as it was contributed — every loader-backed body fetched at composition
    // time, which is the static import back again wearing a different name.
    const ledger: WarmLedger = { warmed: [], ran: [] };
    const registry = new CommandRegistry();
    registry.registerAll(commandsUnder(ledger));
    expect(ledger.warmed).toStrictEqual([]);
    await settle();
    expect(ledger.warmed).toStrictEqual([]);
  });
});
