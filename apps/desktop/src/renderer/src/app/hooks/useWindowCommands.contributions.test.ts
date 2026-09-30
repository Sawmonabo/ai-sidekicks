// A feature composed after the window installed its chord table still gets its chords. The frame
// installs one `KeybindingTable` from an effect while features contribute at composition time,
// and the two are unordered; a late feature (a lazy chunk, a second composition into an open
// window) would otherwise bind into a list the table never rereads, and the key would do nothing
// while the palette and settings page show it. Driven through the real composition root and a
// dispatched press, since a table read from a hook result would be asserted against itself.

import { act } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { commandContributionRegistry } from "@renderer/registries/commands/command-contributions.js";
import { type CommandDefinition } from "@renderer/registries/commands/command-types.js";
import { mountApp } from "@test/helpers/mount-app.js";

/** The feature this file composes as, so its rows are withdrawn by owner. */
const CONTRIBUTING_OWNER = "frame-commands-contributions-test";

const CONTRIBUTED_COMMAND_ID = "frameCommandsContributionsTest.act";

/**
 * A chord no console feature binds, and one no modifier is needed to press.
 *
 * Modifier-free because `$mod` resolves against the real host at listen time, so a press built
 * here would have to guess which modifier this runner's `tinykeys` watches for.
 */
const CONTRIBUTED_CHORD = "F9";

/** Dispatch a keydown for the contributed chord. */
function pressContributedChord(): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "F9", key: "F9" }));
}

describe("window commands — chords contributed after the table was installed", () => {
  // Contributing nothing under this owner withdraws what the file added from the module-scoped
  // registry.
  afterEach(() => {
    commandContributionRegistry.contribute({
      owner: CONTRIBUTING_OWNER,
      commands: [],
      keyBindings: [],
    });
  });

  it("reaches the installed table, and did not before the contribution", async () => {
    let runCount = 0;
    const contributedCommand: CommandDefinition = {
      id: CONTRIBUTED_COMMAND_ID,
      title: "The act a late feature contributed",
      group: "Test",
      run: () => {
        runCount += 1;
      },
    };
    const mounted = await mountApp();

    // The press before the contribution is the negative control, in the same case to show the
    // chord was not already bound by something else.
    pressContributedChord();
    const runsBeforeContribution = runCount;

    await act(async () => {
      commandContributionRegistry.contribute({
        owner: CONTRIBUTING_OWNER,
        commands: [contributedCommand],
        keyBindings: [{ chord: CONTRIBUTED_CHORD, commandId: CONTRIBUTED_COMMAND_ID }],
      });
      await crossMacrotaskBoundary();
    });
    pressContributedChord();

    expect(runsBeforeContribution).toBe(0);
    expect(runCount).toBe(1);

    act(() => {
      mounted.unmount();
    });
  });

  it("stops answering the chord once the window is gone", async () => {
    // The effect's cleanup withdraws its listener, so a contribution after unmount reaches no
    // table; a leaked subscription would keep answering presses.
    let runCount = 0;
    const mounted = await mountApp();
    act(() => {
      mounted.unmount();
    });

    commandContributionRegistry.contribute({
      owner: CONTRIBUTING_OWNER,
      commands: [
        {
          id: CONTRIBUTED_COMMAND_ID,
          title: "The act a late feature contributed",
          group: "Test",
          run: () => {
            runCount += 1;
          },
        },
      ],
      keyBindings: [{ chord: CONTRIBUTED_CHORD, commandId: CONTRIBUTED_COMMAND_ID }],
    });
    pressContributedChord();

    expect(runCount).toBe(0);
  });
});
