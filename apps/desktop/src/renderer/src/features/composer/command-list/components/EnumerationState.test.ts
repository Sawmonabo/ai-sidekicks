// A cut enumeration is a fact about the read: the list still holds every entry the provider named,
// and what is missing is said above it.

import { type ProviderCommandBindingGroup } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";
import {
  EMPTY_STATE_SENTENCE,
  UNMATCHED_PREFIX,
  agentPane,
  bridgeEnumerating,
  composerLeadAgentId,
  mountComposer,
  optionNames,
  scenarioBindingGroups,
  typeIntoLine,
} from "../command-list.test-support.js";

describe("CommandList — a cut enumeration is said, not treated as all of it", () => {
  async function addressedGroupWith(
    overrides: Partial<ProviderCommandBindingGroup>,
  ): Promise<ProviderCommandBindingGroup> {
    const group = (await scenarioBindingGroups())[0];
    if (group === undefined) {
      throw new Error("the composer scenario enumerates no addressed group");
    }
    return { ...group, ...overrides };
  }

  /** The cut notice's text, or `undefined` where none rendered. */
  function truncationLine(container: HTMLElement): string | undefined {
    return container.querySelector(".meridian-partial-read__copy")?.textContent ?? undefined;
  }

  it("withholds the empty claim when the prefix matched nothing over a cut list", async () => {
    // `complete: false` means the tail was dropped, so a prefix matching only a dropped entry must
    // not be answered "No command matches".
    const mounted = await mountComposer({
      bridge: bridgeEnumerating([await addressedGroupWith({ complete: false })]),
      focusedPane: agentPane(composerLeadAgentId()),
    });

    await typeIntoLine(mounted.line, UNMATCHED_PREFIX);

    expect(mounted.container.textContent).not.toContain(EMPTY_STATE_SENTENCE);
    expect(truncationLine(mounted.container)).toContain(
      "the answer for this run's command list was cut short",
    );
    // The count is the group's served entries; the wire carries no figure for what was dropped.
    expect(truncationLine(mounted.container)).toContain("2 ");
  });

  it("says the list was cut beside the entries it did carry", async () => {
    const mounted = await mountComposer({
      bridge: bridgeEnumerating([await addressedGroupWith({ complete: false })]),
      focusedPane: agentPane(composerLeadAgentId()),
    });

    await typeIntoLine(mounted.line, "/");

    expect(optionNames(mounted.container)).toEqual(expect.arrayContaining(["compact", "review"]));
    expect(truncationLine(mounted.container)).toContain("may still exist");
  });

  it("negative control: a complete group says none of it and still answers the search", async () => {
    const mounted = await mountComposer({
      bridge: bridgeEnumerating([await addressedGroupWith({ complete: true })]),
      focusedPane: agentPane(composerLeadAgentId()),
    });

    await typeIntoLine(mounted.line, UNMATCHED_PREFIX);

    expect(mounted.container.textContent).toContain(EMPTY_STATE_SENTENCE);
    expect(truncationLine(mounted.container)).toBeUndefined();
  });
});
