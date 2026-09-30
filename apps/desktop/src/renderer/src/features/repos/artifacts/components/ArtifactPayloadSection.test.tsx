// The artifact payload section: a fetch is an act a person asks for, the bytes decode by the
// encoding the reply declared, one fetch is outstanding at a time, and a binding re-addressed to
// a second artifact does not keep the first artifact's payload. Mounted through the reader's own
// binding, not a hand-written reading.

import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArtifactReadResponse } from "@ai-sidekicks/contracts";
import { handAnsweredCall } from "@test/helpers/held-calls.js";
import {
  LISTED_ONE_ROW,
  artifactOperations,
  deferredRead,
  inlineRead,
  readThrough,
  settleAct,
} from "@test/helpers/artifact-list-readers.js";
import {
  OTHER_ARTIFACT_ID,
  OPENED_ARTIFACT_ID,
  artifactPayloadSubject,
  artifactPayloadTree,
  renderArtifactPayloadSection,
} from "@test/helpers/render-artifact-payload-section.js";

// "diff --git a/one b/one" in RFC 4648 base64.
const DIFF_PAYLOAD_BASE64 = "ZGlmZiAtLWdpdCBhL29uZSBiL29uZQ==";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("artifact payload — fetching is an act", () => {
  it("asks for nothing until the control is pressed", async () => {
    // A payload is bounded only by the ingest cap, so a fetch on mount would spend the user's
    // link on a section they merely passed through.
    const artifactRead = vi.fn(async () => deferredRead("published"));
    const subject = artifactPayloadSubject(
      artifactOperations({ listArtifacts: async () => LISTED_ONE_ROW, readArtifact: artifactRead }),
    );
    renderArtifactPayloadSection(subject);
    await readThrough(subject.clock);
    expect(artifactRead).not.toHaveBeenCalled();
  });

  it("asks the read for the bytes, by the member the wire discriminates on", async () => {
    const artifactRead = vi.fn(async () => deferredRead("published"));
    const subject = artifactPayloadSubject(
      artifactOperations({ listArtifacts: async () => LISTED_ONE_ROW, readArtifact: artifactRead }),
    );
    const { getByRole } = renderArtifactPayloadSection(subject);
    await readThrough(subject.clock);
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();

    expect(artifactRead).toHaveBeenCalledWith({
      artifactId: OPENED_ARTIFACT_ID,
      includePayload: true,
    });
  });

  it("previews inline bytes as text, decoding by the encoding the reply declared", async () => {
    const subject = artifactPayloadSubject(
      artifactOperations({
        listArtifacts: async () => LISTED_ONE_ROW,
        readArtifact: async () => inlineRead(DIFF_PAYLOAD_BASE64, "base64"),
      }),
    );
    const { container, getByRole } = renderArtifactPayloadSection(subject);
    await readThrough(subject.clock);
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();

    expect(container.querySelector(".meridian-artifact-payload__preview")?.textContent).toBe(
      "diff --git a/one b/one",
    );
  });

  it("reports bytes that are not text rather than drawing replacement characters", async () => {
    const subject = artifactPayloadSubject(
      artifactOperations({
        listArtifacts: async () => LISTED_ONE_ROW,
        // Two bytes that are not valid UTF-8.
        readArtifact: async () => inlineRead("//8=", "base64"),
      }),
    );
    const { container, getByRole } = renderArtifactPayloadSection(subject);
    await readThrough(subject.clock);
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();

    expect(container.querySelector(".meridian-artifact-payload")?.textContent).toContain(
      "not text",
    );
    expect(container.querySelector(".meridian-artifact-payload__preview")).toBeNull();
  });

  it("holds the fetch control while one is outstanding, and gives it back when it settles", async () => {
    // A payload is bounded only by the ingest cap, so a second press before the first settles
    // would download the same bytes twice; the arm the reading is on holds the control.
    const readCall = handAnsweredCall<ArtifactReadResponse>();
    const artifactRead = vi.fn(readCall.invoke);
    const subject = artifactPayloadSubject(
      artifactOperations({ listArtifacts: async () => LISTED_ONE_ROW, readArtifact: artifactRead }),
    );
    const { getByRole } = renderArtifactPayloadSection(subject);
    await readThrough(subject.clock);
    const control = getByRole("button", { name: "Fetch payload" });
    fireEvent.click(control);
    await settleAct();

    expect(control).toHaveProperty("disabled", true);
    fireEvent.click(control);
    await settleAct();
    expect(artifactRead).toHaveBeenCalledTimes(1);

    readCall.open(deferredRead("published"));
    await settleAct();
    expect(control).toHaveProperty("disabled", false);
  });
});

describe("artifact payload — the reader is stamped to its subject", () => {
  it("does not render one artifact's fetched payload under another's subject", async () => {
    // Neither arm draws an artifact id, so a reader keeping its payload arm across an address
    // change would present A's bytes as B's.
    const subject = artifactPayloadSubject(
      artifactOperations({
        listArtifacts: async () => LISTED_ONE_ROW,
        readArtifact: async () => inlineRead(DIFF_PAYLOAD_BASE64, "base64"),
      }),
    );
    const { container, getByRole, rerender } = renderArtifactPayloadSection(subject);
    await readThrough(subject.clock);
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();
    expect(container.querySelector(".meridian-artifact-payload__preview")?.textContent).toBe(
      "diff --git a/one b/one",
    );

    // The bridge, the store and the calls are the SAME objects across both renders: the
    // only thing that moved is the artifact, as when a section is reused for another artifact.
    rerender(artifactPayloadTree(subject, OTHER_ARTIFACT_ID));
    await readThrough(subject.clock);

    // No payload renders no payload section at all, which is the honest absence for a
    // subject nobody has asked about — not an empty preview.
    expect(container.querySelector(".meridian-artifact-payload")).toBeNull();
  });
});
