// The value hook, driven through its own door, for the suites about a render pass that
// never became a frame. Shared props and key: `subject-scoped-probes.test-support.ts`.

import { use, type ReactElement } from "react";

import { DETOUR_KEY, type ValueProbeProps } from "./subject-scoped-probes.test-support.js";
import { useSubjectScopedState } from "./subject-scoped-state.js";

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
