// The fold every feature mount opens its stores with: the one a window composes.
//
// The partition set is one claim, and it is the window's to make, once, in `app/registrations.ts`.
// A mount that named its own registrars would choose which partitions its view can read: one that
// folds `approval` but not `run` leaves a view that reads the run a decision names with nothing to
// find, and both tiers pass on it. A store opened with no projectors folds nothing, which looks
// exactly like a session with no runs. So mounts take the production composition (the snapshot
// `registerFeatureContributions` produces), and a feature that claims a new event kind is folded
// by every capture and audit the day it lands. No module under this directory reaches a projector
// registrar directly.
//
// It is composed into registries this module owns, which is what makes module scope safe:
// `registerFeatureContributions` writes only into the registries it is handed
// (`app/registrations.test.ts` asserts it). A constant rather than a factory, since the snapshot
// is frozen at the registry's edge and every mount in a tier then folds with one table.

import { registerFeatureContributions } from "@renderer/app/registrations.js";
import { CommandContributionRegistry } from "@renderer/registries/commands/command-contributions.js";
import { CommandRegistry } from "@renderer/registries/commands/command-registry.js";
import { EntityProjectorRegistry } from "@renderer/registries/entity-projectors/entity-projector-registry.js";
import { InlineCardRegistry } from "@renderer/registries/inline-cards/inline-card-registry.js";
import { PaneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { ScreenRegistry } from "@renderer/registries/screens/screen-registry.js";
import { type EntityProjectorTable } from "@renderer/store/session/entities/entities.js";

/**
 * The event-kind fold the app's own composition claims, frozen.
 *
 * Handed to every `SessionStore` and `SessionStoreRegistry` a feature mount opens, so a tier reads
 * the partitions a person's window would have.
 */
export const COMPOSED_ENTITY_PROJECTORS: EntityProjectorTable = composeEntityProjectors();

/**
 * Runs the window's composition into registries this module owns, and keeps the fold.
 *
 * The other registries are built and never read: a mount resolves commands, screens, panes and
 * cards through its own feature-scoped registry (`pane-body-resolution.ts`). The fold cannot work
 * that way, since a partition is read by whichever view names it, so the table a store opens with
 * has to be the whole one.
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
