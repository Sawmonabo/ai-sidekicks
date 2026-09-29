// The pane kind the repos feature claims, driven through the registry.

import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { LiveAnnouncerProvider } from "@renderer/console/primitives/index.js";
import { ConsolePaneRegistry, type ConsolePaneContext } from "@renderer/console/seats/index.js";
import { paneContext } from "../pane-context.test-support.js";
import { registerReposPanes } from "./panes.js";

/** The kinds this feature owns. */
const REPOS_PANE_KINDS = ["diff"] as const;

/**
 * This file's pane context.
 *
 * The diff pane reads only its address, so no bridge or store is supplied.
 */
function contextForPane(): ConsolePaneContext {
  return paneContext({
    address: { kind: "diff", entity: { kind: "workspace", id: "workspace-sidekicks" } },
    paneId: "pane-diff",
  });
}

describe("repos — the pane kinds", () => {
  it("claims the diff pane", () => {
    const registry = new ConsolePaneRegistry();
    registerReposPanes(registry);
    expect(registry.registeredPaneKinds()).toStrictEqual([...REPOS_PANE_KINDS]);
  });

  it("negative control: a registry the door was not given claims nothing", () => {
    // The door takes a registry rather than reaching for the module-scope
    // singleton. A registrar that reached for the singleton would leave this one
    // empty while still appearing to work in the case above.
    const claimed = new ConsolePaneRegistry();
    const untouched = new ConsolePaneRegistry();
    registerReposPanes(claimed);
    expect(untouched.registeredPaneKinds()).toStrictEqual([]);
  });

  it("mounts a named region for the diff pane", () => {
    const registry = new ConsolePaneRegistry();
    registerReposPanes(registry);
    const descriptor = registry.descriptorFor("diff");
    expect(descriptor?.owner).toBe("repos");
    // The announcer is the environment the frame supplies in production, and a pane
    // that announces its acts calls `useAnnounce`, which throws outside the provider on
    // purpose. The clock is frozen so nothing this mount announces clears on a timer
    // mid-case.
    const { container } = render(
      <LiveAnnouncerProvider clock={new ManualClock()}>
        {descriptor?.render(contextForPane())}
      </LiveAnnouncerProvider>,
    );
    // The name is a pattern and not the whole name, because `seats/ConsolePaneChrome`
    // names a pane by its address trail and the kind is the crumb the trail ends on.
    const region = within(container).getByRole("region", { name: /Diff$/u });
    // And the trail really is a trail: the subject the descriptor was handed is in the
    // name, so a body that stopped passing its address to the chrome fails here rather
    // than passing on the kind noun alone.
    expect(region.textContent).toContain("workspace-sidekicks");
  });
});
