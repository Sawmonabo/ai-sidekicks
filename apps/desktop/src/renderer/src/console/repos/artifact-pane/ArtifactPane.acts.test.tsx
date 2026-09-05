// What the artifact pane's row acts actually do: read one row's manifest, and delete one.
//
// THE BLOCK THAT FAILS ON A PANE THAT DISCARDS WHAT IT IS SERVED. The read used to be
// called "Fetch payload" and used to throw its answer away, so pressing it changed
// nothing at all — no row, no sentence, no refusal. Both halves are checked here: the
// control is named for the manifest the read serves, and a served answer reaches the row.
//
// The pane's rendered surface is in `ArtifactPane.test.tsx` and the seam that holds its
// reader in `ArtifactPane.reader-seam.test.tsx`; the payload fetch is its own component's
// suite, `ArtifactPayloadSection.test.tsx`.

import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { growthUnavailable } from "../../bridge/index.js";
import { ManualClock } from "../../core/index.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { ARTIFACT_PAYLOAD_DISPOSITION_COPY } from "../artifacts/artifact-model.js";
import { ArtifactPane } from "./ArtifactPane.js";
import {
  type GrowthAnswer,
  SERVED_DELETE,
  LISTED_ONE_ROW,
  SESSION_ID,
  artifactBridgeAnswering,
  readAnswering,
  readThrough,
  settleAct,
} from "./artifact-pane.test-support.js";
import {
  ARTIFACT_ENTITY,
  confirmDelete,
  contextFor,
  renderPane,
} from "./artifact-pane-mount.test-support.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("artifact pane — reading one row's manifest", () => {
  it("offers the row's manifest re-read beside the pane's own payload fetch", async () => {
    // Two acts over one method, told apart by `includePayload`. The row's control is
    // named for what its read serves; the pane's is named for the bytes it asks for.
    const { getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({ listAnswer: LISTED_ONE_ROW }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
    expect(getByRole("button", { name: "Read manifest" })).toBeDefined();
    expect(getByRole("button", { name: "Fetch payload" })).toBeDefined();
  });

  it("puts the served manifest on the row it was read for", async () => {
    // The case a discarded result fails: the read answers with a state the list did
    // not carry, and the row has to move to it.
    const { container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({
          listAnswer: LISTED_ONE_ROW,
          readAnswer: readAnswering("superseded"),
        }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
    const row = container.querySelector(".meridian-artifact-row") as HTMLElement;
    expect(within(row).getByText("published")).toBeDefined();

    fireEvent.click(getByRole("button", { name: "Read manifest" }));
    await settleAct();

    const settled = container.querySelector(".meridian-artifact-row") as HTMLElement;
    expect(within(settled).getByText("superseded")).toBeDefined();
    expect(within(settled).queryByText("published")).toBeNull();
  });

  it("says once that the manifest was re-read", async () => {
    const { container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({
          listAnswer: LISTED_ONE_ROW,
          readAnswer: readAnswering("superseded"),
        }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
    // Nothing settled yet, so nothing has been said.
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");

    fireEvent.click(getByRole("button", { name: "Read manifest" }));
    await settleAct();

    expect(container.querySelector('[role="status"]')?.textContent).toContain("Manifest re-read");
  });

  it("renders the refusal beside the control and leaves the row where it was", async () => {
    const { container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({ listAnswer: LISTED_ONE_ROW }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
    fireEvent.click(getByRole("button", { name: "Read manifest" }));
    await settleAct();

    const row = container.querySelector(".meridian-artifact-row") as HTMLElement;
    expect(row.textContent).toContain("wire-unregistered");
    expect(within(row).getByText("published")).toBeDefined();
    // Off the port's own builder rather than a transcribed sentence: the words come
    // from the slate row, so a hand-copied string here would keep passing while the
    // announcement a person hears moved.
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      growthUnavailable("artifactRead").detail,
    );
  });

  it("negative control: a re-render on its own announces nothing", async () => {
    // The sentence belongs to the act's settlement. A pane that announced from a
    // render body would speak again on every unrelated transition. The same bridge
    // and session are handed back, so the reader is the one that already read and
    // this is a re-render rather than a remount.
    const bridge = artifactBridgeAnswering({ listAnswer: LISTED_ONE_ROW });
    const context = contextFor(ARTIFACT_ENTITY, { bridge, sessionId: SESSION_ID });
    const { container, getByRole, rerender } = renderPane(context);
    await readThrough();
    rerender(
      <LiveAnnouncerProvider clock={new ManualClock()}>
        <ArtifactPane context={context} />
      </LiveAnnouncerProvider>,
    );
    await settleAct();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
    expect(getByRole("button", { name: "Read manifest" })).toBeDefined();
  });
});

describe("artifact pane — deleting one row", () => {
  it("takes the row off the list and reads the list again", async () => {
    // The case a discarded reply fails: a served delete used to leave the manifest on
    // screen, so a participant could keep acting on something the daemon destroyed.
    const artifactList = vi
      .fn<() => Promise<GrowthAnswer<"artifactList">>>()
      .mockResolvedValueOnce(LISTED_ONE_ROW)
      .mockResolvedValue({ status: "served", value: [] });
    const { container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({
          listAnswer: LISTED_ONE_ROW,
          artifactList,
          deleteAnswer: SERVED_DELETE,
        }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
    expect(container.querySelectorAll(".meridian-artifact-row")).toHaveLength(1);

    confirmDelete(getByRole);
    await settleAct();
    expect(container.querySelectorAll(".meridian-artifact-row")).toHaveLength(0);

    // One re-read, coalesced through the same scheduler the pane's own control uses.
    await readThrough();
    expect(artifactList).toHaveBeenCalledTimes(2);
  });

  it("says what the delete reported, in the daemon's own two facts", async () => {
    const { container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({
          listAnswer: LISTED_ONE_ROW,
          deleteAnswer: SERVED_DELETE,
        }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
    confirmDelete(getByRole);
    await settleAct();

    const spoken = container.textContent ?? "";
    expect(spoken).toContain("Artifact deleted");
    // Both members of the receipt, and neither the old sentence's claim that the
    // reply carried nothing.
    expect(spoken).toContain(ARTIFACT_PAYLOAD_DISPOSITION_COPY.retained_by_references);
    expect(spoken).toContain("Re-publishing this artifact is now permanently impossible.");
    expect(spoken).not.toContain("no payload disposition");
  });

  it("draws the receipt on the panel as well as announcing it", async () => {
    const { container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({
          listAnswer: LISTED_ONE_ROW,
          deleteAnswer: SERVED_DELETE,
        }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
    confirmDelete(getByRole);
    await settleAct();

    const receipt = container.querySelector(".meridian-artifacts__receipt");
    expect(receipt?.textContent).toContain(
      ARTIFACT_PAYLOAD_DISPOSITION_COPY.retained_by_references,
    );
  });

  it("negative control: the receipt is cleared by the list read that follows it", async () => {
    // A consequence left standing over a re-read would read as a fact about the list
    // now on screen rather than about the row that is gone.
    const artifactList = vi
      .fn<() => Promise<GrowthAnswer<"artifactList">>>()
      .mockResolvedValue(LISTED_ONE_ROW);
    const { container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({ artifactList, deleteAnswer: SERVED_DELETE }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
    confirmDelete(getByRole);
    await settleAct();
    expect(container.querySelector(".meridian-artifacts__receipt")).not.toBeNull();

    await readThrough();
    expect(container.querySelector(".meridian-artifacts__receipt")).toBeNull();
  });
});
