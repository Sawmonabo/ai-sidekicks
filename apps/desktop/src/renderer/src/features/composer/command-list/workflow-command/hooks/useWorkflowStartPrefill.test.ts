// The palette entry never eats an unsent message: an empty line is prefilled outright and a line
// with text is not written to until the person says so. Driven through the real registry, since
// the act is reached by pressing a palette row.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/store/persistence/caps.js";
import { commandRegistry } from "@renderer/registries/commands/window-command-registry.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import { DEFAULT_ROUTE } from "@renderer/routing/routes.js";
import { readComposerCommands } from "../../composer-commands.js";
import { WORKFLOW_COMMAND_ROOT } from "../workflow-command-grammar.js";
import { useWorkflowStartPrefill } from "./useWorkflowStartPrefill.js";

const DRAFT_KEY = "composer:workflow-start-prefill";

function mountComposerLine(initialText?: string) {
  const draftStore = new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT });
  if (initialText !== undefined) {
    draftStore.write(DRAFT_KEY, initialText);
  }
  const rendered = renderHook(() => useWorkflowStartPrefill({ draftStore, draftKey: DRAFT_KEY }));
  return { draftStore, rendered };
}

function pressPaletteRow(): void {
  act(() => {
    readComposerCommands(DEFAULT_ROUTE).invoke(WORKFLOW_COMMAND_ROOT);
  });
}

function lineText(draftStore: DraftStore): string | undefined {
  return draftStore.read(DRAFT_KEY)?.text;
}

afterEach(() => {
  // Release the registration even if a case threw mid-act, so the next case starts clean.
  commandRegistry.unregister(WORKFLOW_COMMAND_ROOT);
});

describe("the palette entry", () => {
  it("does not write over unsent text, and names what would go", () => {
    // An unconditional write left `/workflow start ` with the message gone.
    const { draftStore, rendered } = mountComposerLine("ship the parser fix");

    pressPaletteRow();

    expect(lineText(draftStore)).toBe("ship the parser fix");
    expect(rendered.result.current.displacedText).toBe("ship the parser fix");
  });

  it("leaves the line exactly as it was when the person keeps it", () => {
    const { draftStore, rendered } = mountComposerLine("ship the parser fix");
    pressPaletteRow();

    act(() => {
      rendered.result.current.keepLine();
    });

    expect(lineText(draftStore)).toBe("ship the parser fix");
    expect(rendered.result.current.displacedText).toBeUndefined();
  });

  it("reads the line at press time rather than at render time", () => {
    // The text at press time is what must survive, not a value closed over at render.
    const { draftStore, rendered } = mountComposerLine();
    act(() => {
      draftStore.write(DRAFT_KEY, "typed after this line rendered");
    });

    pressPaletteRow();

    expect(lineText(draftStore)).toBe("typed after this line rendered");
    expect(rendered.result.current.displacedText).toBe("typed after this line rendered");
  });
});
