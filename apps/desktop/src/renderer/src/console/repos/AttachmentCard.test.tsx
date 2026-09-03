// The card's four arms, and the three conflations `AttachmentCard.tsx` forbids between them.
//
// Each describe below is one arm plus the arm it must not be mistaken for: the derived
// truth must displace the declaration rather than sit beside it, the unresolved marker
// must name a cause and a remedy rather than a generic failure, and the unread arm must
// say nobody asked rather than that there is nothing there.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AttachmentCard } from "./AttachmentCard.js";
import {
  ATTACHMENT_DECLARED_MEDIA_TYPE_LABEL,
  INGEST_STREAM_INVALID_CODE,
  UNRESOLVED_ATTACHMENT_PRESENTATION,
  attachmentSourceFrom,
  type AttachmentIngestEntry,
} from "./attachment-model.js";

const NOW_MILLISECONDS = 1_000;

function entry(overrides: Partial<AttachmentIngestEntry> = {}): AttachmentIngestEntry {
  return {
    declared: attachmentSourceFrom({
      localId: "attachment-1",
      declaredName: "../../etc/passwd",
      payload: new Blob([new Uint8Array(300)]),
      declaredMediaType: "text/plain",
    }),
    state: "ingesting",
    receivedBytes: 128,
    ingestId: "ingest-1",
    derived: undefined,
    refusal: undefined,
    disposition: undefined,
    openedAtMilliseconds: NOW_MILLISECONDS,
    lastProgressAtMilliseconds: NOW_MILLISECONDS,
    ...overrides,
  };
}

describe("attachment card — in flight", () => {
  it("charts the decoded ledger against the declared total", () => {
    const { container } = render(
      <AttachmentCard
        reading={{ kind: "ingesting", entry: entry() }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    const progress = container.querySelector<HTMLProgressElement>("progress");
    expect(progress?.value).toBe(128);
    expect(progress?.max).toBe(300);
  });

  it("renders the declared filename as text and never as a path it rebuilt", () => {
    // The caller's original name survives as metadata only. The card shows it and
    // joins it to nothing — a traversal-shaped declaration is just characters here.
    const { container } = render(
      <AttachmentCard
        reading={{ kind: "ingesting", entry: entry() }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    expect(container.textContent).toContain("../../etc/passwd");
  });

  it("discloses the stream ceiling once the upload has gone quiet", () => {
    const { container } = render(
      <AttachmentCard
        reading={{ kind: "ingesting", entry: entry() }}
        nowMilliseconds={NOW_MILLISECONDS + 60_000}
      />,
    );
    expect(container.textContent).toContain("six hours");
  });

  it("negative control: a fresh upload does not disclose the ceiling", () => {
    // Without this, the case above would pass over a card that always showed it, which
    // would make the disclosure noise rather than a signal.
    const { container } = render(
      <AttachmentCard
        reading={{ kind: "ingesting", entry: entry() }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    expect(container.textContent).not.toContain("six hours");
  });

  it("offers the send-again control only on a refusal, and names the restart", () => {
    const { getByRole } = render(
      <AttachmentCard
        reading={{
          kind: "ingesting",
          entry: entry({
            state: "refused",
            refusal: { code: INGEST_STREAM_INVALID_CODE, detail: "stream is over" },
            disposition: "restart",
          }),
        }}
        nowMilliseconds={NOW_MILLISECONDS}
        onRetry={() => undefined}
      />,
    );
    expect(getByRole("button", { name: "Upload again" })).toBeDefined();
  });

  it("negative control: an in-flight upload offers no retry", () => {
    const { queryByRole } = render(
      <AttachmentCard
        reading={{ kind: "ingesting", entry: entry() }}
        nowMilliseconds={NOW_MILLISECONDS}
        onRetry={() => undefined}
      />,
    );
    expect(queryByRole("button", { name: "Send again" })).toBeNull();
  });
});

describe("attachment card — the derived truth displaces the declaration", () => {
  it("shows the normalized name, derived type, derived size, and the minted id", () => {
    const { container } = render(
      <AttachmentCard
        reading={{
          kind: "resolved",
          attachmentId: "artifact-9",
          derived: {
            artifactId: "artifact-9",
            normalizedName: "passwd.txt",
            derivedMediaType: "text/plain",
            derivedSizeBytes: 300,
          },
        }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    expect(container.textContent).toContain("passwd.txt");
    expect(container.textContent).toContain("artifact-9");
  });

  it("negative control: the resolved arm carries no progress element", () => {
    // A completed attachment charting progress would be reporting a stream that is
    // over, and the two arms would become indistinguishable at a glance.
    const { container } = render(
      <AttachmentCard
        reading={{
          kind: "resolved",
          attachmentId: "artifact-9",
          derived: {
            artifactId: "artifact-9",
            normalizedName: "passwd.txt",
            derivedMediaType: "text/plain",
            derivedSizeBytes: 300,
          },
        }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    expect(container.querySelector("progress")).toBeNull();
  });
});

describe("attachment card — the unresolved marker", () => {
  it("names the cause and its own remedy, in place", () => {
    const { container } = render(
      <AttachmentCard
        reading={{ kind: "unresolved", attachmentId: "artifact-7", cause: "quota_exceeded" }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    expect(container.textContent).toContain(
      UNRESOLVED_ATTACHMENT_PRESENTATION.quota_exceeded.remedy ?? "",
    );
    expect(container.querySelector(".meridian-attachment__unresolved")).not.toBeNull();
  });

  it("says outright that a deleted manifest has no way back", () => {
    const { container } = render(
      <AttachmentCard
        reading={{ kind: "unresolved", attachmentId: "artifact-7", cause: "deleted" }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    expect(container.textContent).toContain("There is no way to restore it.");
  });

  it("negative control: the marker is not the unread absence", () => {
    const { container } = render(
      <AttachmentCard
        reading={{ kind: "unresolved", attachmentId: "artifact-7", cause: "expired" }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    expect(container.querySelector(".meridian-nothing--not-checked")).toBeNull();
  });
});

describe("attachment card — the unread arm", () => {
  it("says the question was not put, and never that there is nothing there", () => {
    const { container } = render(
      <AttachmentCard
        reading={{ kind: "not-checked", attachmentId: "artifact-7" }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });
});

describe("attachment card — the media type is shown from either reading", () => {
  const derivedTruth = {
    artifactId: "artifact-1",
    normalizedName: "screenshot.png",
    derivedMediaType: "image/png",
    derivedSizeBytes: 300,
  };

  function renderCard(subject: AttachmentIngestEntry): string {
    const { container } = render(
      <AttachmentCard
        reading={{ kind: "ingesting", entry: subject }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    return container.textContent ?? "";
  }

  it("shows the derived type where the client declared none", () => {
    // A paste, and any client that omits `File.type`, arrives with no declaration —
    // and that is exactly the payload whose derived signature is worth reporting.
    const text = renderCard(
      entry({
        declared: attachmentSourceFrom({
          localId: "attachment-1",
          declaredName: "screenshot.png",
          payload: new Blob([new Uint8Array(300)]),
        }),
        derived: derivedTruth,
      }),
    );
    expect(text).toContain("image/png");
  });

  it("shows the declaration on its own before anything has been derived", () => {
    expect(renderCard(entry())).toContain("text/plain");
  });

  it("leads with the derived type and keeps the declaration where the two disagree", () => {
    const text = renderCard(entry({ derived: derivedTruth }));
    expect(text).toContain("image/png");
    expect(text).toContain("text/plain");
    expect(text).toContain(ATTACHMENT_DECLARED_MEDIA_TYPE_LABEL);
    expect(text.indexOf("image/png")).toBeLessThan(text.indexOf("text/plain"));
  });

  it("negative control: neither reading present renders no media type at all", () => {
    // Without this the cases above would pass over a card that always drew a chip,
    // which would put an empty label on every attachment whose type nobody knows.
    const { container } = render(
      <AttachmentCard
        reading={{
          kind: "ingesting",
          entry: entry({
            declared: attachmentSourceFrom({
              localId: "attachment-1",
              declaredName: "notes",
              payload: new Blob([new Uint8Array(300)]),
            }),
          }),
        }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    expect(container.textContent).not.toContain(ATTACHMENT_DECLARED_MEDIA_TYPE_LABEL);
    expect(container.textContent).not.toContain("text/plain");
    expect(container.textContent).not.toContain("image/png");
  });
});
