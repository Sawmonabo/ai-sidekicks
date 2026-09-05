// What the two detour probes share: the key both visits are addressed at, and the
// props each probe takes. The probes themselves are `ValueDetourProbe.test-support.tsx`
// and `ResourceDetourProbe.test-support.tsx` — one component per module, the
// `apps/desktop` AGENTS.md rule the one-component gate enforces on support modules too.
//
// `subject-scoped-dropped-pass.test.tsx` and `subject-scoped-abandoned-pass.test.tsx`
// ask different questions — whether a publisher survives a pass React retried, and
// whether the visit on screen survives one React parked and superseded — and both ask
// them of the same two components. One home for those, because a second copy would be
// two components that agree until one of them stops calling something.
//
// EVERY NEGATIVE CONTROL STAYS IN ITS OWN SUITE. A control is not a probe: it is the
// arrangement one claim replaced, it drives the real holder through that arrangement,
// and the two suites replaced different ones.

import type { NamedFixtureSubject } from "./subject-fixtures.test-support.js";
import type { OpenResource, ResourceLedger } from "./subject-scoped-resource.test-support.js";

/** The key BOTH visits are addressed at, so only the addressing tells them apart. */
export const DETOUR_KEY = "s1";

export interface ValueProbeProps {
  readonly subject: object;
  /** Present on the pass that does not commit: the probe suspends on it. */
  readonly suspendOn: Promise<void> | undefined;
  /** Called once per addressing, which is what proves the parked pass really ran. */
  readonly onSeed: () => void;
  readonly onReady: (publish: (next: string) => void) => void;
}

export interface ResourceProbeProps {
  readonly subject: NamedFixtureSubject;
  readonly suspendOn: Promise<void> | undefined;
  readonly ledger: ResourceLedger;
  readonly onReady: (publish: (next: OpenResource) => void) => void;
}
