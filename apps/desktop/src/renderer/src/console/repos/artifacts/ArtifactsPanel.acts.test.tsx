// The panel's act: what the re-read control does.
//
// What the panel draws before any press is `ArtifactsPanel.test.tsx`: the absences, the
// count, the row's face and the type filter. Every case here is about a control and the
// consequence it names.

import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { artifactRow } from "./artifacts.test-support.js";
import { ArtifactsPanel } from "./ArtifactsPanel.js";

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
    // The re-read is single-flight per row, so offering the control while that row's call
    // is outstanding would offer a second read of one manifest.
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
