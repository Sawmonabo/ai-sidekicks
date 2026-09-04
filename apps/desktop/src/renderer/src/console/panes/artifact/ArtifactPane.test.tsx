// The artifact pane: its chrome, the absence it renders before a read, the two
// disclosures `ArtifactPane.tsx` puts at its foot, and what its row acts actually do.
//
// The case that matters most in the first block is the last one: `empty` here would be
// the console stating that the session has no artifacts, a fact no read established.
// The bounds block is about the disclosure whose whole value is that it names WHICH
// list it is showing — the shipped default and the deployment's effective list are
// different claims and an operator override replaces one with the other wholesale.
//
// The acts block is the one that fails on a pane that discards what it is served. The
// read used to be called "Fetch payload" and used to throw its answer away, so pressing
// it changed nothing at all — no row, no sentence, no refusal. Both halves are checked
// here: the control is named for the manifest the read serves, and a served answer
// reaches the row.

import { act, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsoleBridge } from "../../bridge/index.js";
import {
  ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP,
  ManualClock,
  REFRESH_DEBOUNCE_MS,
} from "../../core/index.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { ARTIFACT_PAYLOAD_DISPOSITION_COPY } from "../../repos/artifact-model.js";
import { ATTACHMENT_ALLOWLIST_DEFAULT } from "../../repos/attachment-model.js";
import { SessionStore } from "../../store/index.js";
import { ArtifactPane, type ArtifactPaneProps } from "./ArtifactPane.js";

/** This pane's own address arm, taken from the prop rather than restated. */
type ArtifactPaneContext = ArtifactPaneProps["context"];

/**
 * A pane context whose collaborators are never reached — `legacy-surfaces.test.ts`'s
 * cast, for its reason: the assertions are about what the address renders as. The
 * blocks that press a control pass a bridge and a session and reach both. The ADDRESS
 * half is not cast — the entity parameter is the arm's own, so a case handing this
 * pane a subject an artifact pane is never opened over fails to compile here.
 */
function contextFor(
  entity: ArtifactPaneContext["entity"],
  reached: { readonly bridge?: ConsoleBridge; readonly sessionId?: string } = {},
): ArtifactPaneContext {
  return {
    kind: "artifact",
    entity,
    paneId: "pane-artifact-1",
    bridge: reached.bridge,
    // A REAL store rather than a stub carrying an id: the reader now subscribes to it
    // for three of its four refresh reasons, and a stub with no `readable` would make
    // every case here fail on the subscription rather than on what it asserts.
    sessionStore:
      reached.sessionId === undefined
        ? undefined
        : new SessionStore({ sessionId: reached.sessionId }),
  } as unknown as ArtifactPaneContext;
}

const ARTIFACT_ENTITY = { kind: "artifact", id: "artifact-diff-01" } as const;
const OTHER_ARTIFACT_ENTITY = { kind: "artifact", id: "artifact-attachment-02" } as const;

const SESSION_ID = "019b7b30-0280-7c11-8420-b1a5c0de2200";
const ARTIFACT_ID = "019b7b30-0280-7c11-8420-b1a5c0de2201";

/** One served manifest summary, with the one member each case varies spelled out. */
function summary(state: string): Record<string, unknown> {
  return {
    artifactId: ARTIFACT_ID,
    sessionId: SESSION_ID,
    artifactType: "diff",
    digest: "sha256:2b4c",
    size: 4096,
    annotations: {},
    visibility: "shared",
    state,
    metadata: {},
    createdAt: "2026-09-02T07:00:00.000Z",
  };
}

const PORT_REFUSAL = {
  status: "unavailable",
  code: "wire-unregistered",
  detail: "Not checked — the artifact CRUD method strings are not registered yet.",
  origin: "growth-port",
};

const LISTED_ONE_ROW = { status: "served", value: [summary("published")] };

/**
 * One served READ, which is a manifest plus a way to reach the bytes.
 *
 * The reply NESTS the envelope rather than being it — a read carries the manifest
 * beside a payload handle — so a case that answered with a bare summary would be
 * scripting a shape the port never sends and this pane would compile against it. On
 * the DEFERRED arm, which is what a metadata read lands on.
 */
function readAnswering(state: string): Record<string, unknown> {
  return {
    status: "served",
    value: { manifest: summary(state), payloadHandle: `sha256:2b4c/${state}` },
  };
}

/** The receipt a served delete answers with. Every member required, so all are here. */
const DELETE_RECEIPT = {
  status: "served",
  value: {
    artifactId: ARTIFACT_ID,
    payloadDisposition: "retained_by_references",
    rePublishForeclosed: true,
    deletedAt: "2026-09-02T07:05:00.000Z",
  },
};

/** A served payload read on the INLINE arm, with the bytes and the encoding to read them by. */
function inlineReadAnswering(payload: string, encoding: string): Record<string, unknown> {
  return {
    status: "served",
    value: { manifest: summary("published"), payload, payloadEncoding: encoding },
  };
}

interface ActScript {
  readonly readAnswer?: unknown;
  readonly deleteAnswer?: unknown;
  /** Supplied where a case counts the list reads or varies them between reads. */
  readonly artifactList?: () => Promise<unknown>;
}

/** A bridge that lists one published row and answers the acts as the case scripts. */
function bridgeListing(script: ActScript): ConsoleBridge {
  return {
    growth: {
      artifactList: script.artifactList ?? (async () => LISTED_ONE_ROW),
      artifactAllowlistRead: async () => PORT_REFUSAL,
      artifactRead: async () => script.readAnswer ?? PORT_REFUSAL,
      artifactDelete: async () => script.deleteAnswer ?? PORT_REFUSAL,
    },
  } as unknown as ConsoleBridge;
}

/** The delete confirm is two steps in place; both are pressed here. */
function confirmDelete(getByRole: ReturnType<typeof render>["getByRole"]): void {
  fireEvent.click(getByRole("button", { name: "Delete" }));
  fireEvent.click(getByRole("button", { name: "Delete permanently" }));
}

function renderPane(context: ArtifactPaneContext): ReturnType<typeof render> {
  // The announcer is the pane's environment rather than its dependency, and it runs
  // on a frozen clock so a settlement sentence stands until the case reads it.
  return render(
    <LiveAnnouncerProvider clock={new ManualClock()}>
      <ArtifactPane context={context} />
    </LiveAnnouncerProvider>,
  );
}

/** Let the scheduler's coalescing window elapse, then let the read's awaits run. */
async function readThrough(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS);
  });
}

/** Let an act's promise and the publish it causes settle. */
async function settleAct(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("artifact pane — chrome", () => {
  it("names itself as a region", () => {
    const { getByRole } = renderPane(contextFor(ARTIFACT_ENTITY));
    expect(getByRole("region", { name: "Artifact" })).toBeDefined();
  });

  it("renders the subject verbatim, with the full string recoverable", () => {
    const { container } = renderPane(contextFor(ARTIFACT_ENTITY));
    const subject = container.querySelector(".meridian-repos-pane__subject");
    expect(subject?.textContent).toBe(ARTIFACT_ENTITY.id);
    expect(subject?.getAttribute("title")).toBe(ARTIFACT_ENTITY.id);
  });

  it("negative control: the subject is read from the address, not fixed", () => {
    // Without this, the case above would pass over a chrome that rendered a constant.
    // An artifact address always carries its artifact — the arm has no shape in which
    // it is absent — so the honest control is a second subject rather than none.
    const { container } = renderPane(contextFor(OTHER_ARTIFACT_ENTITY));
    const subject = container.querySelector(".meridian-repos-pane__subject");
    expect(subject?.textContent).toBe(OTHER_ARTIFACT_ENTITY.id);
    expect(subject?.getAttribute("title")).toBe(OTHER_ARTIFACT_ENTITY.id);
  });

  it("offers one re-read control, keyboard-reachable and named", () => {
    const { getByRole } = renderPane(contextFor(ARTIFACT_ENTITY));
    expect(getByRole("button", { name: "Read again" })).toBeDefined();
  });

  it("names the reply members a payload fetch is waiting on", () => {
    // The read serves a manifest. Saying so beside the control is what keeps a
    // participant from waiting for a download that no registered reply carries.
    const { container } = renderPane(contextFor(ARTIFACT_ENTITY));
    const note = container.querySelector(".meridian-artifact-pane__read-scope-note");
    expect(note?.textContent).toContain("payloadHandle");
    expect(note?.textContent).toContain("payload");
  });
});

describe("artifact pane — the absence it renders", () => {
  it("says the question was not put, on a surface", () => {
    const { container } = renderPane(contextFor(ARTIFACT_ENTITY));
    const nothing = container.querySelector(".meridian-nothing");
    expect(nothing?.classList.contains("meridian-nothing--not-checked")).toBe(true);
    expect(nothing?.classList.contains("meridian-nothing--block")).toBe(true);
  });

  it("negative control: it is not the empty shape", () => {
    // `empty` would assert that the session's artifact read came back with none.
    // Nothing has been read, and the two absences render as different shapes.
    const { container } = renderPane(contextFor(ARTIFACT_ENTITY));
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });
});

describe("artifact pane — the ingest bounds disclosure", () => {
  it("names the shipped default as the default when the effective list is unread", () => {
    const { container } = renderPane(contextFor(ARTIFACT_ENTITY));
    const source = container.querySelector(".meridian-ingest-bounds__source");
    expect(source?.textContent).toContain("shipped default");
  });

  it("lists the admitted types and leaves out the scriptable image", () => {
    const { container } = renderPane(contextFor(ARTIFACT_ENTITY));
    const types = container.querySelector(".meridian-ingest-bounds__types");
    expect(types?.textContent).toContain("application/pdf");
    expect(types?.textContent).not.toContain("image/svg+xml");
    expect(container.querySelectorAll(".meridian-ingest-bounds__types li")).toHaveLength(
      ATTACHMENT_ALLOWLIST_DEFAULT.length,
    );
  });

  it("names all four bounds a participant can hit", () => {
    const { container } = renderPane(contextFor(ARTIFACT_ENTITY));
    const caps = container.querySelector(".meridian-ingest-bounds__caps");
    expect(caps?.textContent).toContain("Per attachment");
    expect(caps?.textContent).toContain("Per carrier");
    expect(caps?.textContent).toContain("Per chunk");
    expect(caps?.textContent).toContain("Per upload");
  });

  it("renders a refusal that carries no served discriminant, and reads the list beside it", async () => {
    // THE SHAPE THAT TOOK THE WHOLE PANE DOWN. `core`'s `refuse(...)` is the console's
    // three refusal fields and no `status` — the value `growthUnavailable` spreads to
    // build its own — and a reader that asked only whether `status` was
    // `"unavailable"` read it as served, dereferenced it for `contentTypes`, and
    // published a `read-threw` refusal whose sentence was a `TypeError`. So both
    // halves are asserted: the disclosure shows the refusal on its designed
    // shipped-default arm, and the list beside it still read.
    const { container } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: {
          growth: {
            artifactList: async () => LISTED_ONE_ROW,
            artifactAllowlistRead: async () => ({
              code: "wire-unregistered",
              detail: "Not checked — the artifact CRUD method strings are not registered yet.",
              origin: "growth-port",
            }),
          },
        } as unknown as ConsoleBridge,
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
    expect(container.querySelector(".meridian-ingest-bounds__source")?.textContent).toContain(
      "shipped default",
    );
    expect(container.querySelector(".meridian-ingest-bounds__refusal")?.textContent).toContain(
      "wire-unregistered",
    );
    expect(container.textContent).not.toContain("read-threw");
    expect(container.textContent).not.toContain("contentTypes");
  });

  it("negative control: the pane offers no visibility toggle", () => {
    // The wire carries an `artifact.visibility_updated` event and
    // `bridge/growth-port.ts` registers no operation that could produce one. A
    // control that could only fail is worse than a control that is not there, and a
    // port entry is not this family's to add.
    const { queryByRole } = renderPane(contextFor(ARTIFACT_ENTITY));
    expect(queryByRole("button", { name: "Share with the session" })).toBeNull();
    expect(queryByRole("button", { name: "Make local-only" })).toBeNull();
  });
});

describe("artifact pane — reading one row's manifest", () => {
  it("offers the row's manifest re-read beside the pane's own payload fetch", async () => {
    // Two acts over one method, told apart by `includePayload`. The row's control is
    // named for what its read serves; the pane's is named for the bytes it asks for.
    const { getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, { bridge: bridgeListing({}), sessionId: SESSION_ID }),
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
        bridge: bridgeListing({
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
        bridge: bridgeListing({
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
      contextFor(ARTIFACT_ENTITY, { bridge: bridgeListing({}), sessionId: SESSION_ID }),
    );
    await readThrough();
    fireEvent.click(getByRole("button", { name: "Read manifest" }));
    await settleAct();

    const row = container.querySelector(".meridian-artifact-row") as HTMLElement;
    expect(row.textContent).toContain("wire-unregistered");
    expect(within(row).getByText("published")).toBeDefined();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "the artifact CRUD method strings are not registered yet",
    );
  });

  it("negative control: a re-render on its own announces nothing", async () => {
    // The sentence belongs to the act's settlement. A pane that announced from a
    // render body would speak again on every unrelated transition. The same bridge
    // and session are handed back, so the reader is the one that already read and
    // this is a re-render rather than a remount.
    const bridge = bridgeListing({});
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
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(LISTED_ONE_ROW)
      .mockResolvedValue({ status: "served", value: [] });
    const { container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: bridgeListing({
          artifactList,
          deleteAnswer: DELETE_RECEIPT,
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
        bridge: bridgeListing({ deleteAnswer: DELETE_RECEIPT }),
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
        bridge: bridgeListing({ deleteAnswer: DELETE_RECEIPT }),
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
    const artifactList = vi.fn<() => Promise<unknown>>().mockResolvedValue(LISTED_ONE_ROW);
    const { container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: bridgeListing({ artifactList, deleteAnswer: DELETE_RECEIPT }),
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

describe("artifact pane — fetching the payload is an act, and both arms are drawn", () => {
  it("asks for nothing until the control is pressed", async () => {
    // A payload is bounded only by the ingest cap, so a fetch that ran on mount would
    // spend a hundred megabytes of somebody's link on a pane they passed through.
    const artifactRead = vi.fn<() => Promise<unknown>>().mockResolvedValue(PORT_REFUSAL);
    renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: {
          growth: {
            artifactList: async () => LISTED_ONE_ROW,
            artifactAllowlistRead: async () => PORT_REFUSAL,
            artifactRead,
            artifactDelete: async () => PORT_REFUSAL,
          },
        } as unknown as ConsoleBridge,
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
    expect(artifactRead).not.toHaveBeenCalled();
  });

  it("asks the read for the bytes, by the member the wire discriminates on", async () => {
    const artifactRead = vi
      .fn<(request: { readonly includePayload?: boolean }) => Promise<unknown>>()
      .mockResolvedValue(readAnswering("published"));
    const { getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: {
          growth: {
            artifactList: async () => LISTED_ONE_ROW,
            artifactAllowlistRead: async () => PORT_REFUSAL,
            artifactRead,
            artifactDelete: async () => PORT_REFUSAL,
          },
        } as unknown as ConsoleBridge,
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();

    expect(artifactRead).toHaveBeenCalledWith({
      artifactId: ARTIFACT_ENTITY.id,
      includePayload: true,
    });
  });

  it("draws a deferred handle as what it is, and asks nothing further of it", async () => {
    const { container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: bridgeListing({ readAnswer: readAnswering("published") }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();

    const payload = container.querySelector(".meridian-artifact-payload");
    expect(payload?.textContent).toContain("sha256:2b4c/published");
    expect(payload?.textContent).toContain("no registered operation anywhere takes one");
  });

  it("previews inline bytes as text, decoding by the encoding the reply declared", async () => {
    const { container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        // "diff --git a/one b/one" in RFC 4648 base64.
        bridge: bridgeListing({
          readAnswer: inlineReadAnswering("ZGlmZiAtLWdpdCBhL29uZSBiL29uZQ==", "base64"),
        }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();

    expect(container.querySelector(".meridian-artifact-payload__preview")?.textContent).toBe(
      "diff --git a/one b/one",
    );
  });

  it("takes a utf8 payload as it stands, and truncates past the preview cap", async () => {
    const wide = "x".repeat(ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP + 50);
    const { container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: bridgeListing({ readAnswer: inlineReadAnswering(wide, "utf8") }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
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
    const { container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        // Two bytes that are not valid UTF-8.
        bridge: bridgeListing({ readAnswer: inlineReadAnswering("//8=", "base64") }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();

    expect(container.querySelector(".meridian-artifact-payload")?.textContent).toContain(
      "not text",
    );
    expect(container.querySelector(".meridian-artifact-payload__preview")).toBeNull();
  });

  it("renders the daemon's refusal when the fetch is turned down", async () => {
    const { container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, { bridge: bridgeListing({}), sessionId: SESSION_ID }),
    );
    await readThrough();
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();

    expect(container.querySelector(".meridian-artifact-payload")?.textContent).toContain(
      PORT_REFUSAL.detail,
    );
  });

  it("holds the fetch control while one is outstanding, and gives it back when it settles", async () => {
    // A payload is bounded only by the ingest cap, so a second press before the first
    // settles is a second download of the same bytes — and the reader refuses it. The
    // control is held so a participant never meets that refusal by pressing something
    // the pane was offering, and the arm the reading is on is what holds it.
    let releaseRead: (answer: unknown) => void = () => undefined;
    const artifactRead = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseRead = resolve;
        }),
    );
    const { getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: {
          growth: {
            artifactList: async () => LISTED_ONE_ROW,
            artifactAllowlistRead: async () => PORT_REFUSAL,
            artifactRead,
            artifactDelete: async () => PORT_REFUSAL,
          },
        } as unknown as ConsoleBridge,
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
    const control = getByRole("button", { name: "Fetch payload" });
    fireEvent.click(control);
    await settleAct();

    expect(control).toHaveProperty("disabled", true);
    fireEvent.click(control);
    await settleAct();
    expect(artifactRead).toHaveBeenCalledTimes(1);

    releaseRead(readAnswering("published"));
    await settleAct();
    expect(control).toHaveProperty("disabled", false);
  });

  it("negative control: nothing is drawn before the fetch, and no old copy survives", async () => {
    const { container } = renderPane(
      contextFor(ARTIFACT_ENTITY, { bridge: bridgeListing({}), sessionId: SESSION_ID }),
    );
    await readThrough();
    expect(container.querySelector(".meridian-artifact-payload")).toBeNull();
    // The sentence the pane used to close its header with, which said the members the
    // port now declares were unavailable.
    expect(container.textContent).not.toContain("which this console");
  });

  it("negative control: a refused delete leaves the row and renders the refusal", async () => {
    // Without this, a pane that removed the row optimistically would pass the case
    // above and still be wrong about every delete the daemon turns down.
    const artifactList = vi.fn<() => Promise<unknown>>().mockResolvedValue(LISTED_ONE_ROW);
    const { container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: bridgeListing({ artifactList }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
    confirmDelete(getByRole);
    await settleAct();

    const row = container.querySelector(".meridian-artifact-row") as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain("wire-unregistered");

    // And no re-read was asked for: nothing changed, so there is nothing to re-read.
    await readThrough();
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
      bridge: bridgeListing({
        readAnswer: inlineReadAnswering("ZGlmZiAtLWdpdCBhL29uZSBiL29uZQ==", "base64"),
      }),
      sessionId: SESSION_ID,
    });
    const { container, getByRole, rerender } = renderPane(context);
    await readThrough();
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();
    expect(container.querySelector(".meridian-artifact-payload__preview")?.textContent).toBe(
      "diff --git a/one b/one",
    );

    renderReAddressed(context, rerender);
    await readThrough();

    expect(container.querySelector(".meridian-repos-pane__subject")?.textContent).toBe(
      OTHER_ARTIFACT_ENTITY.id,
    );
    // `not-checked` renders no payload section at all, which is the honest absence
    // for a subject nobody has asked about — not an empty preview.
    expect(container.querySelector(".meridian-artifact-payload")).toBeNull();
  });

  it("does not hold the next subject's control with the previous subject's fetch", async () => {
    // The other half. The control is held by the `fetching` arm, and that arm belongs
    // to an artifact this pane is no longer addressed to — so a participant met a
    // disabled Fetch on a subject nothing had ever been asked about.
    const context = contextFor(ARTIFACT_ENTITY, {
      bridge: {
        growth: {
          artifactList: async () => LISTED_ONE_ROW,
          artifactAllowlistRead: async () => PORT_REFUSAL,
          // Never answers: the fetch stays on the wire for the rest of the case.
          artifactRead: () => new Promise<unknown>(() => undefined),
          artifactDelete: async () => PORT_REFUSAL,
        },
      } as unknown as ConsoleBridge,
      sessionId: SESSION_ID,
    });
    const { getByRole, rerender } = renderPane(context);
    await readThrough();
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();
    expect(getByRole("button", { name: "Fetch payload" }).hasAttribute("disabled")).toBe(true);

    renderReAddressed(context, rerender);
    await readThrough();

    expect(getByRole("button", { name: "Fetch payload" }).hasAttribute("disabled")).toBe(false);
  });

  it("negative control: the same subject keeps its reader, its payload, and its reads", async () => {
    // Without this, a memo keyed on the address OBJECT would pass both cases above
    // and mint a reader — and a read pair — on every render the deck performs, which
    // is the cost the stamp is deliberately narrow to avoid.
    const artifactList = vi.fn<() => Promise<unknown>>().mockResolvedValue(LISTED_ONE_ROW);
    const context = contextFor(ARTIFACT_ENTITY, {
      bridge: bridgeListing({
        artifactList,
        readAnswer: inlineReadAnswering("ZGlmZiAtLWdpdCBhL29uZSBiL29uZQ==", "base64"),
      }),
      sessionId: SESSION_ID,
    });
    const { container, getByRole, rerender } = renderPane(context);
    await readThrough();
    fireEvent.click(getByRole("button", { name: "Fetch payload" }));
    await settleAct();

    rerender(
      <LiveAnnouncerProvider clock={new ManualClock()}>
        <ArtifactPane context={{ ...context }} />
      </LiveAnnouncerProvider>,
    );
    await readThrough();

    expect(container.querySelector(".meridian-artifact-payload__preview")?.textContent).toBe(
      "diff --git a/one b/one",
    );
    expect(artifactList).toHaveBeenCalledTimes(1);
  });
});
