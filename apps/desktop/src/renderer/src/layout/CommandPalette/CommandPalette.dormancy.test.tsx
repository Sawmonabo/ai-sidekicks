// A closed palette costs nothing, and an open one acts on the scope it showed. The registry
// counters measure that a closed palette never searches, and the scope row must not follow the
// live route while the palette is open.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settle } from "@test/helpers/settle.js";
import { CommandRegistry } from "@renderer/registries/commands/command-registry.js";
import { type CommandDefinition } from "@renderer/registries/commands/command-types.js";
import { CommandPalette } from "./CommandPalette.js";
import type { WhenClauseContext } from "@renderer/registries/commands/when-clause/when-clause.js";

const CONTEXT: WhenClauseContext = {
  sessionActive: false,
  onSessions: false,
  onSession: false,
  onWorkflows: false,
  onSettings: false,
};

/** The page text, from `document.body` because `Dialog.Portal` mounts outside the container. */
function paletteText(): string {
  return document.body.textContent ?? "";
}

/** The scope row's value, the only text the capture claim is about. */
function scopeRowText(): string {
  return document.querySelector(".command-palette__scope-value")?.textContent ?? "";
}

const COMMANDS: readonly CommandDefinition[] = [
  { id: "test.goToSettings", title: "Go to Settings", group: "Navigate", run: () => undefined },
  { id: "test.goToWorkflows", title: "Go to Workflows", group: "Navigate", run: () => undefined },
];

/** A registry that counts what it was asked. The instrument for the dormancy claim. */
class CountingCommandRegistry extends CommandRegistry {
  public searchCount = 0;
  public commandsForCount = 0;

  public override search(
    query: string,
    context: WhenClauseContext,
  ): ReturnType<CommandRegistry["search"]> {
    this.searchCount += 1;
    return super.search(query, context);
  }

  public override commandsFor(
    context: WhenClauseContext,
  ): ReturnType<CommandRegistry["commandsFor"]> {
    this.commandsForCount += 1;
    return super.commandsFor(context);
  }
}

function registryWithCommands(): CountingCommandRegistry {
  const registry = new CountingCommandRegistry();
  registry.registerAll(COMMANDS);
  return registry;
}

describe("the palette — dormant while closed", () => {
  it("never asks the registry anything while it is closed", async () => {
    const registry = registryWithCommands();
    const { rerender } = render(
      <CommandPalette
        registry={registry}
        context={CONTEXT}
        open={false}
        onOpenChange={() => undefined}
        platform="darwin"
        revision={1}
      />,
    );
    // A moved context and bumped revision, as when a person navigates, must not force a search.
    rerender(
      <CommandPalette
        registry={registry}
        context={{ ...CONTEXT, onSettings: true }}
        open={false}
        onOpenChange={() => undefined}
        platform="darwin"
        revision={2}
      />,
    );
    await settle();
    expect(registry.searchCount).toBe(0);
    expect(registry.commandsForCount).toBe(0);
  });

  it("asks it the moment it opens — the control", async () => {
    // Without this, a palette that had stopped working would pass the case above.
    const registry = registryWithCommands();
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
    expect(registry.searchCount).toBeGreaterThan(0);
  });
});

describe("the palette — the captured scope", () => {
  it("keeps the label it opened with while the frame re-resolves it", async () => {
    const registry = registryWithCommands();
    const { rerender } = render(
      <CommandPalette
        registry={registry}
        context={CONTEXT}
        open
        onOpenChange={() => undefined}
        platform="darwin"
        scopeLabel="Session: refactor the projector"
      />,
    );
    await settle();
    expect(paletteText()).toContain("Session: refactor the projector");

    rerender(
      <CommandPalette
        registry={registry}
        context={CONTEXT}
        open
        onOpenChange={() => undefined}
        platform="darwin"
        scopeLabel="A different session"
      />,
    );
    await settle();
    // Read off the scope row: a command title may contain a word a later scope label uses.
    expect(scopeRowText()).toBe("Session: refactor the projector");
  });

  it("takes the new label on the next open — the control", async () => {
    const registry = registryWithCommands();
    const props = {
      registry,
      context: CONTEXT,
      onOpenChange: () => undefined,
      platform: "darwin" as const,
    };
    const { rerender } = render(
      <CommandPalette {...props} open scopeLabel="Session: refactor the projector" />,
    );
    await settle();
    rerender(<CommandPalette {...props} open={false} scopeLabel="A different session" />);
    await settle();
    rerender(<CommandPalette {...props} open scopeLabel="A different session" />);
    await settle();
    expect(scopeRowText()).toBe("A different session");
  });
});
