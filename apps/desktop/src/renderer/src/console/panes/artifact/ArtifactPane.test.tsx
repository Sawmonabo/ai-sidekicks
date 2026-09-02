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
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../core/index.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { ATTACHMENT_ALLOWLIST_DEFAULT } from "../../repos/attachment-model.js";
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
    sessionStore: reached.sessionId === undefined ? undefined : { sessionId: reached.sessionId },
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
  it("offers the act named for what the read serves", async () => {
    const { getByRole, queryByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, { bridge: bridgeListing({}), sessionId: SESSION_ID }),
    );
    await readThrough();
    expect(getByRole("button", { name: "Read manifest" })).toBeDefined();
    expect(queryByRole("button", { name: "Fetch payload" })).toBeNull();
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
          deleteAnswer: { status: "served", value: undefined },
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

  it("says what the delete reported and what it did not", async () => {
    const { container, getByRole } = renderPane(
      contextFor(ARTIFACT_ENTITY, {
        bridge: bridgeListing({ deleteAnswer: { status: "served", value: undefined } }),
        sessionId: SESSION_ID,
      }),
    );
    await readThrough();
    confirmDelete(getByRole);
    await settleAct();

    const spoken = container.querySelector('[role="status"]')?.textContent ?? "";
    expect(spoken).toContain("Artifact deleted");
    expect(spoken).toContain("no payload disposition");
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
