// The scenario seat board — one reserved line per view family.
//
// Same reason as `console/families.ts`, applied to fixture data. Seven families
// build concurrently and each ships a scenario that exercises its own surface. If
// every one of them edited `bridge/scenario/manifest.ts` to add itself to
// `CONSOLE_SCENARIOS`, six of the seven branches would conflict on one array —
// and the merge that "resolves" such a conflict by keeping one side silently
// deletes a family's scenario while leaving its file on disk, which is the failure
// mode worth designing away rather than resolving carefully.
//
// So the manifest reads this list, and a family adds `bridge/scenario/<family>.ts`
// and its entries at the position its own task id marks. What is load-bearing is the
// POSITION, not the comment: a family may keep its reserved line above its entries so
// the picker's grouping stays legible, or replace it the way the first families did.
// Both spellings are in the list below, and no census reads either — which is the
// point, since a rule nothing enforces should not be stated as though it were one.
//
// ORDER IS PICKER ORDER
//
// The scenario switcher renders these in array order, so this list is also what a
// person sees. The two substrate scenarios come first because they are the ones
// that make sense with no family loaded; family scenarios follow in task order.

import { AGENTS_SCENARIO } from "./agents/agents.js";
import { BRING_YOUR_HISTORY_SCENARIO } from "./bring-your-history.js";
import { APPROVALS_SCENARIO } from "./approvals/approvals.js";
import { BROWSER_SCENARIO } from "./browser.js";
import { COLLABORATION_SCENARIO } from "./collaboration/collaboration.js";
import { COMPOSER_SCENARIO } from "./composer/composer.js";
import { FIRST_RUN_SCENARIO } from "./first-run.js";
import { FLAGSHIP_SCENARIO } from "./flagship/flagship.js";
import { LEDGER_WINDOW_GROWTH_INCIDENT_SCENARIO } from "./incident/ledger-window-growth.js";
import { LEDGER_FIRST_SIXTY_SCENARIO } from "./ledger/ledger-first-sixty.js";
import { LEDGER_QUIET_SCENARIO } from "./ledger/ledger-quiet.js";
import { LEDGER_SCENARIO } from "./ledger/ledger.js";
import { ONBOARDING_SCENARIO } from "./onboarding.js";
import { REPOS_SCENARIO } from "./repos/repos.js";
import { RUNS_SCENARIO } from "./runs/runs.js";
import { SETTINGS_SCENARIO } from "./settings/settings.js";
import { SHELL_SCENARIO } from "./shell.js";
import { TERMINAL_SCENARIO } from "./terminal/terminal.js";
import { WORKFLOWS_SCENARIO } from "./workflows/workflows.js";
import type { ConsoleScenario } from "./runtime/index.js";

/** Every scenario the fixture bridge can play, in picker order. */
export const CONSOLE_SCENARIOS: readonly ConsoleScenario[] = [
  FIRST_RUN_SCENARIO,
  FLAGSHIP_SCENARIO,
  // T-023p-1C-2 ledger. Two families ship three scenarios where the others ship one,
  // and for the same reason: three surfaces with three different states worth pinning,
  // which folding into one session would make reachable only through each other's noise
  // — here the ledger at rest, its first sixty seconds, and a quiet session.
  LEDGER_SCENARIO,
  LEDGER_FIRST_SIXTY_SCENARIO,
  LEDGER_QUIET_SCENARIO,
  // T-023p-1C-3 composer — the composer, the runs pane, and the approvals pane.
  COMPOSER_SCENARIO,
  RUNS_SCENARIO,
  APPROVALS_SCENARIO,
  // T-023p-1C-4 collaboration
  COLLABORATION_SCENARIO,
  AGENTS_SCENARIO,
  SETTINGS_SCENARIO,
  REPOS_SCENARIO, // T-023p-1C-5 repos
  WORKFLOWS_SCENARIO, // T-023p-1C-6 workflows
  BROWSER_SCENARIO,
  TERMINAL_SCENARIO,
  SHELL_SCENARIO,
  // T-023p-1C-8 gallery
  BRING_YOUR_HISTORY_SCENARIO,
  ONBOARDING_SCENARIO, // sign-in and onboarding
  // The `incident` class, last on purpose: these are evidence rather than composition.
  // A row here is a defect that happened, replayed from the wire frames it arrived on,
  // and a person opening the picker to see the product should not meet one first.
  LEDGER_WINDOW_GROWTH_INCIDENT_SCENARIO,
];
