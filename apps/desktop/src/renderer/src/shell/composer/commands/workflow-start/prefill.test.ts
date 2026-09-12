// That the palette entry never eats an unsent message.
//
// `DraftStore.write` replaces a key's whole text and keeps no history, so the palette
// row that typed the directive unconditionally destroyed whatever a person had
// written — one row away from another in a list, with nothing between the press and
// the loss and no way back. The cases below hold both halves: an empty line is
// prefilled outright, and a line with something in it is not written to at all until
// somebody says so.
//
// Driven through the REAL registry, because the act is reached by pressing a palette
// row: a case that called `run()` off the hook's own array would prove the function
// works and nothing about what the palette runs.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MAXIMUM_LIVE_DRAFT_COUNT } from "../../../../console/core/index.js";
import { consoleCommands } from "../../../../console/palette/index.js";
import { DraftStore } from "../../../../console/persistence/index.js";
import { DEFAULT_ROUTE } from "../../../../console/routing/index.js";
import { composerCommandSurface } from "../console-command-surface.js";
import { WORKFLOW_COMMAND_ROOT, WORKFLOW_START_DIRECTIVE_PREFILL } from "./grammar.js";
import { decideWorkflowStartPrefill, useWorkflowStartPrefill } from "./prefill.js";

const DRAFT_KEY = "composer:workflow-start-prefill";

/** The composer's line, mounted with its palette entry contributed. */
function mountPrefillSurface(initialText?: string) {
  const draftStore = new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT });
  if (initialText !== undefined) {
    draftStore.write(DRAFT_KEY, initialText);
  }
  const rendered = renderHook(() => useWorkflowStartPrefill({ draftStore, draftKey: DRAFT_KEY }));
  return { draftStore, rendered };
}

/** Press the palette row, exactly as the palette does: through the registry. */
function pressPaletteRow(): void {
  act(() => {
    composerCommandSurface(DEFAULT_ROUTE).invoke(WORKFLOW_COMMAND_ROOT);
  });
}

/** What the line holds now. */
function lineText(draftStore: DraftStore): string | undefined {
  return draftStore.read(DRAFT_KEY)?.text;
}

afterEach(() => {
  // The seat releases on unmount, but a case that threw mid-act would otherwise leave
  // this window's registry holding the row for the next one.
  consoleCommands.unregister(WORKFLOW_COMMAND_ROOT);
});

describe("decideWorkflowStartPrefill", () => {
  it("prefills a line holding nothing", () => {
    expect(decideWorkflowStartPrefill("")).toStrictEqual({ status: "prefill" });
  });

  it("prefills a line holding only whitespace", () => {
    // Blankness is decided by trimming, which is a question about the text rather
    // than an edit of it — the same reading the send router makes.
    expect(decideWorkflowStartPrefill("   \n  ")).toStrictEqual({ status: "prefill" });
  });

  it("raises an explicit decision over unsent text, carrying the text itself", () => {
    expect(decideWorkflowStartPrefill("  ship the parser fix  ")).toStrictEqual({
      status: "confirm-replace",
      // The user's own bytes, untrimmed: what is preserved is what they typed.
      displacedText: "  ship the parser fix  ",
    });
  });
});

describe("the palette entry", () => {
  it("types the directive onto a line holding nothing", () => {
    const { draftStore, rendered } = mountPrefillSurface();

    pressPaletteRow();

    expect(lineText(draftStore)).toBe(WORKFLOW_START_DIRECTIVE_PREFILL);
    expect(rendered.result.current.displacedText).toBeUndefined();
  });

  it("negative control: it does not write over unsent text, and names what would go", () => {
    // The defect. An unconditional write left this line reading
    // `/workflow start ` with the message gone and nothing to recover it from.
    const { draftStore, rendered } = mountPrefillSurface("ship the parser fix");

    pressPaletteRow();

    expect(lineText(draftStore)).toBe("ship the parser fix");
    expect(rendered.result.current.displacedText).toBe("ship the parser fix");
  });

  it("writes once the person answers the question with Replace", () => {
    const { draftStore, rendered } = mountPrefillSurface("ship the parser fix");
    pressPaletteRow();

    act(() => {
      rendered.result.current.replaceLine();
    });

    expect(lineText(draftStore)).toBe(WORKFLOW_START_DIRECTIVE_PREFILL);
    expect(rendered.result.current.displacedText).toBeUndefined();
  });

  it("leaves the line exactly as it was when the person keeps it", () => {
    const { draftStore, rendered } = mountPrefillSurface("ship the parser fix");
    pressPaletteRow();

    act(() => {
      rendered.result.current.keepLine();
    });

    expect(lineText(draftStore)).toBe("ship the parser fix");
    expect(rendered.result.current.displacedText).toBeUndefined();
  });

  it("reads the line at press time rather than at render time", () => {
    // What the write must not destroy is whatever is in the line when the row is
    // pressed; a value closed over at render is a value from before the last
    // keystroke.
    const { draftStore, rendered } = mountPrefillSurface();
    act(() => {
      draftStore.write(DRAFT_KEY, "typed after this surface rendered");
    });

    pressPaletteRow();

    expect(lineText(draftStore)).toBe("typed after this surface rendered");
    expect(rendered.result.current.displacedText).toBe("typed after this surface rendered");
  });

  it("is registered under the command root, so one command has one name", () => {
    mountPrefillSurface();

    expect(consoleCommands.get(WORKFLOW_COMMAND_ROOT)?.title).toBe("Start a workflow");
    // The superseded dotted id is nobody's command: the palette, the recogniser, and
    // the keyboard page all name the root.
    expect(consoleCommands.has("workflow.start")).toBe(false);
  });
});
