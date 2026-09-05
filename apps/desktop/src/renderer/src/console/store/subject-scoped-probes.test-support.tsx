// The two hooks under test, each driven through its own door, for the suites about
// a render pass that never became a frame.
//
// `subject-scoped-dropped-pass.test.tsx` and `subject-scoped-abandoned-pass.test.tsx`
// ask different questions — whether a publisher survives a pass React retried, and
// whether the visit on screen survives one React parked and superseded — and both ask
// them of the same two components: the value hook and the resource hook, suspending on
// a promise the driver owns. One home for those, because a second copy would be two
// components that agree until one of them stops calling something.
//
// EVERY NEGATIVE CONTROL STAYS IN ITS OWN SUITE. A control is not a probe: it is the
// arrangement one claim replaced, it drives the real holder through that arrangement,
// and the two suites replaced different ones. Hoisting them here would put four
// components in one file whose readers each need two.

import { use, type ReactElement } from "react";

import type { NamedFixtureSubject } from "./subject-fixtures.test-support.js";
import { useSubjectScopedResource } from "./subject-scoped-resource.js";
import type { OpenResource, ResourceLedger } from "./subject-scoped-resource.test-support.js";
import { useSubjectScopedState } from "./subject-scoped-state.js";

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

/** The value hook, driven through its own door. */
export function ValueDetourProbe(props: ValueProbeProps): ReactElement {
  const { value, publish } = useSubjectScopedState<string>(props.subject, DETOUR_KEY, () => {
    props.onSeed();
    return "seed";
  });
  props.onReady(publish);
  if (props.suspendOn !== undefined) {
    use(props.suspendOn);
  }
  return <output>{value}</output>;
}

export interface ResourceProbeProps {
  readonly subject: NamedFixtureSubject;
  readonly suspendOn: Promise<void> | undefined;
  readonly ledger: ResourceLedger;
  readonly onReady: (publish: (next: OpenResource) => void) => void;
}

/** The resource hook, driven through its own door. */
export function ResourceDetourProbe(props: ResourceProbeProps): ReactElement {
  const { value, publish } = useSubjectScopedResource<OpenResource>(
    props.subject,
    undefined,
    () => props.ledger.open(props.subject.name),
    props.ledger.close,
  );
  props.onReady(publish);
  if (props.suspendOn !== undefined) {
    use(props.suspendOn);
  }
  return <output>{value.name}</output>;
}
