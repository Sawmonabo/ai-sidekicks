// The panel's act: what the re-read control does. What it draws before any press is
// `ArtifactsSection.test.tsx`.

import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { artifactRow } from "@test/helpers/artifact-summaries.js";
import { ArtifactsSection } from "./ArtifactsSection.js";

// Built rather than parsed, so the suite does not depend on `parseInstant`.
const NOW_MILLISECONDS = Date.UTC(2026, 0, 1, 9, 30, 0);

describe("ArtifactsSection — the acts", () => {
  it("offers only the acts the mount wired", () => {
    const { container } = render(
      <ArtifactsSection
        state={{ kind: "listed", rows: [artifactRow()] }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    const row = container.querySelector(".meridian-artifact-row");
    expect(row?.querySelectorAll("button")).toHaveLength(0);
  });

  it("asks for the manifest rather than rendering a payload", () => {
    // Payloads are explicit-fetch downloads: the control asks for what the registered read
    // answers with, the manifest.
    const onReadManifest = vi.fn();
    const { container } = render(
      <ArtifactsSection
        state={{ kind: "listed", rows: [artifactRow()] }}
        nowMilliseconds={NOW_MILLISECONDS}
        onReadManifest={onReadManifest}
      />,
    );
    fireEvent.click(within(container).getByRole("button", { name: "Read manifest" }));
    expect(onReadManifest).toHaveBeenCalledTimes(1);
  });

  it("holds the re-read control on a row whose read is on the wire", () => {
    // A control offered while the row's call is outstanding would send a second read.
    const { container } = render(
      <ArtifactsSection
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
    // Without this an always-disabled control would pass above, and a panel-wide register
    // would hold one row because another was waiting.
    const { container } = render(
      <ArtifactsSection
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
    // No registered reply member carries bytes or a handle, so a payload-fetch control would
    // promise a download nothing on this port can produce.
    const { queryByRole } = render(
      <ArtifactsSection
        state={{ kind: "listed", rows: [artifactRow()] }}
        nowMilliseconds={NOW_MILLISECONDS}
        onReadManifest={vi.fn()}
      />,
    );
    expect(queryByRole("button", { name: "Fetch payload" })).toBeNull();
  });
});

describe("ArtifactsSection — the disclosure", () => {
  it("holds the digest, the derivation link, and both wire maps", () => {
    const { container } = render(
      <ArtifactsSection
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
      <ArtifactsSection
        state={{ kind: "listed", rows: [artifactRow({ subject: undefined })] }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    expect(container.textContent).toContain("Not a derivative.");
  });
});
