// The window's chord table order: the rail's own chords first, then every feature's.
//
// The order is the claim. The table listens in the capture phase and the first match
// wins, so a feature able to precede the rail could take `$mod+1` away from it without
// anything reporting it.

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  commandContributionRegistry,
  contributedKeybindings,
} from "@renderer/registries/commands/command-contributions.js";
import { RAIL_KEYBINDINGS } from "@renderer/layout/NavigationRail/navigation-commands.js";

// The setup imports the whole composition, which has taken longer than the default
// ten-second hook budget with every package's suite running at once.
const WHOLE_COMPOSITION_IMPORT_TIMEOUT_MS = 30_000;

const TEST_OWNER = "keybinding-order-test";

describe("registrations — the window's chord table order", () => {
  beforeAll(async () => {
    await import("./providers.js");
  }, WHOLE_COMPOSITION_IMPORT_TIMEOUT_MS);

  afterEach(() => {
    commandContributionRegistry.contribute({ owner: TEST_OWNER, commands: [], keyBindings: [] });
  });

  it("puts the rail's chords before every feature's", () => {
    expect(contributedKeybindings().slice(0, RAIL_KEYBINDINGS.length)).toStrictEqual([
      ...RAIL_KEYBINDINGS,
    ]);
  });

  it("negative control: a contribution made after composition lands after the rail's", () => {
    // Without this the case above would pass over a reader that answered the rail's
    // chords from somewhere other than the contributions.
    commandContributionRegistry.contribute({
      owner: TEST_OWNER,
      commands: [
        { id: "keybinding-order-test.act", title: "Act", group: "Test", run: () => undefined },
      ],
      keyBindings: [{ chord: "$mod+Shift+7", commandId: "keybinding-order-test.act" }],
    });

    expect(contributedKeybindings().at(-1)).toStrictEqual({
      chord: "$mod+Shift+7",
      commandId: "keybinding-order-test.act",
    });
    expect(contributedKeybindings().slice(0, RAIL_KEYBINDINGS.length)).toStrictEqual([
      ...RAIL_KEYBINDINGS,
    ]);
  });
});
