// What every artifact-pane case is rendered against: one address, one served row, the
// port that answers each act, and the two waits a case settles through.
//
// A SUPPORT MODULE BECAUSE TWO SUITES RENDER THE SAME PANE. `ArtifactPane.test.tsx`
// owns the chrome, the absences, the bounds disclosure and the two row acts;
// `ArtifactPayloadSection.test.tsx` owns the fetch and what each of its arms draws.
// Both mount the WHOLE pane — the section takes no props of its own, it reads the
// pane's own reading — so a second copy of these builders in either suite would be a
// second definition of what "one published row" means, and the two would drift.

import { act, fireEvent, render } from "@testing-library/react";
import { vi } from "vitest";

import type { ConsoleBridge } from "../../bridge/index.js";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../core/index.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { SessionStore } from "../../store/index.js";
import { ArtifactPane, type ArtifactPaneProps } from "./ArtifactPane.js";

/** This pane's own address arm, taken from the prop rather than restated. */
export type ArtifactPaneContext = ArtifactPaneProps["context"];

/**
 * A pane context whose collaborators are never reached — `legacy-surfaces.test.ts`'s
 * cast, for its reason: the assertions are about what the address renders as. The
 * blocks that press a control pass a bridge and a session and reach both. The ADDRESS
 * half is not cast — the entity parameter is the arm's own, so a case handing this
 * pane a subject an artifact pane is never opened over fails to compile here.
 */
export function contextFor(
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

export const ARTIFACT_ENTITY = { kind: "artifact", id: "artifact-diff-01" } as const;
export const OTHER_ARTIFACT_ENTITY = { kind: "artifact", id: "artifact-attachment-02" } as const;

export const SESSION_ID = "019b7b30-0280-7c11-8420-b1a5c0de2200";
export const ARTIFACT_ID = "019b7b30-0280-7c11-8420-b1a5c0de2201";

/** One served manifest summary, with the one member each case varies spelled out. */
export function summary(state: string): Record<string, unknown> {
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

// THE ANNOTATIONS BELOW ARE THE DECLARATION EMITTER'S, not decoration:
// `isolatedDeclarations` is repo-wide, and it cannot write the type of an exported
// binding whose initializer calls a function or holds a bare array literal.
export const PORT_REFUSAL = {
  status: "unavailable",
  code: "wire-unregistered",
  detail: "Not checked — the artifact CRUD method strings are not registered yet.",
  origin: "growth-port",
};

export const LISTED_ONE_ROW: Record<string, unknown> = {
  status: "served",
  value: [summary("published")],
};

/**
 * One served READ, which is a manifest plus a way to reach the bytes.
 *
 * The reply NESTS the envelope rather than being it — a read carries the manifest
 * beside a payload handle — so a case that answered with a bare summary would be
 * scripting a shape the port never sends and this pane would compile against it. On
 * the DEFERRED arm, which is what a metadata read lands on.
 */
export function readAnswering(state: string): Record<string, unknown> {
  return {
    status: "served",
    value: { manifest: summary(state), payloadHandle: `sha256:2b4c/${state}` },
  };
}

/** The receipt a served delete answers with. Every member required, so all are here. */
export const DELETE_RECEIPT: Record<string, unknown> = {
  status: "served",
  value: {
    artifactId: ARTIFACT_ID,
    payloadDisposition: "retained_by_references",
    rePublishForeclosed: true,
    deletedAt: "2026-09-02T07:05:00.000Z",
  },
};

/** A served payload read on the INLINE arm, with the bytes and the encoding to read them by. */
export function inlineReadAnswering(payload: string, encoding: string): Record<string, unknown> {
  return {
    status: "served",
    value: { manifest: summary("published"), payload, payloadEncoding: encoding },
  };
}

export interface ActScript {
  readonly readAnswer?: unknown;
  readonly deleteAnswer?: unknown;
  /** Supplied where a case counts the list reads or varies them between reads. */
  readonly artifactList?: () => Promise<unknown>;
}

/** A bridge that lists one published row and answers the acts as the case scripts. */
export function bridgeListing(script: ActScript): ConsoleBridge {
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
export function confirmDelete(getByRole: ReturnType<typeof render>["getByRole"]): void {
  fireEvent.click(getByRole("button", { name: "Delete" }));
  fireEvent.click(getByRole("button", { name: "Delete permanently" }));
}

export function renderPane(context: ArtifactPaneContext): ReturnType<typeof render> {
  // The announcer is the pane's environment rather than its dependency, and it runs
  // on a frozen clock so a settlement sentence stands until the case reads it.
  return render(
    <LiveAnnouncerProvider clock={new ManualClock()}>
      <ArtifactPane context={context} />
    </LiveAnnouncerProvider>,
  );
}

/** Let the scheduler's coalescing window elapse, then let the read's awaits run. */
export async function readThrough(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS);
  });
}

/** Let an act's promise and the publish it causes settle. */
export async function settleAct(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}
