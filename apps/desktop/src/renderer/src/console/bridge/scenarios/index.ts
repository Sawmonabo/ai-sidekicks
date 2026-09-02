// The scenario seat board — one reserved line per view family.
//
// Same reason as `console/families.ts`, applied to fixture data. Seven families
// build concurrently and each ships a scenario that exercises its own surface. If
// every one of them edited `bridge/scenario-manifest.ts` to add itself to
// `CONSOLE_SCENARIOS`, six of the seven branches would conflict on one array —
// and the merge that "resolves" such a conflict by keeping one side silently
// deletes a family's scenario while leaving its file on disk, which is the failure
// mode worth designing away rather than resolving carefully.
//
// So the manifest reads this list, and a family adds `bridge/scenarios/<family>.ts`
// and its entries directly beneath the line bearing its own task id. That line
// stays, so the picker's grouping is legible whether or not a family has shipped a
// scenario yet.
//
// ORDER IS PICKER ORDER
//
// The scenario switcher renders these in array order, so this list is also what a
// person sees. The two substrate scenarios come first because they are the ones
// that make sense with no family loaded; family scenarios follow in task order.

import { AGENTS_SCENARIO } from "./agents.js";
import { COLLABORATION_SCENARIO } from "./collaboration.js";
import { FIRST_RUN_SCENARIO } from "./first-run.js";
import { FLAGSHIP_SCENARIO } from "./flagship.js";
import { SETTINGS_SCENARIO } from "./settings.js";
import type { ConsoleScenario } from "../scenario.js";

/** Every scenario the fixture bridge can play, in picker order. */
export const CONSOLE_SCENARIOS: readonly ConsoleScenario[] = [
  FIRST_RUN_SCENARIO,
  FLAGSHIP_SCENARIO,
  // T-023p-1C-2 ledger
  // T-023p-1C-3 composer
  // T-023p-1C-4 collaboration
  COLLABORATION_SCENARIO,
  AGENTS_SCENARIO,
  SETTINGS_SCENARIO,
  // T-023p-1C-5 repos
  // T-023p-1C-6 workflows
  // T-023p-1C-7 browser-terminal
  // T-023p-1C-8 gallery
];
