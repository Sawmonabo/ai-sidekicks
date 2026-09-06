// The scenario seat board — one reserved line per view family.
//
// Same reason as `console/families.ts`, applied to fixture data. Seven families
// build concurrently and each ships a scenario that exercises its own surface. If
// every one of them edited `bridge/scenario-runtime/scenario-manifest.ts` to add itself to
// `CONSOLE_SCENARIOS`, six of the seven branches would conflict on one array —
// and the merge that "resolves" such a conflict by keeping one side silently
// deletes a family's scenario while leaving its file on disk, which is the failure
// mode worth designing away rather than resolving carefully.
//
// So the manifest reads this list, and a family adds `bridge/scenarios/<family>.ts`
// and replaces exactly the line bearing its own task id.
//
// ORDER IS PICKER ORDER
//
// The scenario switcher renders these in array order, so this list is also what a
// person sees. The two substrate scenarios come first because they are the ones
// that make sense with no family loaded; family scenarios follow in task order.

import { BROWSER_SCENARIO } from "./browser.js";
import { FIRST_RUN_SCENARIO } from "./first-run.js";
import { FLAGSHIP_SCENARIO } from "./flagship.js";
import { TERMINAL_SCENARIO } from "./terminal.js";
import { WORKFLOWS_SCENARIO } from "./workflows.js";
import type { ConsoleScenario } from "../scenario-runtime/index.js";

/** Every scenario the fixture bridge can play, in picker order. */
export const CONSOLE_SCENARIOS: readonly ConsoleScenario[] = [
  FIRST_RUN_SCENARIO,
  FLAGSHIP_SCENARIO,
  // T-023p-1C-2 ledger
  // T-023p-1C-3 composer
  // T-023p-1C-4 collaboration
  // T-023p-1C-5 repos
  WORKFLOWS_SCENARIO,
  BROWSER_SCENARIO,
  TERMINAL_SCENARIO,
  // T-023p-1C-8 gallery
];
