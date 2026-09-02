// 12.11's one platform-shaped decision, and the value that stands in for no host.
//
// The point of these cases is that "no host" is a VALUE: a consumer that forgets to
// check gets a sentence back rather than a dereference, and the wiring table selects
// on what it was handed rather than on `process.platform`.

import { describe, expect, it } from "vitest";

import { isConsoleRefusal } from "../core/index.js";
import type { PaneGeometrySample } from "./pane-geometry.js";
import {
  PANE_VIEW_HOST_REFUSAL_CODES,
  PANE_VIEW_HOST_REFUSAL_ORIGIN,
  resolvePaneViewHost,
  unavailablePaneViewHost,
  type AttachedPaneViewHost,
} from "./view-host.js";

const SCRIPTED_HOST: AttachedPaneViewHost = {
  state: "attached",
  transport: "scripted",
  setRect: (_sample: PaneGeometrySample) => ({ status: "accepted" }) as const,
};

describe("unavailablePaneViewHost", () => {
  it("is a value carrying a refusal, never a null", () => {
    const host = unavailablePaneViewHost("No view host is wired in this window.");
    expect(host.state).toBe("unavailable");
    expect(isConsoleRefusal(host.refusal)).toBe(true);
    expect(host.refusal.origin).toBe(PANE_VIEW_HOST_REFUSAL_ORIGIN);
    expect(PANE_VIEW_HOST_REFUSAL_CODES).toContain(host.refusal.code);
    expect(host.refusal.detail).toBe("No view host is wired in this window.");
  });
});

describe("resolvePaneViewHost", () => {
  it("takes the scripted host when it is handed one", () => {
    const host = resolvePaneViewHost({ scriptedHost: SCRIPTED_HOST });
    expect(host.state).toBe("attached");
    expect(host).toBe(SCRIPTED_HOST);
  });

  it("falls to unavailable — and says so in a sentence — when handed nothing", () => {
    const host = resolvePaneViewHost({});
    expect(host.state).toBe("unavailable");
    if (host.state !== "unavailable") {
      throw new Error("unreachable");
    }
    expect(host.refusal.code).toBe("host-unavailable");
    expect(host.refusal.detail.length).toBeGreaterThan(0);
  });

  it("negative control: the fallback is not what it returns for every input", () => {
    // Without this, a wiring table that ignored its argument and always refused would
    // satisfy the unavailable case above, and the fixture would have no host at all.
    expect(resolvePaneViewHost({ scriptedHost: SCRIPTED_HOST }).state).not.toBe(
      resolvePaneViewHost({}).state,
    );
  });
});
