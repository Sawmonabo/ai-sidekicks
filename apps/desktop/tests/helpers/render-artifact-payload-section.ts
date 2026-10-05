// Mounts the artifact reading: the two artifacts a case is about, a component that binds the
// reader through `useArtifactList`, and the ways a case puts it on screen.
//
// The bound section draws the listed rows, a control that fetches the payload, and the payload
// section, so a case exercises the real binding and section against the calls it scripts. What is
// served comes from `artifact-list-readers.ts`, so mounted and reader cases share one fixture.

import type { ArtifactId } from "@ai-sidekicks/contracts/provider/driver/driver";
import { render } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import type { PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { SessionStore } from "#renderer/store/session/session-store.js";
import { bridgeOnClock } from "./fixture/bridge.js";
import type { ArtifactOperations } from "#renderer/features/inspector/artifacts/services/artifact-reads.js";
import { ArtifactPayloadSection } from "#renderer/features/repos/artifacts/components/ArtifactPayloadSection.js";
import { SESSION_ID } from "./artifact-list-readers.js";
import { useArtifactList } from "#renderer/features/inspector/artifacts/hooks/useArtifactList.js";
import { PlatformBridgeProvider } from "#renderer/services/platform/PlatformBridgeProvider.js";

/** The artifact the bound section opens on. */
export const OPENED_ARTIFACT_ID = "artifact-diff-01" as ArtifactId;

/**
 * What the bound section is mounted over: the bridge, the session store, the calls, and the
 * clock the window runs on, which the reader schedules against.
 *
 * One object per case and the same across re-renders, since the bridge and calls are the
 * binding's identity and a second subject would remount the reader.
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
