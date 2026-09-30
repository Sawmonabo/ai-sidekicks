// The highlighted row warms what its command would open, before the act. The case sits here
// because `command.preload` is called only from a Base UI highlight callback, so what is in
// question is whether the combobox's highlight reaches it; `autoHighlight` moves the highlight
// as a person types, and the first case asserts the warm fired with `run` never called.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settle } from "@test/helpers/settle.js";
import { CommandRegistry } from "@renderer/registries/commands/command-registry.js";
import { type CommandDefinition } from "@renderer/registries/commands/command-types.js";
import { CommandPalette } from "./CommandPalette.js";
import type { WhenClauseContext } from "@renderer/registries/commands/when-clause/when-clause.js";

/** Every clause key false: these commands carry no `when`, so nothing is filtered out. */
const CONTEXT: WhenClauseContext = {
  sessionActive: false,
  onSessions: false,
  onSession: false,
  onWorkflows: false,
  onSettings: false,
};

/** What each command was asked to do, in the order it was asked. */
interface WarmLedger {
  readonly warmed: string[];
  readonly ran: string[];
}

function commandsUnder(ledger: WarmLedger): readonly CommandDefinition[] {
  const declare = (id: string, title: string, withPreload: boolean): CommandDefinition => ({
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
    // The common case: a command that declares no `preload`.
    declare("test.useLightScheme", "Use the light color scheme", false),
  ];
}

/**
 * Types into the palette's input. It fires `input` with an `inputType`, not `change`: the combobox
 * arms its automatic highlight only for typed input, so `change` would highlight nothing.
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
    <CommandPalette
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
    // An open palette with no query highlights no row; warming the whole list on open would fetch
    // every loader-backed body at once.
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

    // The highlighted command's body was warmed and nothing was performed.
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

    // One warm per row passed over; a warm keyed to the list would have fetched every body at once.
    expect(ledger.warmed).toStrictEqual(["test.goToSettings", "test.goToWorkflows"]);
    expect(ledger.ran).toStrictEqual([]);
  });

  it("negative control: a command with no warm is highlighted without one", async () => {
    // A missing `preload` must not be called (it would throw), and no warm may be invented.
    const ledger: WarmLedger = { warmed: [], ran: [] };
    await openPaletteOver(ledger);

    typeQuery("light color");
    await settle();

    expect(ledger.warmed).toStrictEqual([]);
    expect(screen.getByRole("option", { name: /Use the light color scheme/u })).toBeTruthy();
  });

  it("negative control: registering a command warms nothing on its own", async () => {
    // Without this, the cases above would pass over a registry that warmed each command on
    // registration.
    const ledger: WarmLedger = { warmed: [], ran: [] };
    const registry = new CommandRegistry();
    registry.registerAll(commandsUnder(ledger));
    expect(ledger.warmed).toStrictEqual([]);
    await settle();
    expect(ledger.warmed).toStrictEqual([]);
  });
});
