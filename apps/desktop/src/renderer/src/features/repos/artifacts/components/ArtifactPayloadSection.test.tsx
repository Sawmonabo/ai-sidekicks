// The artifact payload section: what each arm of a fetched payload draws, and what the
// fetch control does while one is outstanding.
//
// Mounted through the reader's own binding and never over a hand-written reading, so the
// section is asserted against the half the fetch is meant to be correct against.
//
// The last block covers the subject stamp: a binding re-addressed to a second artifact must
// not keep the first artifact's payload arm, or one artifact's bytes would be drawn under
// another's header.

import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArtifactReadResponse } from "@ai-sidekicks/contracts";
import { ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP } from "@renderer/store/artifacts/artifact-payload.js";
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
  OTHER_HOSTED_ARTIFACT_ID,
  HOSTED_ARTIFACT_ID,
  hostSubject,
  hostTree,
  renderHost,
} from "./artifact-payload-section.test-support.js";

// "diff --git a/one b/one" in RFC 4648 base64.
const DIFF_PAYLOAD_BASE64 = "ZGlmZiAtLWdpdCBhL29uZSBiL29uZQ==";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("artifact payload — fetching is an act, and every arm is drawn", () => {
  it("asks for nothing until the control is pressed", async () => {
    // A payload is bounded only by the ingest cap, so a fetch that ran on mount would
    // spend a hundred megabytes of somebody's link on a pane they passed through.
    const artifactRead = vi.fn(async () => deferredRead("published"));
    const subject = hostSubject(
      artifactOperations({ listArtifacts: async () => LISTED_ONE_ROW, readArtifact: artifactRead }),
    );
    renderHost(subject);
    await readThrough(subject.clock);
    expect(artifactRead).not.toHaveBeenCalled();
  });

  it("asks the read for the bytes, by the member the wire discriminates on", async () => {
    const artifactRead = vi.fn(async () => deferredRead("published"));
    const subject = hostSubject(
      artifactOperations({ listArtifacts: async () => LISTED_ONE_ROW, readArtifact: artifactRead }),
    );
    const { getByRole } = renderHost(subject);
    await readThrough(subject.clock);
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();

    expect(artifactRead).toHaveBeenCalledWith({
      artifactId: HOSTED_ARTIFACT_ID,
      includePayload: true,
    });
  });

  it("draws a deferred handle as what it is", async () => {
    const subject = hostSubject(
      artifactOperations({
        listArtifacts: async () => LISTED_ONE_ROW,
        readArtifact: async () => deferredRead("published"),
      }),
    );
    const { container, getByRole } = renderHost(subject);
    await readThrough(subject.clock);
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();

    expect(container.querySelector(".meridian-artifact-payload")?.textContent).toContain(
      "sha256:2b4c/published",
    );
  });

  it("previews inline bytes as text, decoding by the encoding the reply declared", async () => {
    const subject = hostSubject(
      artifactOperations({
        listArtifacts: async () => LISTED_ONE_ROW,
        readArtifact: async () => inlineRead(DIFF_PAYLOAD_BASE64, "base64"),
      }),
    );
    const { container, getByRole } = renderHost(subject);
    await readThrough(subject.clock);
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();

    expect(container.querySelector(".meridian-artifact-payload__preview")?.textContent).toBe(
      "diff --git a/one b/one",
    );
  });

  it("takes a utf8 payload as it stands, and truncates past the preview cap", async () => {
    const wide = "x".repeat(ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP + 50);
    const subject = hostSubject(
      artifactOperations({
        listArtifacts: async () => LISTED_ONE_ROW,
        readArtifact: async () => inlineRead(wide, "utf8"),
      }),
    );
    const { container, getByRole } = renderHost(subject);
    await readThrough(subject.clock);
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();

    const preview = container.querySelector(".meridian-artifact-payload__preview");
    expect(preview?.textContent).toHaveLength(ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP);
    // Never silently shortened: the truncation is stated beside what was drawn.
    expect(container.querySelector(".meridian-artifact-payload")?.textContent).toContain(
      "continues past them",
    );
  });

  it("reports bytes that are not text rather than drawing replacement characters", async () => {
    const subject = hostSubject(
      artifactOperations({
        listArtifacts: async () => LISTED_ONE_ROW,
        // Two bytes that are not valid UTF-8.
        readArtifact: async () => inlineRead("//8=", "base64"),
      }),
    );
    const { container, getByRole } = renderHost(subject);
    await readThrough(subject.clock);
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();

    expect(container.querySelector(".meridian-artifact-payload")?.textContent).toContain(
      "not text",
    );
    expect(container.querySelector(".meridian-artifact-payload__preview")).toBeNull();
  });

  it("holds the fetch control while one is outstanding, and gives it back when it settles", async () => {
    // A payload is bounded only by the ingest cap, so a second press before the first
    // settles would be a second download of the same bytes. The arm the reading is on holds
    // the control, so a second press is never offered.
    const readCall = handAnsweredCall<ArtifactReadResponse>();
    const artifactRead = vi.fn(readCall.invoke);
    const subject = hostSubject(
      artifactOperations({ listArtifacts: async () => LISTED_ONE_ROW, readArtifact: artifactRead }),
    );
    const { getByRole } = renderHost(subject);
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

  it("negative control: nothing is drawn before the fetch", async () => {
    const subject = hostSubject(artifactOperations({ listArtifacts: async () => LISTED_ONE_ROW }));
    const { container } = renderHost(subject);
    await readThrough(subject.clock);
    expect(container.querySelector(".meridian-artifact-payload")).toBeNull();
  });
});

describe("artifact payload — the reader is stamped to its subject", () => {
  it("does not render one artifact's fetched payload under another's subject", async () => {
    // Neither the text nor the opaque arm draws an artifact id, so a reader that survived
    // the address change with its payload arm intact would present A's bytes as B's with
    // nothing on screen to say otherwise.
    const subject = hostSubject(
      artifactOperations({
        listArtifacts: async () => LISTED_ONE_ROW,
        readArtifact: async () => inlineRead(DIFF_PAYLOAD_BASE64, "base64"),
      }),
    );
    const { container, getByRole, rerender } = renderHost(subject);
    await readThrough(subject.clock);
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();
    expect(container.querySelector(".meridian-artifact-payload__preview")?.textContent).toBe(
      "diff --git a/one b/one",
    );

    // The bridge, the store and the calls are the SAME objects across both renders: the
    // only thing that moved is the artifact, as when a surface is reused for another artifact.
    rerender(hostTree(subject, OTHER_HOSTED_ARTIFACT_ID));
    await readThrough(subject.clock);

    // No payload renders no payload section at all, which is the honest absence for a
    // subject nobody has asked about — not an empty preview.
    expect(container.querySelector(".meridian-artifact-payload")).toBeNull();
  });

  it("does not hold the next subject's control with the previous subject's fetch", async () => {
    // The other half. The control is held by the `fetching` arm, and that arm belongs
    // to an artifact this binding is no longer addressed to — so a user met a
    // disabled Fetch on a subject nothing had ever been asked about.
    const subject = hostSubject(
      artifactOperations({
        listArtifacts: async () => LISTED_ONE_ROW,
        // Never answers: the fetch stays on the wire for the rest of the case.
        readArtifact: () => new Promise<ArtifactReadResponse>(() => undefined),
      }),
    );
    const { getByRole, rerender } = renderHost(subject);
    await readThrough(subject.clock);
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();
    expect(getByRole("button", { name: "Fetch payload" }).hasAttribute("disabled")).toBe(true);

    rerender(hostTree(subject, OTHER_HOSTED_ARTIFACT_ID));
    await readThrough(subject.clock);

    expect(getByRole("button", { name: "Fetch payload" }).hasAttribute("disabled")).toBe(false);
  });

  it("negative control: the same subject keeps its reader, its payload, and its reads", async () => {
    // Without this, a memo keyed on the address OBJECT would pass both cases above
    // and mint a reader — and a read — on every render a surface performs, which
    // is the cost the stamp is deliberately narrow to avoid.
    const artifactList = vi.fn(async () => LISTED_ONE_ROW);
    const subject = hostSubject(
      artifactOperations({
        listArtifacts: artifactList,
        readArtifact: async () => inlineRead(DIFF_PAYLOAD_BASE64, "base64"),
      }),
    );
    const { container, getByRole, rerender } = renderHost(subject);
    await readThrough(subject.clock);
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();

    rerender(hostTree(subject));
    await readThrough(subject.clock);

    expect(container.querySelector(".meridian-artifact-payload__preview")?.textContent).toBe(
      "diff --git a/one b/one",
    );
    expect(artifactList).toHaveBeenCalledTimes(1);
  });
});
