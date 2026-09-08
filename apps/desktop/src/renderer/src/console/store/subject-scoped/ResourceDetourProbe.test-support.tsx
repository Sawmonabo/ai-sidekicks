// The resource hook, driven through its own door, for the suites about a render pass
// that never became a frame. Shared props: `subject-scoped-probes.test-support.ts`.

import { use, type ReactElement } from "react";

import type { ResourceProbeProps } from "./subject-scoped-probes.test-support.js";
import { useSubjectScopedResource } from "./subject-scoped-resource.js";
import type { OpenResource } from "./subject-scoped-resource.test-support.js";

/** The resource hook, driven through its own door. */
export function ResourceDetourProbe(props: ResourceProbeProps): ReactElement {
  const { value, publish } = useSubjectScopedResource<OpenResource>(
    props.subject,
    undefined,
    () => props.ledger.open(props.subject.name),
    { release: props.ledger.close },
  );
  props.onReady(publish);
  if (props.suspendOn !== undefined) {
    use(props.suspendOn);
  }
  return <output>{value.name}</output>;
}
