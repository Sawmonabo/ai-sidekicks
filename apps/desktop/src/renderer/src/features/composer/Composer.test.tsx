// The palette's `Run a workflow` over a line holding unsent words asks above the draft, and only
// the answer decides whether the words go: the composer draws the question, never drops it.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { commandRegistry } from "#renderer/registries/commands/window-command-registry.js";
import { DEFAULT_ROUTE } from "#renderer/routing/routes.js";
import { DraftStore } from "#renderer/store/draft-store.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "#renderer/store/persistence/caps.js";
import { WindowStore } from "#renderer/store/window/window-store.js";
import { readComposerCommands } from "./command-list/composer-commands.js";
import { WORKFLOW_COMMAND_ROOT } from "./command-list/workflow-command/grammar.js";
import { MessageComposer } from "./Composer.js";
import { inertBridge } from "./composer.test-support.js";
import { openSessionStore } from "./draft-line/components/DraftLine.test-support.js";

afterEach(() => {
  commandRegistry.unregister(WORKFLOW_COMMAND_ROOT);
});

function mountComposerWithLine(text: string): HTMLTextAreaElement {
  const draftStore = new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT });
  const { container } = render(
    <MessageComposer
      sessionStore={openSessionStore()}
      bridge={inertBridge()}
      draftStore={draftStore}
      frameStore={new WindowStore()}
      route={DEFAULT_ROUTE}
      focusedPane={undefined}
    />,
  );
  const line = container.querySelector("textarea");
  if (!(line instanceof HTMLTextAreaElement)) {
    throw new Error("the composer drew no draft line");
  }
  fireEvent.change(line, { target: { value: text } });
  act(() => {
    readComposerCommands(DEFAULT_ROUTE).invoke(WORKFLOW_COMMAND_ROOT);
  });
  return line;
}

describe("the palette's workflow entry over unsent words", () => {
  it("asks above the draft and replaces the words only once the person says so", () => {
    const line = mountComposerWithLine("ship the parser fix");

    expect(line.value).toBe("ship the parser fix");
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    expect(line.value).toBe("/workflow run ");
    expect(screen.queryByRole("group", { name: "Replace the draft" })).toBeNull();
  });

  it("keeps the words when the person keeps them", () => {
    const line = mountComposerWithLine("ship the parser fix");

    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));

    expect(line.value).toBe("ship the parser fix");
    expect(screen.queryByRole("group", { name: "Replace the draft" })).toBeNull();
  });
});
