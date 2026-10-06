// What the two discarded-render probes share: the key both visits are addressed at, and the
// props each probe takes. The probes are `DiscardedRenderValueProbe.test-support.tsx` and
// `DiscardedRenderResourceProbe.test-support.tsx`, one component per module, driven by
// `useSubjectScopedState.test.tsx` and `useSubjectScopedResource.test.tsx` through a pass React
// parked and superseded.

import type { NamedFixtureSubject } from "#test/helpers/subject-fixtures.js";
import type {
  OpenResource,
  ResourceOpenCloseLog,
} from "./useSubjectScopedResource.test-support.js";

/** The key both visits are addressed at, so only the addressing tells them apart. */
export const DISCARDED_RENDER_KEY = "s1";

/** What the value probe takes. */
export interface ValueProbeProps {
  readonly subject: object;
  /** Present on the pass that does not commit: the probe suspends on it. */
  readonly suspendOn: Promise<void> | undefined;
  /** Called once per addressing, which is what proves the parked pass really ran. */
  readonly onSeed: () => void;
  readonly onReady: (publish: (next: string) => void) => void;
}

/** What the resource probe takes. */
export interface ResourceProbeProps {
  readonly subject: NamedFixtureSubject;
  readonly suspendOn: Promise<void> | undefined;
  readonly ledger: ResourceOpenCloseLog;
  readonly onReady: (publish: (next: OpenResource) => void) => void;
}
