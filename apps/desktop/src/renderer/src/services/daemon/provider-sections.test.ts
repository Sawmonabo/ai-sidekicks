// The provider store fills from the service's provider list and follows its section stream: each
// message replaces the one provider it names, and an unreadable one fails the list rather than
// leaving a list that may be wrong.

import { describe, expect, it, vi } from "vitest";

import {
  bridgeOnClock,
  withDaemonCall,
  withDaemonSubscribe,
} from "#test/helpers/fixture/bridge.js";
import { ProviderSectionsStore } from "#renderer/store/providers/sections.js";
import {
  providerSection,
  providerSectionsFixture,
} from "#renderer/store/providers/sections.test-support.js";
import { providerSectionsFeedFor } from "./provider-sections.js";

describe("the provider store", () => {
  it("fills from the list, then each streamed section replaces only its own provider", async () => {
    const { bridge: answering } = withDaemonCall(
      bridgeOnClock("provider-sections").bridge,
      async (call, passThrough) =>
        call.method === "provider.list" ? { providers: providerSectionsFixture() } : passThrough(),
    );
    const deliveries: ((payload: unknown) => void)[] = [];
    const bridge = withDaemonSubscribe(
      answering,
      (_passThrough, handler, _request, _onEnded, event) => {
        expect(event).toBe("provider.subscribe");
        deliveries.push(handler);
        return () => undefined;
      },
    );
    const store = new ProviderSectionsStore(providerSectionsFeedFor(bridge));
    const release = store.watch(() => undefined);
    const deliver = (payload: unknown): void => {
      deliveries[0]?.(payload);
    };

    // The stream is open before the list is read; a section ahead of the list moves nothing.
    expect(deliveries).toHaveLength(1);
    deliver({ settings: providerSection("codex", "Early") });
    expect(store.state.status).toBe("reading");

    await vi.waitFor(() => {
      expect(store.state.status).toBe("served");
    });
    const served = (): readonly string[] =>
      store.state.status === "served" ? store.state.sections.map((section) => section.name) : [];
    expect(served()).toStrictEqual(["Claude Code", "Codex"]);

    deliver({ settings: providerSection("codex", "Codex CLI") });
    expect(served()).toStrictEqual(["Claude Code", "Codex CLI"]);

    deliver({ settings: { provider: "codex" } });
    expect(store.state.status).toBe("failed");
    release();
  });
});
