// The nodes page renders both health axes' vocabulary, asks for a session, and
// invents no attachment.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RuntimeNodesPage, registerRuntimeNodesPage } from "./RuntimeNodesPage.js";
import { SettingsPageRegistry, type SettingsPageContext } from "../settings-page-registry.js";

function contextFor(activeSessionId: string | undefined): SettingsPageContext {
  return {
    bridge: { source: "fixture" },
    openSection: () => undefined,
    activeSessionId,
  } as unknown as SettingsPageContext;
}

describe("runtime nodes page", () => {
  it("names both health axes rather than one collapsed reading", () => {
    const { container } = render(<RuntimeNodesPage context={contextFor(undefined)} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Attachment state");
    expect(text).toContain("Heartbeat presence");
  });

  it("says the roster belongs to a session when the address names none", () => {
    const { container } = render(<RuntimeNodesPage context={contextFor(undefined)} />);
    expect(container.textContent ?? "").toContain("belongs to a session");
  });

  it("negative control: with a session it mounts the absorbed roster instead", () => {
    // Without this, the case above would pass over a page that never mounted the
    // roster at all. Under the fixture the absorbed mount carries its own guard —
    // the shipped views read the installed bridge — so what renders is that guard's
    // sentence, and never the address-names-none one.
    const { container } = render(<RuntimeNodesPage context={contextFor("session-1")} />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("belongs to a session");
    expect(text).toContain("running on the fixture");
  });

  it("offers no attachment it cannot compose", () => {
    const { container } = render(<RuntimeNodesPage context={contextFor("session-1")} />);
    const text = container.textContent ?? "";
    expect(text).toContain("composes no attachment");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("claims the nodes section with a search vocabulary", () => {
    const registry = new SettingsPageRegistry();
    registerRuntimeNodesPage(registry);
    const descriptor = registry.descriptorFor("nodes");
    expect(descriptor?.label).toBe("Runtime nodes");
    expect(descriptor?.keywords).toContain("heartbeat");
  });
});
