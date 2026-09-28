// A closed palette costs nothing, and an open one is acting on what it said it was.
//
// Two claims:
//
//   • The registry's search and its visible-command count ran on every render of the
//     frame, so a palette nobody had opened re-ranked the whole command set each time
//     the route or the command context moved.
//   • The scope row was re-resolved on every render, so a person who read "acting on
//     X", typed, and pressed Enter could be acting on something else.
//
// The counters below are the instrument for the first: a registry that RECORDS how
// often it was asked, so "evaluates nothing while closed" is measured rather than
// asserted.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settle } from "../../core/settle.test-support.js";
import { CommandRegistry, type ConsoleCommand } from "../commands/index.js";
import { PaletteOverlay } from "./PaletteOverlay.js";
import type { WhenClauseContext } from "../when-clause/index.js";

const CONTEXT: WhenClauseContext = {
  sessionActive: false,
  onSessions: false,
  onWorkspace: false,
  onWorkflows: false,
  onSettings: false,
};

/**
 * What the palette put on the page.
 *
 * `document.body` and not the render container: `Dialog.Portal` mounts the popup
 * outside the tree `render` returns, so a case reading the container would compare
 * against an empty string and pass whatever it was asserting.
 */
function paletteText(): string {
  return document.body.textContent ?? "";
}

/** The scope row's value, which is the only text the capture claim is about. */
function scopeRowText(): string {
  return document.querySelector(".console-palette__scope-value")?.textContent ?? "";
}

const COMMANDS: readonly ConsoleCommand[] = [
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
      <PaletteOverlay
        registry={registry}
        context={CONTEXT}
        open={false}
        onOpenChange={() => undefined}
        platform="darwin"
        revision={1}
      />,
    );
    // Re-rendered with a moved context and a bumped revision, which is exactly what
    // the frame does as a person navigates: both used to force a fresh search.
    rerender(
      <PaletteOverlay
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
    // Without this, a palette that had simply stopped working would pass the case
    // above.
    const registry = registryWithCommands();
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
    expect(registry.searchCount).toBeGreaterThan(0);
  });
});

describe("the palette — the captured scope", () => {
  it("keeps the label it opened with while the frame re-resolves it", async () => {
    const registry = registryWithCommands();
    const { rerender } = render(
      <PaletteOverlay
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
      <PaletteOverlay
        registry={registry}
        context={CONTEXT}
        open
        onOpenChange={() => undefined}
        platform="darwin"
        scopeLabel="A different session"
      />,
    );
    await settle();
    // The target a person read is the target they act on. Read off the scope ROW
    // rather than the whole page, because a command's own title may legitimately
    // contain the word a later scope label uses.
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
      <PaletteOverlay {...props} open scopeLabel="Session: refactor the projector" />,
    );
    await settle();
    rerender(<PaletteOverlay {...props} open={false} scopeLabel="A different session" />);
    await settle();
    rerender(<PaletteOverlay {...props} open scopeLabel="A different session" />);
    await settle();
    expect(scopeRowText()).toBe("A different session");
  });
});
