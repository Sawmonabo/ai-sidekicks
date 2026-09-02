// What the artifacts panel renders on each of its four arms, what it offers, and
// the two things it must never do.

import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  REPOS_IMPLEMENTER_RUN_ID,
  REPOS_SESSION_ID,
  REPOS_VIEWING_PARTICIPANT_ID,
} from "../bridge/scenarios/repos.js";
import { refuse } from "../core/index.js";
import { formatByteQuantity, formatCount } from "../primitives/index.js";
import { ArtifactsPanel } from "./ArtifactsPanel.js";
import {
  ARTIFACT_DELETE_CONSEQUENCE,
  ARTIFACT_PAYLOAD_DISPOSITION_COPY,
  ARTIFACT_REPLICATION_PRESENTATION,
  type ArtifactManifestRow,
} from "./artifact-model.js";

const NOW_MILLISECONDS = Date.parse("2026-01-01T09:30:00.000Z");

function artifactRow(overrides: Partial<ArtifactManifestRow> = {}): ArtifactManifestRow {
  return {
    id: "artifact-01",
    sessionId: REPOS_SESSION_ID,
    runId: REPOS_IMPLEMENTER_RUN_ID,
    createdBy: REPOS_VIEWING_PARTICIPANT_ID,
    artifactType: "file",
    digest: "sha256:3b1f0c",
    size: 4096,
    annotations: {},
    visibility: "local-only",
    state: "published",
    metadata: {},
    createdAt: "2026-01-01T09:00:00.000Z",
    ...overrides,
  };
}

describe("ArtifactsPanel — the four arms are four different absences", () => {
  it("says nobody asked, before anything was read", () => {
    const { container } = render(
      <ArtifactsPanel state={{ kind: "not-checked" }} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    expect(container.textContent).toContain("have not been read");
  });

  it("says the read found none, when it did", () => {
    const { container } = render(
      <ArtifactsPanel state={{ kind: "listed", rows: [] }} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    expect(container.textContent).toContain("No artifacts.");
    // The panel teaches the next move rather than offering a publish control it
    // does not have: V1 artifacts come from runs and ingest.
    expect(container.textContent).toContain("produced by runs and by ingest");
  });

  it("negative control: the unread arm and the empty arm are not the same sentence", () => {
    // Conflating them would report the console's silence as the daemon's answer,
    // and each arm's next move is different.
    const unread = render(
      <ArtifactsPanel state={{ kind: "not-checked" }} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    const empty = render(
      <ArtifactsPanel state={{ kind: "listed", rows: [] }} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    expect(unread.container.textContent).not.toContain("No artifacts.");
    expect(empty.container.textContent).not.toContain("have not been read");
  });

  it("renders the daemon's own refusal, verbatim, when the read was refused", () => {
    const refusal = refuse(
      "growth-port",
      "wire-unregistered",
      "Not checked — artifact.list is not registered yet.",
    );
    const { container } = render(
      <ArtifactsPanel state={{ kind: "refused", refusal }} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    expect(container.textContent).toContain(refusal.code);
    expect(container.textContent).toContain(refusal.detail);
  });

  it("shows a read in flight without asserting a result", () => {
    const { container } = render(
      <ArtifactsPanel state={{ kind: "loading" }} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.textContent).not.toContain("No artifacts.");
  });
});

describe("ArtifactsPanel — the row's face", () => {
  it("carries type, state, visibility, size, producer, and replication status", () => {
    const row = artifactRow({ replicationStatus: "over_cap", visibility: "shared" });
    const { container } = render(
      <ArtifactsPanel state={{ kind: "listed", rows: [row] }} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    expect(container.textContent).toContain("file");
    expect(container.textContent).toContain("published");
    expect(container.textContent).toContain("shared");
    expect(container.textContent).toContain(formatByteQuantity(row.size).text);
    expect(container.textContent).toContain(REPOS_VIEWING_PARTICIPANT_ID);
    expect(container.textContent).toContain(ARTIFACT_REPLICATION_PRESENTATION.over_cap.meaning);
  });

  it("keeps the exact byte count beside the scaled reading of it", () => {
    const { container } = render(
      <ArtifactsPanel
        state={{ kind: "listed", rows: [artifactRow({ size: 4096 })] }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    expect(container.querySelector('[title="4096"]')).not.toBeNull();
  });

  it("keeps a superseded row visible as history", () => {
    const { container } = render(
      <ArtifactsPanel
        state={{ kind: "listed", rows: [artifactRow({ state: "superseded" })] }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    expect(container.querySelectorAll(".meridian-artifact-row")).toHaveLength(1);
    expect(container.textContent).toContain("superseded");
  });
});

describe("ArtifactsPanel — the type filter is one filter over one list", () => {
  const rows = [
    artifactRow({ id: "a", artifactType: "file" }),
    artifactRow({ id: "b", artifactType: "diff" }),
  ];

  it("offers every type, including the ones at zero", () => {
    const { container } = render(
      <ArtifactsPanel state={{ kind: "listed", rows }} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    const filter = within(container).getByRole("group", { name: "Filter by artifact type" });
    // Seven: the six types plus the member that selects them all.
    expect(within(filter).getAllByRole("button")).toHaveLength(7);
    expect(filter.textContent).toContain("workflow_output");
  });

  it("narrows the list when a type is pressed", () => {
    const { container } = render(
      <ArtifactsPanel state={{ kind: "listed", rows }} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    expect(container.querySelectorAll(".meridian-artifact-row")).toHaveLength(2);
    const filter = within(container).getByRole("group", { name: "Filter by artifact type" });
    fireEvent.click(within(filter).getByText("diff"));
    expect(container.querySelectorAll(".meridian-artifact-row")).toHaveLength(1);
  });

  it("says the FILTER matched nothing, not that the session has nothing", () => {
    // The read served two artifacts. A panel that branched on the rows the filter
    // kept reported "No artifacts." here — the console's own voice stating that a
    // non-empty session is empty, and hiding that the filter is what has no matches.
    const { container } = render(
      <ArtifactsPanel state={{ kind: "listed", rows }} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    const filter = within(container).getByRole("group", { name: "Filter by artifact type" });
    fireEvent.click(within(filter).getByText("summary"));
    expect(container.querySelectorAll(".meridian-artifact-row")).toHaveLength(0);

    const body = container.querySelector(".meridian-artifacts__body");
    expect(body?.textContent).toContain("No artifacts of the type this filter is set to");
    // The type it is set to, and how many rows of other types it is hiding.
    expect(body?.textContent).toContain("summary");
    expect(body?.textContent).toContain(formatCount(rows.length));
    expect(body?.textContent).not.toContain("No artifacts.");
    expect(body?.textContent).not.toContain("produced by runs and by ingest");
  });

  it("negative control: the session-empty copy survives, on the arm that earns it", () => {
    // The other side of the same branch. A fix that routed every empty body through
    // the filter-scoped sentence would leave a read that genuinely found none with
    // no way to say so, and would name a filter the participant never touched.
    const { container } = render(
      <ArtifactsPanel state={{ kind: "listed", rows: [] }} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    const body = container.querySelector(".meridian-artifacts__body");
    expect(body?.textContent).toContain("No artifacts.");
    expect(body?.textContent).toContain("produced by runs and by ingest");
    expect(body?.textContent).not.toContain("this filter is set to");
  });

  it("negative control: a filter that matches keeps rendering the list", () => {
    const { container } = render(
      <ArtifactsPanel state={{ kind: "listed", rows }} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    const filter = within(container).getByRole("group", { name: "Filter by artifact type" });
    fireEvent.click(within(filter).getByText("file"));
    expect(container.querySelectorAll(".meridian-artifact-row")).toHaveLength(1);
    const body = container.querySelector(".meridian-artifacts__body");
    expect(body?.textContent).not.toContain("this filter is set to");
  });
});

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
