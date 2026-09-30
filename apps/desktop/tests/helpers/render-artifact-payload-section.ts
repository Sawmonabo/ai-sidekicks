// Mounting the artifact reading: the two artifacts a case is about, a component that
// binds the reader through `useArtifactList`, and the ways a case puts it on screen.
//
// THE BOUND SECTION IS THE SMALLEST THING THAT USES THE HOOK. It draws the listed rows, a control
// that fetches the payload, and the payload section, so a case exercises the real
// binding and the real section against the calls it scripts rather than against a
// hand-written reading.
//
// EVERYTHING ABOUT WHAT IS SERVED COMES FROM `artifact-list-readers.ts`, which this
// module imports: a second id or a second manifest here would put the mounted cases and
// the reader cases on two different fixtures.

import type { ArtifactId } from "@ai-sidekicks/contracts";
import { render } from "@testing-library/react";
import { StrictMode, createElement, type ReactElement } from "react";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { bridgeOnClock } from "@test/helpers/fixture-bridge.js";
import type { ArtifactOperations } from "@renderer/features/inspector/artifacts/services/artifact-reads.js";
import { ArtifactPayloadSection } from "@renderer/features/repos/artifacts/components/ArtifactPayloadSection.js";
import { SESSION_ID } from "./artifact-list-readers.js";
import { useArtifactList } from "@renderer/features/inspector/artifacts/hooks/useArtifactList.js";
import { PlatformBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";

/** The artifact the bound section opens on. */
export const OPENED_ARTIFACT_ID = "artifact-diff-01" as ArtifactId;
/** A second artifact the bound section can be pointed at. */
export const OTHER_ARTIFACT_ID = "artifact-attachment-02" as ArtifactId;

/**
 * What the bound section is mounted over: the bridge, the session store, the calls, and
 * the clock the window runs on, which the reader schedules against.
 *
 * ONE OBJECT PER CASE, and the same object across a case's re-renders: the bridge and
 * the calls are the binding's identity, so a second `artifactPayloadSubject` call would
 * remount the reader for that reason instead of the one the case is about.
 */
export interface ArtifactPayloadSubject {
  readonly bridge: PlatformBridge;
  readonly sessionStore: SessionStore;
  readonly operations: ArtifactOperations;
  /** The clock every subsystem under the bound section reads. `readThrough` moves it. */
  readonly clock: ManualClock;
}

/** A subject over these calls, on a clock the case owns. */
export function artifactPayloadSubject(
  operations: ArtifactOperations,
  reached: { readonly sessionStore?: SessionStore } = {},
): ArtifactPayloadSubject {
  const clock = new ManualClock();
  return {
    bridge: bridgeOnClock("repos", clock).bridge,
    sessionStore: reached.sessionStore ?? new SessionStore({ sessionId: SESSION_ID }),
    operations,
    clock,
  };
}

/**
 * The bound section as an element a case can re-render at another artifact, under a provider that
 * carries the subject's bridge and clock.
 */
export function artifactPayloadTree(
  subject: ArtifactPayloadSubject,
  artifactId: ArtifactId = OPENED_ARTIFACT_ID,
): ReactElement {
  return createElement(PlatformBridgeProvider, {
    bridge: subject.bridge,
    clock: subject.clock,
    children: createElement(BoundArtifactPayloadSection, { subject, artifactId }),
  });
}

/** Mount the bound section. */
export function renderArtifactPayloadSection(
  subject: ArtifactPayloadSubject,
  artifactId: ArtifactId = OPENED_ARTIFACT_ID,
): ReturnType<typeof render> {
  return render(artifactPayloadTree(subject, artifactId));
}

/**
 * Mount the bound section the way React's development double-mount does.
 *
 * `StrictMode` runs every effect's setup, then its cleanup, then its setup again on the
 * same committed value — the sequence that disposes a reader and then calls `start()` on
 * the corpse. A binding that cannot come back from it is inert with nothing on screen to
 * say so, which is why this is a mount of its own rather than a flag.
 */
export function renderArtifactPayloadSectionStrictly(
  subject: ArtifactPayloadSubject,
  artifactId: ArtifactId = OPENED_ARTIFACT_ID,
): ReturnType<typeof render> {
  return render(createElement(StrictMode, null, artifactPayloadTree(subject, artifactId)));
}

interface BoundArtifactPayloadSectionProps {
  readonly subject: ArtifactPayloadSubject;
  readonly artifactId: ArtifactId;
}

/** Binds the reading for one artifact and draws the rows, the fetch control and the payload. */
function BoundArtifactPayloadSection({
  subject,
  artifactId,
}: BoundArtifactPayloadSectionProps): React.JSX.Element {
  const { reading, fetchPayload } = useArtifactList(
    subject.bridge,
    subject.sessionStore,
    artifactId,
    subject.operations,
  );
  const rows = reading.artifacts.kind === "listed" ? reading.artifacts.rows : [];
  return createElement(
    "div",
    null,
    ...rows.map((row) =>
      createElement("p", { key: row.id, className: "meridian-artifact-row" }, row.id),
    ),
    createElement(
      "button",
      {
        type: "button",
        disabled: reading.payload?.status === "fetching",
        onClick: () => {
          void fetchPayload(artifactId);
        },
      },
      "Fetch payload",
    ),
    createElement(ArtifactPayloadSection, { payload: reading.payload }),
  );
}
