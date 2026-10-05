// The calls that register every feature's contributions, and nothing else.
//
// Each feature owns what it registers and publishes its registrar through its `index.ts`; this
// file holds no table, so a registry stays the one place its entries live. A feature may not
// import another, so where one feature's screen mounts another's component, this file names the
// pair. Nothing here runs on import: `AppProviders.tsx` calls it once with the window's
// registries, and a test calls it with registries of its own.

import type { EntityProjectorRegistry } from "#renderer/registries/entity-projectors/entity-projector-registry.js";
import type { CommandContributionRegistry } from "#renderer/registries/commands/contributions.js";
import type { InlineCardRegistry } from "#renderer/registries/inline-cards/inline-card-registry.js";
import type { PaneRegistry } from "#renderer/registries/panes/pane-registry.js";
import type { ScreenRegistry } from "#renderer/registries/screens/screen-registry.js";
import { registerNavigationKeybindings } from "#renderer/layout/NavigationRail/navigation-commands.js";
import {
  APPROVAL_FLOW_PROJECTOR_OWNER,
  APPROVAL_FLOW_PROJECTORS,
} from "#renderer/store/session-events/approval-flow-projection.js";
import {
  RUN_LIFECYCLE_PROJECTOR_OWNER,
  RUN_LIFECYCLE_PROJECTORS,
} from "#renderer/store/session-events/run/lifecycle-projector.js";
import { registerAgentsPane } from "#renderer/features/agents/index.js";
import {
  registerComposerCommands,
  registerComposerView,
  registerComposerInlineCards,
  registerComposerKeybindings,
} from "#renderer/features/composer/index.js";
import {
  registerInspectorInlineCards,
  registerInspectorPane,
} from "#renderer/features/inspector/index.js";
import { registerPreviewPanes } from "#renderer/features/preview/index.js";
import { registerReposInlineCards, registerReposPanes } from "#renderer/features/repos/index.js";
import {
  registerPaneLayoutCommands,
  registerSessionsFlyout,
  SessionScreen,
} from "#renderer/features/sessions/index.js";
import { registerSettingsScreen } from "#renderer/features/settings/index.js";
import { registerTerminalPane } from "#renderer/features/terminal/index.js";
import {
  registerTranscriptScreens,
  registerTranscriptPanes,
  registerTranscriptCommands,
} from "#renderer/features/transcript/index.js";
import {
  registerWorkflowCommands,
  registerWorkflowPanes,
  registerWorkflowScreens,
} from "#renderer/features/workflows/index.js";

/** The registries a composition writes into. */
export interface ContributionRegistries {
  readonly commands: CommandContributionRegistry;
  readonly projectors: EntityProjectorRegistry;
  readonly screens: ScreenRegistry;
  readonly panes: PaneRegistry;
  readonly inlineCards: InlineCardRegistry;
}

/**
 * Register every feature's contributions into the registries handed in.
 *
 * Safe to call twice with the same registries, as a hot reload does: each owner's second
 * claim replaces its first.
 */
export function registerFeatureContributions(registries: ContributionRegistries): void {
  const { commands, projectors, screens, panes, inlineCards } = registries;

  // The rail's chords first: the chord table's first match wins, so a feature registered
  // earlier could take `$mod+1` from the rail.
  registerNavigationKeybindings(commands);
  registerComposerCommands(commands);
  registerComposerKeybindings(commands);
  registerTranscriptCommands(commands);
  registerWorkflowCommands(commands);
  registerPaneLayoutCommands(commands);

  projectors.registerAll(RUN_LIFECYCLE_PROJECTORS, RUN_LIFECYCLE_PROJECTOR_OWNER);
  projectors.registerAll(APPROVAL_FLOW_PROJECTORS, APPROVAL_FLOW_PROJECTOR_OWNER);

  registerTranscriptScreens(screens, { sessionScreen: SessionScreen });
  registerSessionsFlyout(screens);
  registerSettingsScreen(screens);
  registerWorkflowScreens(screens);

  registerTranscriptPanes(panes);
  registerInspectorPane(panes);
  registerAgentsPane(panes);
  registerReposPanes(panes);
  registerWorkflowPanes(panes);
  registerPreviewPanes(panes);
  registerTerminalPane(panes);

  registerComposerView();
  registerComposerInlineCards(inlineCards);
  registerReposInlineCards(inlineCards);
  registerInspectorInlineCards(inlineCards);
}
