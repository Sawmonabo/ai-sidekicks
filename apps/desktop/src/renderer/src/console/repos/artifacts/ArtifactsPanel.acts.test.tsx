// The panel's acts: what each control does, what a delete states before it happens,
// and what a refusal leaves on screen.
//
// WHAT THE PANEL DRAWS BEFORE ANY PRESS is `ArtifactsPanel.test.tsx` — the four
// absences, the count, the row's face, the type filter, and the disclosure. Every case
// here is about a control and the consequence it names.

import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { refuse } from "../../core/index.js";
import { artifactRow } from "./artifacts.test-support.js";
import { ArtifactsPanel } from "./ArtifactsPanel.js";
import { ARTIFACT_DELETE_CONSEQUENCE, ARTIFACT_PAYLOAD_DISPOSITION_COPY } from "./artifact-copy.js";

// Built rather than parsed: a fixture instant is this suite's own decision, and the
// console's one reader of a wire stamp is `parseInstant`, not this line.
const NOW_MILLISECONDS = Date.UTC(2026, 0, 1, 9, 30, 0);

describe("ArtifactsPanel — the acts", () => {
  it("offers only the acts the mount wired", () => {
    const { container } = render(
      <ArtifactsPanel
        state={{ kind: "listed", rows: [artifactRow()] }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    const row = container.querySelector(".meridian-artifact-row");
    expect(row?.querySelectorAll("button")).toHaveLength(0);
  });

  it("asks for the manifest rather than rendering a payload", () => {
    // The hard rule: payloads are explicit-fetch downloads with no in-product
    // execution surface. The affordance is a control that ASKS — and it asks for
    // exactly what the registered read answers with, which is the manifest.
    const onReadManifest = vi.fn();
    const { container } = render(
      <ArtifactsPanel
        state={{ kind: "listed", rows: [artifactRow()] }}
        nowMilliseconds={NOW_MILLISECONDS}
        onReadManifest={onReadManifest}
      />,
    );
    fireEvent.click(within(container).getByRole("button", { name: "Read manifest" }));
    expect(onReadManifest).toHaveBeenCalledTimes(1);
  });

  it("holds the re-read control on a row whose read is on the wire", () => {
    // The press is single-flight per row, so offering the control while that row's
    // call is outstanding is offering a press whose only possible answer is the
    // refusal saying one is already in flight.
    const { container } = render(
      <ArtifactsPanel
        state={{ kind: "listed", rows: [artifactRow()] }}
        nowMilliseconds={NOW_MILLISECONDS}
        manifestReadInFlightArtifactIds={new Set([artifactRow().id])}
        onReadManifest={vi.fn()}
      />,
    );
    const control = within(container).getByRole("button", { name: "Read manifest" });
    expect(control.hasAttribute("disabled")).toBe(true);
  });

  it("negative control: a row nobody is reading keeps its control, and a sibling's read does not take it", () => {
    // Without this, a control disabled unconditionally would pass the case above
    // while making the act unreachable — and a register read per PANEL rather than
    // per row would hold one row's control because another row was waiting.
    const { container } = render(
      <ArtifactsPanel
        state={{ kind: "listed", rows: [artifactRow(), artifactRow({ id: "artifact-02" })] }}
        nowMilliseconds={NOW_MILLISECONDS}
        manifestReadInFlightArtifactIds={new Set(["artifact-02"])}
        onReadManifest={vi.fn()}
      />,
    );
    const [firstControl, secondControl] = within(container).getAllByRole("button", {
      name: "Read manifest",
    });
    expect(firstControl?.hasAttribute("disabled")).toBe(false);
    expect(secondControl?.hasAttribute("disabled")).toBe(true);
  });

  it("negative control: no control claims to fetch a payload", () => {
    // The read serves a manifest summary and no registered reply member carries
    // bytes or a handle, so a control named for a payload fetch would promise a
    // download nothing on this port can produce.
    const { queryByRole } = render(
      <ArtifactsPanel
        state={{ kind: "listed", rows: [artifactRow()] }}
        nowMilliseconds={NOW_MILLISECONDS}
        onReadManifest={vi.fn()}
      />,
    );
    expect(queryByRole("button", { name: "Fetch payload" })).toBeNull();
  });

  it("names the visibility class the toggle would move to", () => {
    const shared = render(
      <ArtifactsPanel
        state={{ kind: "listed", rows: [artifactRow({ visibility: "shared" })] }}
        nowMilliseconds={NOW_MILLISECONDS}
        onChangeVisibility={vi.fn()}
      />,
    );
    expect(within(shared.container).getByRole("button", { name: "Make local-only" })).toBeDefined();
    const local = render(
      <ArtifactsPanel
        state={{ kind: "listed", rows: [artifactRow({ visibility: "local-only" })] }}
        nowMilliseconds={NOW_MILLISECONDS}
        onChangeVisibility={vi.fn()}
      />,
    );
    expect(
      within(local.container).getByRole("button", { name: "Share with the session" }),
    ).toBeDefined();
  });
});

describe("ArtifactsPanel — delete states the consequence before the act", () => {
  it("does not delete on the first press", () => {
    const onDelete = vi.fn();
    const { container } = render(
      <ArtifactsPanel
        state={{ kind: "listed", rows: [artifactRow()] }}
        nowMilliseconds={NOW_MILLISECONDS}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(within(container).getByRole("button", { name: "Delete" }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(container.textContent).toContain(ARTIFACT_DELETE_CONSEQUENCE);
  });

  it("deletes on the confirm, and the way out is beside it", () => {
    const onDelete = vi.fn();
    const { container } = render(
      <ArtifactsPanel
        state={{ kind: "listed", rows: [artifactRow()] }}
        nowMilliseconds={NOW_MILLISECONDS}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(within(container).getByRole("button", { name: "Delete" }));
    expect(within(container).getByRole("button", { name: "Keep it" })).toBeDefined();
    fireEvent.click(within(container).getByRole("button", { name: "Delete permanently" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("closes an armed confirm when the pane is re-pointed and the list comes back", () => {
    // The defect: the confirm register was a bare `useState`, scoped to nothing. A
    // participant armed Delete on one artifact, the deck re-pointed the pane at
    // another — the reader is re-minted per subject, so the reading returns to its
    // unread absence and the rows unmount — and this component stayed mounted at the
    // same tree position. When the new subject's list landed carrying the same session
    // rows, the row came back with a destructive act armed and one click from firing,
    // with its consequence text having been off screen in between. On that code the
    // second assertion below is false.
    const onDelete = vi.fn();
    const listed = { kind: "listed", rows: [artifactRow()] } as const;
    const { container, rerender } = render(
      <ArtifactsPanel state={listed} nowMilliseconds={NOW_MILLISECONDS} onDelete={onDelete} />,
    );
    fireEvent.click(within(container).getByRole("button", { name: "Delete" }));
    expect(container.textContent).toContain(ARTIFACT_DELETE_CONSEQUENCE);

    // The re-point: the fresh reader's unread absence, then the same session's rows.
    rerender(
      <ArtifactsPanel
        state={{ kind: "not-checked" }}
        nowMilliseconds={NOW_MILLISECONDS}
        onDelete={onDelete}
      />,
    );
    rerender(
      <ArtifactsPanel
        state={{ kind: "listed", rows: [artifactRow()] }}
        nowMilliseconds={NOW_MILLISECONDS}
        onDelete={onDelete}
      />,
    );

    expect(container.textContent).not.toContain(ARTIFACT_DELETE_CONSEQUENCE);
    expect(within(container).queryByRole("button", { name: "Delete permanently" })).toBeNull();
  });

  it("negative control: a refresh that lists the same rows holds the confirm open", () => {
    // Without this the case above would pass against a register cleared on every
    // republish — which would take a confirmation away under a participant's cursor
    // because an unrelated session frame arrived, and leave the control they were
    // about to press replaced by whatever the row draws instead.
    const onDelete = vi.fn();
    const { container, rerender } = render(
      <ArtifactsPanel
        state={{ kind: "listed", rows: [artifactRow()] }}
        nowMilliseconds={NOW_MILLISECONDS}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(within(container).getByRole("button", { name: "Delete" }));

    // A fresh reading object carrying the same rows, which is what every refresh is.
    rerender(
      <ArtifactsPanel
        state={{ kind: "listed", rows: [artifactRow()] }}
        nowMilliseconds={NOW_MILLISECONDS}
        onDelete={onDelete}
      />,
    );

    expect(container.textContent).toContain(ARTIFACT_DELETE_CONSEQUENCE);
    expect(within(container).getByRole("button", { name: "Delete permanently" })).toBeDefined();
  });

  it("negative control: keeping it cancels without calling through", () => {
    const onDelete = vi.fn();
    const { container } = render(
      <ArtifactsPanel
        state={{ kind: "listed", rows: [artifactRow()] }}
        nowMilliseconds={NOW_MILLISECONDS}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(within(container).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(container).getByRole("button", { name: "Keep it" }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain(ARTIFACT_DELETE_CONSEQUENCE);
  });

  it("reports where the bytes went afterwards, and whether re-publish is foreclosed", () => {
    const { container } = render(
      <ArtifactsPanel
        state={{ kind: "listed", rows: [artifactRow()] }}
        nowMilliseconds={NOW_MILLISECONDS}
        lastDeleteReceipt={{
          artifactId: "artifact-01",
          rePublishForeclosed: true,
          payloadDisposition: "retained_by_references",
        }}
      />,
    );
    expect(container.textContent).toContain(
      ARTIFACT_PAYLOAD_DISPOSITION_COPY.retained_by_references,
    );
    expect(container.textContent).toContain("permanently impossible");
  });
});

describe("ArtifactsPanel — refusals render, controls stay", () => {
  it("puts the daemon's refusal beside the row without removing its controls", () => {
    const refusal = refuse(
      "artifact",
      "artifact.delete_blocked",
      "Delete the derivatives first, or keep the source.",
    );
    const { container } = render(
      <ArtifactsPanel
        state={{ kind: "listed", rows: [artifactRow()] }}
        nowMilliseconds={NOW_MILLISECONDS}
        onDelete={vi.fn()}
        rowRefusals={new Map([["artifact-01", refusal]])}
      />,
    );
    expect(container.textContent).toContain(refusal.code);
    expect(container.textContent).toContain(refusal.detail);
    // Rule 9: a refusal never hides the control that produced it.
    expect(within(container).getByRole("button", { name: "Delete" })).toBeDefined();
  });

  it("negative control: a row nothing refused carries no refusal", () => {
    const { container } = render(
      <ArtifactsPanel
        state={{ kind: "listed", rows: [artifactRow()] }}
        nowMilliseconds={NOW_MILLISECONDS}
        rowRefusals={new Map()}
      />,
    );
    expect(container.querySelector(".meridian-refusal")).toBeNull();
  });
});

describe("ArtifactsPanel — the disclosure", () => {
  it("holds the digest, the derivation link, and both wire maps", () => {
    const { container } = render(
      <ArtifactsPanel
        state={{
          kind: "listed",
          rows: [
            artifactRow({
              subject: "artifact-source",
              annotations: { producer: "codex" },
              metadata: { contentType: "text/plain" },
            }),
          ],
        }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    const disclosure = container.querySelector("details");
    expect(disclosure?.querySelector("summary")?.textContent).toBe("Digest and metadata");
    expect(container.textContent).toContain("sha256:3b1f0c");
    expect(container.textContent).toContain("artifact-source");
    expect(container.textContent).toContain("codex");
    expect(container.textContent).toContain("text/plain");
  });

  it("names a non-derivative rather than blanking the link", () => {
    const { container } = render(
      <ArtifactsPanel
        state={{ kind: "listed", rows: [artifactRow({ subject: undefined })] }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    expect(container.textContent).toContain("Not a derivative.");
  });
});
