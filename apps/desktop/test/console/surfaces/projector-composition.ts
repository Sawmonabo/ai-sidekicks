// The fold every surface mount opens its stores with: the one a window composes.
//
// ONE COMPOSITION BECAUSE THE PARTITION SET IS ONE CLAIM. A mount that names the
// registrars it wants is choosing which partitions its surface can read, and that
// choice is not a mount's to make — the window makes it, once, in
// `console/families.ts`. The composer family's approvals mount named
// `registerApprovalFlowProjectors` alone, so the `approval` partition folded and the
// `run` partition did not: `ApprovalsPaneBody` reads the run a pending decision names
// out of `useSessionPartition(store, "run")`, found nothing there, and rendered
// "Execution boundary unknown" over a scenario that stamps a posture on its own
// `run.running` beat. Both tiers passed on it — the accessibility tier because an
// absence is as auditable as a chip, the screenshot tier because a reference minted
// from the wrong composition is stable and green forever.
//
// AND A SUBSET IS NOT THE ONLY WRONG ANSWER; an omitted argument is the same defect
// with a smaller number. A store opened with no projectors at all folds nothing, so a
// scenario whose beats reach `run.running` still leaves every run-shaped surface
// reading an empty partition — which looks exactly like a session that has no runs.
//
// SO THE MOUNTS TAKE THE PRODUCTION COMPOSITION RATHER THAN A LIST. What is exported
// is the snapshot `registerConsoleFamilies` produces, so a family that claims a new
// event kind is folded by every capture and every audit on the day it lands, with no
// surfaces file edited and none forgotten.
// `test/console/architecture/surface-fold-chokepoint.test.ts` is what keeps it that
// way: no module under this directory may reach a projector registrar directly, and
// every store either mount opens names this constant.
//
// COMPOSED INTO BOARDS THIS MODULE OWNS, which is what makes it safe to do at module
// scope. `registerConsoleFamilies` writes only into the five registries it is handed —
// `console/families.test.ts` asserts exactly that against the process-wide ones — so
// the four boards built here and dropped are the price of reading the fifth, and no
// tier's window is touched by importing this file.
//
// A CONSTANT RATHER THAN A FACTORY, on `frame/run-lifecycle-projector.ts`'s precedent
// for the table it exports: the snapshot is frozen at the registry's own edge, so
// every mount in a tier folds with one table and no mount can be handed a different
// one. Composing per call would also re-run every family's registrar once per surface,
// which is work whose only observable effect would be to make that impossible to rely
// on.

import { registerConsoleFamilies } from "../../../src/renderer/src/console/families.js";
import {
  ConsolePaneRegistry,
  ConsoleSurfaceRegistry,
  InlineCardSeatRegistry,
  SidebarSectionRegistry,
} from "../../../src/renderer/src/console/seats/index.js";
import {
  ConsoleEntityProjectorRegistry,
  type EntityProjectorRegistry,
} from "../../../src/renderer/src/console/store/index.js";

/**
 * The event-kind fold the console's own composition claims, frozen.
 *
 * Handed to every `SessionStore` and `SessionStoreRegistry` a surface mount opens, so
 * a tier reads the partitions a person's window would have.
 */
export const COMPOSED_CONSOLE_PROJECTORS: EntityProjectorRegistry = composeConsoleProjectors();

/**
 * Run the window's composition into boards this module owns, and keep the fold.
 *
 * The other four registries are built here and never read: they are what the
 * composition writes its surfaces, panes, sidebar sections, and inline cards into, and
 * a mount resolves each of those through its own family-scoped registry
 * (`pane-body-resolution.ts`) because a mount composes exactly the body it captures.
 * The fold is the one board that cannot work that way — a partition is read by
 * whichever surface names it, so the table a store opens with has to be the whole one.
 */
function composeConsoleProjectors(): EntityProjectorRegistry {
  const projectorBoard = new ConsoleEntityProjectorRegistry();
  registerConsoleFamilies(
    new ConsoleSurfaceRegistry(),
    new ConsolePaneRegistry(),
    projectorBoard,
    new SidebarSectionRegistry(),
    new InlineCardSeatRegistry(),
  );
  return projectorBoard.snapshot();
}
