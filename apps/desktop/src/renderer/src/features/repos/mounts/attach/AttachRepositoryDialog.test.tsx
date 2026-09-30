// The attach dialog: it hands the model what was typed, so the control opens once a path is
// named. `attach-form.test.ts` proves the verdict itself.

import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { bridgeOnClock } from "@test/helpers/fixture-bridge.js";
import { scriptedRepoOperations } from "../../repo-operations.test-support.js";
import { SESSION_ID } from "../repo-mounts.test-support.js";
import { AttachRepositoryDialog } from "./AttachRepositoryDialog.js";

/** A path long enough to be a path and short enough to read in a failure. */
const TYPED_PATH = "/Users/dev/code/ai-sidekicks";

function attachButton(): HTMLButtonElement {
  const control = document.querySelector<HTMLButtonElement>(".meridian-repo-attach__confirm");
  if (control === null) {
    throw new Error("the dialog rendered no Attach control");
  }
  return control;
}

/** What the dialog says under a shut control, or nothing where it says nothing. */
function blockedSentence(): string | undefined {
  return document.querySelector(".meridian-repo-attach__blocked")?.textContent ?? undefined;
}

function typePath(path: string): void {
  const field = document.querySelector<HTMLInputElement>(".meridian-repo-attach__path-input");
  if (field === null) {
    throw new Error("the dialog rendered no path field");
  }
  fireEvent.change(field, { target: { value: path } });
}

/** Mount the dialog and open it the way a person does. */
function openDialog(): void {
  const { container } = render(
    <LiveAnnouncerProvider>
      <AttachRepositoryDialog
        bridge={bridgeOnClock("repos").bridge}
        operations={scriptedRepoOperations()}
        sessionId={SESSION_ID}
        onAttached={() => undefined}
      />
    </LiveAnnouncerProvider>,
  );
  act(() => {
    container.querySelector<HTMLButtonElement>(".meridian-repo-attach__trigger")?.click();
  });
}

describe("the attach dialog — a session on one machine has no decision to make", () => {
  it("opens the control once a path is named, with nothing else to choose", () => {
    openDialog();

    expect(attachButton().disabled).toBe(true);
    expect(blockedSentence()).toContain("path");

    typePath(TYPED_PATH);

    expect(attachButton().disabled).toBe(false);
    expect(blockedSentence()).toBeUndefined();
  });
});
