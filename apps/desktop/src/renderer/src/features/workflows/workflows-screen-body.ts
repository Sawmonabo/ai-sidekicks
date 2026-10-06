// The workflows destination's body as the screen registry loads it, and the root of its chunk.
// `#/workflows` is a rail destination, so nothing paints it until a person opens it. The loader
// in `contributions/screens.ts` names the body it builds `Body`, the export name
// `components/LazyBody/lazy-body.ts` resolves.

import { createElement } from "react";

import type { ScreenContext } from "#renderer/registries/screens/screen-context.js";
import type { WorkflowCommandTargets } from "./workflow-command-target.js";
import { WorkflowsScreen } from "./WorkflowsScreen.js";

/** The workflows screen at the committed route, offering `commandTargets` to the commands that press them. */
export function bodyOffering(
  commandTargets: WorkflowCommandTargets,
): (context: ScreenContext) => React.ReactNode {
  return (context) => createElement(WorkflowsScreen, { context, commandTargets });
}
