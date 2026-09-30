// The pane kind the repos feature claims, driven through the registry.

import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { LiveAnnouncerProvider } from "@renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { PaneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";
import { paneContext } from "../pane-context.test-support.js";
import { registerReposPanes } from "./panes.js";

const REPOS_PANE_KINDS = ["diff"] as const;

function contextForPane(): PaneContext {
  return paneContext({
    address: { kind: "diff", entity: { kind: "workspace", id: "workspace-sidekicks" } },
    paneId: "pane-diff",
  });
}

describe("repos — the pane kinds", () => {
  it("claims the diff pane", () => {
    const registry = new PaneRegistry();
    registerReposPanes(registry);
    expect(registry.registeredPaneKinds()).toStrictEqual([...REPOS_PANE_KINDS]);
  });

  it("negative control: a registry `registerReposPanes` was not given claims nothing", () => {
    // A registrar that reached for the module singleton would leave this registry empty while
    // still passing the case above.
    const claimed = new PaneRegistry();
    const untouched = new PaneRegistry();
    registerReposPanes(claimed);
    expect(untouched.registeredPaneKinds()).toStrictEqual([]);
  });

  it("mounts a named region for the diff pane", () => {
    const registry = new PaneRegistry();
    registerReposPanes(registry);
    const descriptor = registry.descriptorFor("diff");
    expect(descriptor?.owner).toBe("repos");
    // The announcer is supplied by the frame in production; `useAnnounce` throws outside it.
    // The clock is frozen so nothing announced clears on a timer mid-case.
    const { container } = render(
      <LiveAnnouncerProvider clock={new ManualClock()}>
        {descriptor?.render(contextForPane())}
      </LiveAnnouncerProvider>,
    );
    // A pattern, since `PaneFrame` names a pane by its address trail ending in the kind.
    const region = within(container).getByRole("region", { name: /Review$/u });
    // The subject the descriptor was handed is in the name, so a body that stopped passing its
    // address to the chrome fails here.
    expect(region.textContent).toContain("workspace-sidekicks");
  });
});
