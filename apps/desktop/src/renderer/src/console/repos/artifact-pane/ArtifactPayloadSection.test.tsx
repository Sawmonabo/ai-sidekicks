// The artifact pane's payload section: what each arm of a fetched payload draws, and
// what the fetch control does while one is outstanding.
//
// MOUNTED THROUGH THE WHOLE PANE AND NEVER IN ISOLATION, because the section takes no
// props: it reads the pane's own reading, and a case that rendered it over a
// hand-written reading would be asserting against a stand-in for the half the fetch is
// meant to be correct against.
//
// The last block is the one a memo defeats. The reader used to be keyed on the bridge
// and the store alone, so a pane re-addressed to a second artifact kept the first
// one's payload arm — and the bytes of one artifact were drawn under another's header.

import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { growthUnavailable } from "../../bridge/index.js";
import { ManualClock } from "../../core/index.js";
import { ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP } from "./artifact-bounds.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { handAnsweredCall } from "../held-calls.test-support.js";
import { ArtifactPane } from "./ArtifactPane.js";
import {
  LISTED_ONE_ROW,
  SESSION_ID,
  artifactBridgeAnswering,
  inlineReadAnswering,
  readAnswering,
  readThrough,
  settleAct,
  type GrowthPortAnswer,
} from "./artifact-pane.test-support.js";
import {
  ARTIFACT_ENTITY,
  OTHER_ARTIFACT_ENTITY,
  confirmDelete,
  contextFor,
  renderPane,
  type ArtifactPaneContext,
} from "./artifact-pane-mount.test-support.js";
import { paneSubjectCrumb } from "../pane-chrome.test-support.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("artifact pane — fetching the payload is an act, and both arms are drawn", () => {
  it("asks for nothing until the control is pressed", async () => {
    // A payload is bounded only by the ingest cap, so a fetch that ran on mount would
    // spend a hundred megabytes of somebody's link on a pane they passed through.
    const artifactRead = vi.fn(async () => growthUnavailable("artifactRead"));
    const { paneClock } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({ listAnswer: LISTED_ONE_ROW, artifactRead }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough(paneClock);
    expect(artifactRead).not.toHaveBeenCalled();
  });

  it("asks the read for the bytes, by the member the wire discriminates on", async () => {
    const artifactRead = vi
      .fn<(request: unknown) => Promise<GrowthPortAnswer<"artifactRead">>>()
      .mockResolvedValue(readAnswering("published"));
    const { paneClock, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({ listAnswer: LISTED_ONE_ROW, artifactRead }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough(paneClock);
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();

    expect(artifactRead).toHaveBeenCalledWith({
      artifactId: ARTIFACT_ENTITY.id,
      includePayload: true,
    });
  });

  it("draws a deferred handle as what it is, and asks nothing further of it", async () => {
    const { paneClock, container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({
          listAnswer: LISTED_ONE_ROW,
          readAnswer: readAnswering("published"),
        }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough(paneClock);
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();

    const payload = container.querySelector(".meridian-artifact-payload");
    expect(payload?.textContent).toContain("sha256:2b4c/published");
    expect(payload?.textContent).toContain("no registered operation anywhere takes one");
  });

  it("previews inline bytes as text, decoding by the encoding the reply declared", async () => {
    const { paneClock, container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        // "diff --git a/one b/one" in RFC 4648 base64.
        bridge: artifactBridgeAnswering({
          listAnswer: LISTED_ONE_ROW,
          readAnswer: inlineReadAnswering("ZGlmZiAtLWdpdCBhL29uZSBiL29uZQ==", "base64"),
        }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough(paneClock);
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();

    expect(container.querySelector(".meridian-artifact-payload__preview")?.textContent).toBe(
      "diff --git a/one b/one",
    );
  });

  it("takes a utf8 payload as it stands, and truncates past the preview cap", async () => {
    const wide = "x".repeat(ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP + 50);
    const { paneClock, container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({
          listAnswer: LISTED_ONE_ROW,
          readAnswer: inlineReadAnswering(wide, "utf8"),
        }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough(paneClock);
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
    const { paneClock, container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        // Two bytes that are not valid UTF-8.
        bridge: artifactBridgeAnswering({
          listAnswer: LISTED_ONE_ROW,
          readAnswer: inlineReadAnswering("//8=", "base64"),
        }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough(paneClock);
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();

    expect(container.querySelector(".meridian-artifact-payload")?.textContent).toContain(
      "not text",
    );
    expect(container.querySelector(".meridian-artifact-payload__preview")).toBeNull();
  });

  it("renders the daemon's refusal when the fetch is turned down", async () => {
    const { paneClock, container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({ listAnswer: LISTED_ONE_ROW }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough(paneClock);
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();

    expect(container.querySelector(".meridian-artifact-payload")?.textContent).toContain(
      growthUnavailable("artifactRead").detail,
    );
  });

  it("holds the fetch control while one is outstanding, and gives it back when it settles", async () => {
    // A payload is bounded only by the ingest cap, so a second press before the first
    // settles is a second download of the same bytes — and the reader refuses it. The
    // control is held so a participant never meets that refusal by pressing something
    // the pane was offering, and the arm the reading is on is what holds it.
    const readCall = handAnsweredCall<GrowthPortAnswer<"artifactRead">>();
    const artifactRead = vi.fn(readCall.invoke);
    const { paneClock, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({ listAnswer: LISTED_ONE_ROW, artifactRead }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough(paneClock);
    const control = getByRole("button", { name: "Fetch payload" });
    fireEvent.click(control);
    await settleAct();

    expect(control).toHaveProperty("disabled", true);
    fireEvent.click(control);
    await settleAct();
    expect(artifactRead).toHaveBeenCalledTimes(1);

    readCall.open(readAnswering("published"));
    await settleAct();
    expect(control).toHaveProperty("disabled", false);
  });

  it("negative control: nothing is drawn before the fetch, and no old copy survives", async () => {
    const { paneClock, container } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({ listAnswer: LISTED_ONE_ROW }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough(paneClock);
    expect(container.querySelector(".meridian-artifact-payload")).toBeNull();
    // The sentence the pane used to close its header with, which said the members the
    // port now declares were unavailable.
    expect(container.textContent).not.toContain("which this console");
  });

  it("negative control: a refused delete leaves the row and renders the refusal", async () => {
    // Without this, a pane that removed the row optimistically would pass the case
    // above and still be wrong about every delete the daemon turns down.
    const artifactList = vi
      .fn<() => Promise<GrowthPortAnswer<"artifactList">>>()
      .mockResolvedValue(LISTED_ONE_ROW);
    const { paneClock, container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: artifactBridgeAnswering({ artifactList }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough(paneClock);
    confirmDelete(getByRole);
    await settleAct();

    const row = container.querySelector(".meridian-artifact-row") as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain("wire-unregistered");

    // And no re-read was asked for: nothing changed, so there is nothing to re-read.
    await readThrough(paneClock);
    expect(artifactList).toHaveBeenCalledTimes(1);
  });
});

describe("artifact pane — the reader is stamped to its subject", () => {
  /**
   * The same pane, re-addressed to another artifact in the same session.
   *
   * The bridge and the store are the SAME objects across both renders, which is the
   * whole point: the deck reuses a mounted pane, so the only thing that moved is the
   * address. A second `contextFor` call would mint a second store and remount the
   * reader for that reason instead, and the case would pass over the defect.
   */
  function reAddressed(context: ArtifactPaneContext): ArtifactPaneContext {
    return { ...context, entity: OTHER_ARTIFACT_ENTITY };
  }

  function renderReAddressed(
    context: ArtifactPaneContext,
    rerender: ReturnType<typeof render>["rerender"],
  ): void {
    rerender(
      <LiveAnnouncerProvider clock={new ManualClock()}>
        <ArtifactPane context={reAddressed(context)} />
      </LiveAnnouncerProvider>,
    );
  }

  it("does not render one artifact's fetched payload under another's header", async () => {
    // The bug, exercised: the memo keyed only on the bridge and the store, so the
    // reader survived the address change with its payload arm intact — and neither
    // the text nor the opaque arm draws an artifact id, so A's bytes were presented
    // as B's with nothing on screen to say otherwise.
    const context = contextFor(ARTIFACT_ENTITY, {
      // "diff --git a/one b/one" in RFC 4648 base64.
      bridge: artifactBridgeAnswering({
        listAnswer: LISTED_ONE_ROW,
        readAnswer: inlineReadAnswering("ZGlmZiAtLWdpdCBhL29uZSBiL29uZQ==", "base64"),
      }),
      sessionId: SESSION_ID,
    });
    const { paneClock, container, getByRole, rerender } = renderPane(context);
    await readThrough(paneClock);
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();
    expect(container.querySelector(".meridian-artifact-payload__preview")?.textContent).toBe(
      "diff --git a/one b/one",
    );

    renderReAddressed(context, rerender);
    await readThrough(paneClock);

    expect(paneSubjectCrumb(container)).toBe(OTHER_ARTIFACT_ENTITY.id);
    // `not-checked` renders no payload section at all, which is the honest absence
    // for a subject nobody has asked about — not an empty preview.
    expect(container.querySelector(".meridian-artifact-payload")).toBeNull();
  });

  it("does not hold the next subject's control with the previous subject's fetch", async () => {
    // The other half. The control is held by the `fetching` arm, and that arm belongs
    // to an artifact this pane is no longer addressed to — so a participant met a
    // disabled Fetch on a subject nothing had ever been asked about.
    const context = contextFor(ARTIFACT_ENTITY, {
      bridge: artifactBridgeAnswering({
        listAnswer: LISTED_ONE_ROW,
        // Never answers: the fetch stays on the wire for the rest of the case.
        artifactRead: () => new Promise<GrowthPortAnswer<"artifactRead">>(() => undefined),
      }),
      sessionId: SESSION_ID,
    });
    const { paneClock, getByRole, rerender } = renderPane(context);
    await readThrough(paneClock);
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();
    expect(getByRole("button", { name: "Fetch payload" }).hasAttribute("disabled")).toBe(true);

    renderReAddressed(context, rerender);
    await readThrough(paneClock);

    expect(getByRole("button", { name: "Fetch payload" }).hasAttribute("disabled")).toBe(false);
  });

  it("negative control: the same subject keeps its reader, its payload, and its reads", async () => {
    // Without this, a memo keyed on the address OBJECT would pass both cases above
    // and mint a reader — and a read pair — on every render the deck performs, which
    // is the cost the stamp is deliberately narrow to avoid.
    const artifactList = vi
      .fn<() => Promise<GrowthPortAnswer<"artifactList">>>()
      .mockResolvedValue(LISTED_ONE_ROW);
    const context = contextFor(ARTIFACT_ENTITY, {
      bridge: artifactBridgeAnswering({
        listAnswer: LISTED_ONE_ROW,
        artifactList,
        readAnswer: inlineReadAnswering("ZGlmZiAtLWdpdCBhL29uZSBiL29uZQ==", "base64"),
      }),
      sessionId: SESSION_ID,
    });
    const { paneClock, container, getByRole, rerender } = renderPane(context);
    await readThrough(paneClock);
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();

    rerender(
      <LiveAnnouncerProvider clock={new ManualClock()}>
        <ArtifactPane context={{ ...context }} />
      </LiveAnnouncerProvider>,
    );
    await readThrough(paneClock);

    expect(container.querySelector(".meridian-artifact-payload__preview")?.textContent).toBe(
      "diff --git a/one b/one",
    );
    expect(artifactList).toHaveBeenCalledTimes(1);
  });
});
