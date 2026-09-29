// What composing every feature does to the registries it is handed.
//
// Two failures are expensive here and invisible anywhere else. A registrar that reaches for
// the window's registry instead of the one it was handed makes a test or a second window
// write into production. And a fold left out of the composition leaves its partition with
// no producer, which renders exactly like a session with nothing in it.

import { describe, expect, it } from "vitest";

import {
  CommandContributionRegistry,
  contributedKeybindings,
} from "@renderer/registries/commands/command-contributions.js";
import { CommandRegistry } from "@renderer/registries/commands/command-registry.js";
import {
  EntityProjectorRegistry,
  entityProjectorRegistry,
} from "@renderer/registries/entity-projectors/entity-projector-registry.js";
import {
  InlineCardRegistry,
  inlineCardRegistry,
} from "@renderer/registries/inline-cards/inline-card-registry.js";
import { PaneRegistry, paneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { ScreenRegistry, screenRegistry } from "@renderer/registries/screens/screen-registry.js";
import {
  APPROVAL_FLOW_PROJECTOR_OWNER,
  APPROVAL_FLOW_PROJECTORS,
} from "@renderer/store/session-events/approval-flow-projection.js";
import {
  QUESTION_SETTLEMENT_PROJECTOR_OWNER,
  QUESTION_SETTLEMENT_PROJECTORS,
} from "@renderer/store/session-events/question-settlement-projection.js";
import {
  RUN_LIFECYCLE_PROJECTOR_OWNER,
  RUN_LIFECYCLE_PROJECTORS,
} from "@renderer/store/session-events/run-lifecycle-projector.js";
import { registerFeatureContributions } from "./registrations.js";

/** Registries a case owns outright, with the command registry the contributions write into. */
function ownedRegistries(): {
  readonly commands: CommandContributionRegistry;
  readonly projectors: EntityProjectorRegistry;
  readonly screens: ScreenRegistry;
  readonly panes: PaneRegistry;
  readonly inlineCards: InlineCardRegistry;
} {
  return {
    commands: new CommandContributionRegistry(new CommandRegistry()),
    projectors: new EntityProjectorRegistry(),
    screens: new ScreenRegistry(),
    panes: new PaneRegistry(),
    inlineCards: new InlineCardRegistry(),
  };
}

describe("registerFeatureContributions", () => {
  it("composes every feature without a conflicting claim, and again as a hot reload does", () => {
    // A second owner on one screen, pane kind, card kind, chord or event kind throws.
    const registries = ownedRegistries();
    registerFeatureContributions(registries);
    const firstScreenNames = registries.screens.registeredScreenNames();
    const firstPaneKinds = registries.panes.registeredPaneKinds();

    registerFeatureContributions(registries);

    expect(registries.screens.registeredScreenNames()).toStrictEqual(firstScreenNames);
    expect(registries.panes.registeredPaneKinds()).toStrictEqual(firstPaneKinds);
  });

  it("writes into the registries it is handed and none of the window's", () => {
    const registries = ownedRegistries();

    registerFeatureContributions(registries);

    expect({
      keyBindings: registries.commands.keyBindings().length > 0,
      projectors: Object.keys(registries.projectors.snapshot()).length > 0,
      screens: registries.screens.registeredScreenNames().length > 0,
      panes: registries.panes.registeredPaneKinds().length > 0,
      inlineCards: registries.inlineCards.registeredCardKinds().length > 0,
    }).toStrictEqual({
      keyBindings: true,
      projectors: true,
      screens: true,
      panes: true,
      inlineCards: true,
    });
    expect({
      keyBindings: contributedKeybindings(),
      projectors: entityProjectorRegistry.snapshot(),
      screens: screenRegistry.registeredScreenNames(),
      panes: paneRegistry.registeredPaneKinds(),
      inlineCards: inlineCardRegistry.registeredCardKinds(),
    }).toStrictEqual({ keyBindings: [], projectors: {}, screens: [], panes: [], inlineCards: [] });
  });

  it.each([
    ["run lifecycle", RUN_LIFECYCLE_PROJECTORS, RUN_LIFECYCLE_PROJECTOR_OWNER],
    ["approval flow", APPROVAL_FLOW_PROJECTORS, APPROVAL_FLOW_PROJECTOR_OWNER],
    ["question settlement", QUESTION_SETTLEMENT_PROJECTORS, QUESTION_SETTLEMENT_PROJECTOR_OWNER],
  ])("folds every %s event kind under its owner", (_fold, projectorTable, owner) => {
    const registries = ownedRegistries();

    registerFeatureContributions(registries);

    const eventKinds = Object.keys(projectorTable);
    expect(eventKinds.length).toBeGreaterThan(0);
    expect(eventKinds.map((eventKind) => registries.projectors.ownerOf(eventKind))).toStrictEqual(
      eventKinds.map(() => owner),
    );
  });
});
