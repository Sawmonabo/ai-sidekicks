// The fold every feature mount opens its stores with: the one a window composes.
//
// ONE COMPOSITION BECAUSE THE PARTITION SET IS ONE CLAIM. A mount that names the
// registrars it wants is choosing which partitions its view can read, and that
// choice is not a mount's to make — the window makes it, once, in
// `app/registrations.ts`. A mount that folds the `approval` partition and not the `run`
// one leaves a view that reads the run a pending decision names with nothing to find,
// and both tiers pass on it — the accessibility tier because an absence is as auditable
// as a chip, the screenshot tier because a picture of the wrong composition is as stable
// as one of the right one.
//
// AND A SUBSET IS NOT THE ONLY WRONG ANSWER; an omitted argument is the same defect
// with a smaller number. A store opened with no projectors at all folds nothing, so a
// scenario whose beats reach `run.running` still leaves every run-shaped view
// reading an empty partition — which looks exactly like a session that has no runs.
//
// SO THE MOUNTS TAKE THE PRODUCTION COMPOSITION RATHER THAN A LIST. What is exported
// is the snapshot `registerFeatureContributions` produces, so a feature that claims a new
// event kind is folded by every capture and every audit on the day it lands, with no
// feature-mounts file edited and none forgotten. Review is what keeps it that way: no module
// under this directory may reach a projector registrar directly, and every store either
// mount opens names this constant.
//
// COMPOSED INTO BOARDS THIS MODULE OWNS, which is what makes it safe to do at module
// scope. `registerFeatureContributions` writes only into the registries it is handed —
// `app/registrations.test.ts` asserts exactly that against the window's — so the ones
// built here and dropped are the price of reading the projectors, and no tier's window
// is touched by importing this file.
//
// A CONSTANT RATHER THAN A FACTORY, on `frame/run-projection/run-lifecycle-projector.ts`'s precedent
// for the table it exports: the snapshot is frozen at the registry's own edge, so
// every mount in a tier folds with one table and no mount can be handed a different
// one. Composing per call would also re-run every feature's registrar once per mount,
// which is work whose only observable effect would be to make that impossible to rely
// on.

import { registerFeatureContributions } from "@renderer/app/registrations.js";
import { CommandContributionRegistry } from "@renderer/registries/commands/command-contributions.js";
import { CommandRegistry } from "@renderer/registries/commands/command-registry.js";
import { EntityProjectorRegistry } from "@renderer/registries/entity-projectors/entity-projector-registry.js";
import { InlineCardRegistry } from "@renderer/registries/inline-cards/inline-card-registry.js";
import { PaneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { ScreenRegistry } from "@renderer/registries/screens/screen-registry.js";
import { type EntityProjectorTable } from "@renderer/store/session/entities/entities.js";

/**
 * The event-kind fold the console's own composition claims, frozen.
 *
 * Handed to every `SessionStore` and `SessionStoreRegistry` a feature mount opens, so
 * a tier reads the partitions a person's window would have.
 */
export const COMPOSED_ENTITY_PROJECTORS: EntityProjectorTable = composeEntityProjectors();

/**
 * Run the window's composition into registries this module owns, and keep the fold.
 *
 * The other registries are built here and never read: they are what the composition
 * writes its commands, screens, panes and inline cards into, and a mount resolves
 * each of those through its own feature-scoped registry (`pane-body-resolution.ts`)
 * because a mount composes exactly the body it captures. The fold is the one registry
 * that cannot work that way — a partition is read by whichever view names it, so
 * the table a store opens with has to be the whole one.
 */
function composeEntityProjectors(): EntityProjectorTable {
  const projectors = new EntityProjectorRegistry();
  registerFeatureContributions({
    commands: new CommandContributionRegistry(new CommandRegistry()),
    projectors,
    screens: new ScreenRegistry(),
    panes: new PaneRegistry(),
    inlineCards: new InlineCardRegistry(),
  });
  return projectors.snapshot();
}
