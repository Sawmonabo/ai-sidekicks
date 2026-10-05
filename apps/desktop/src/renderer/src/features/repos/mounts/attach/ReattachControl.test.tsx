// The re-attach a person pressed keeps being reported after the dialog shuts. The confirm
// control is an `AlertDialog.Close`, so it sends and closes at once; a discard wired to every
// close would fire right after `sending` was published, freeing the trigger under an attach
// still on the wire (see also `execution-roots/RootRemovalConfirmation.test.tsx`). The popup
// is portaled, so acts are read off `document` and the settlement off the render container.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RepoAttachResponse } from "@ai-sidekicks/contracts/repo-folders";

import type { RepoOperations } from "../../repo-operations.js";
import { bridgeOnClock } from "@test/helpers/fixture-bridge.js";
import { scriptedRepoOperations } from "../../repo-operations.test-support.js";
import { confirmationPresses } from "../repo-mounts.test-support.js";
import { ReattachControl } from "./ReattachControl.js";

const SESSION_ID = "019b79ee-0280-740e-8110-d1a4c1150091";

const LOCAL_PATH = "/Users/dev/code/ai-sidekicks/packages/contracts";

/** An attach that never answers, so the sent state stays observable. */
function operationsHoldingTheCall(): RepoOperations {
  return scriptedRepoOperations({
    attachRepository: async () => await new Promise<never>(() => undefined),
  });
}

/** An attach that mints a mount, so a settlement lands on the card. */
function operationsAnsweringTheCall(): RepoOperations {
  return scriptedRepoOperations({
    attachRepository: () =>
      Promise.resolve({
        repoMountId: "mount-new",
        state: "attached",
        vcsType: "git",
        canonicalRoot: LOCAL_PATH,
      } as unknown as RepoAttachResponse),
  });
}

function renderControl(operations: RepoOperations): ReturnType<typeof render> {
  return render(
    <ReattachControl
      bridge={bridgeOnClock("repos").bridge}
      operations={operations}
      sessionId={SESSION_ID}
      localPath={LOCAL_PATH}
      onAttached={() => undefined}
    />,
  );
}

const { trigger, pressOpen, pressConfirm, pressCancel } = confirmationPresses("meridian-reattach");

describe("ReattachControl — the confirm press keeps its settlement", () => {
  it("still reports the re-attach as sent once confirming has closed the dialog", async () => {
    const { container } = renderControl(operationsHoldingTheCall());

    await pressOpen();
    await pressConfirm();

    expect(container.textContent).toContain("Re-attaching.");
    expect(trigger()?.disabled).toBe(true);
  });
});

describe("ReattachControl — a discarded consideration", () => {
  it("discards the standing settlement when the user walks away from the question", async () => {
    const { container } = renderControl(operationsAnsweringTheCall());

    await pressOpen();
    await pressConfirm();
    expect(container.querySelector(".meridian-reattach__attached")).not.toBeNull();

    await pressOpen();
    await pressCancel();

    expect(container.querySelector(".meridian-reattach__attached")).toBeNull();
  });
});
