// What the popover says about its own enumeration when the read did not finish.
//
// Its own file because a cut enumeration is a fact about the READ rather than about
// the commands: the list still holds every entry the provider named, and what is
// missing is said above it rather than shown as an entry nobody could send.

import { type ProviderCommandBindingGroup } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";
import {
  EMPTY_STATE_SENTENCE,
  UNMATCHED_PREFIX,
  agentPane,
  bridgeEnumerating,
  composerAgentIds,
  mountComposer,
  optionNames,
  scenarioBindingGroups,
  typeIntoLine,
} from "./provider-command-discovery.test-support.js";

describe("ProviderCommandAutocomplete — a cut enumeration is said, not treated as all of it", () => {
  /** The scenario's own addressed group, with the reply's cap flag as the case wants it. */
  function addressedGroupWith(
    overrides: Partial<ProviderCommandBindingGroup>,
  ): ProviderCommandBindingGroup {
    const group = scenarioBindingGroups()[0];
    if (group === undefined) {
      throw new Error("the composer scenario enumerates no addressed group");
    }
    return { ...group, ...overrides };
  }

  /**
   * The cut notice's text, or `undefined` where the surface rendered none.
   *
   * The console's one partial-read notice rather than a line this family draws: the
   * `cut` reading is what a producer that stopped short renders as, everywhere.
   */
  function truncationLine(container: HTMLElement): string | undefined {
    return container.querySelector(".meridian-partial-read__copy")?.textContent ?? undefined;
  }

  it("withholds the empty claim when the prefix matched nothing over a cut list", async () => {
    // The finding: `complete: false` means the provider published more entries than
    // the cap admits and this group's tail was dropped, so a prefix matching only a
    // dropped entry was answered "No command matches what you have typed" — a claim
    // about a search that never reached the entries it would have matched.
    const mounted = await mountComposer({
      bridge: bridgeEnumerating([addressedGroupWith({ complete: false })]),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    await typeIntoLine(mounted.line, UNMATCHED_PREFIX);

    expect(mounted.container.textContent).not.toContain(EMPTY_STATE_SENTENCE);
    expect(truncationLine(mounted.container)).toContain(
      "read before this run's command list was cut",
    );
    // The count is the group's own served entries — the wire carries no figure for
    // what was dropped, and this surface invents none.
    expect(truncationLine(mounted.container)).toContain("2 ");
  });

  it("says the list was cut beside the entries it did carry", async () => {
    // A nonempty list off a cut enumeration looks exhaustive, which is the other
    // half of the same defect: the line renders whether the filter matched or not.
    const mounted = await mountComposer({
      bridge: bridgeEnumerating([addressedGroupWith({ complete: false })]),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    await typeIntoLine(mounted.line, "/");

    expect(optionNames(mounted.container)).toEqual(expect.arrayContaining(["compact", "review"]));
    expect(truncationLine(mounted.container)).toContain("may still exist");
  });

  it("negative control: a complete group says none of it and still answers the search", async () => {
    // Without this the cases above would hold over a popover that had stopped making
    // the empty claim at all, or that announced a truncation on every served read.
    const mounted = await mountComposer({
      bridge: bridgeEnumerating([addressedGroupWith({ complete: true })]),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    await typeIntoLine(mounted.line, UNMATCHED_PREFIX);

    expect(mounted.container.textContent).toContain(EMPTY_STATE_SENTENCE);
    expect(truncationLine(mounted.container)).toBeUndefined();
  });
});
