// A test's wrapper for a component the workflows screen draws: it offers its keyed acts under the
// screen's targets, so the wrapper provides a set the test can press.

import type { ReactNode } from "react";

import {
  WorkflowCommandTargetsContext,
  type WorkflowCommandTargets,
} from "./workflow-command-target.js";

/** `Outer` with `commandTargets` provided inside it, as the workflows screen provides its own. */
export function withCommandTargets(
  Outer: (props: { readonly children: ReactNode }) => React.JSX.Element,
  commandTargets: WorkflowCommandTargets,
): (props: { readonly children: ReactNode }) => React.JSX.Element {
  return function CommandTargetsHost(props: { readonly children: ReactNode }): React.JSX.Element {
    return (
      <Outer>
        <WorkflowCommandTargetsContext.Provider value={commandTargets}>
          {props.children}
        </WorkflowCommandTargetsContext.Provider>
      </Outer>
    );
  };
}
