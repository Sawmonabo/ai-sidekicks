// The window's attention reading outlives a destination: navigating away must not take it
// down and leave the window saying nothing is waiting while the daemon is answering. Each
// case swaps the subtree under the provider, which stands in for a route change, and asserts
// how many times each call was made.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PAST_REFRESH_DEBOUNCE_MS, settle as settleReactWork } from "@test/helpers/settle.js";
import { RealClock } from "@renderer/lib/clock.js";
import { NO_TRANSPORT_RECONNECT } from "@renderer/lib/transport-reconnect.js";
import type { SessionDirectoryReadCall } from "../session-directory/session-directory.js";
import type { SessionStore } from "../session/session-store.js";
import type { SessionStoreRegistry } from "../session/session-store-registry.js";
import { AttentionProvider } from "./AttentionProvider.js";
import type { AttentionProjectionReadCall } from "./hooks/useAttentionProjection.js";
import { useAttention } from "./hooks/useAttention.js";

/** A registry holding no store, which is all these reads ask of it. */
const EMPTY_REGISTRY = {
  openSessionIds: [],
  peek: (): SessionStore | undefined => undefined,
  subscribe: () => () => undefined,
} as unknown as SessionStoreRegistry;

/** Let both reads land, past the refresh debounce the attention read waits out. */
async function settle(): Promise<void> {
  await settleReactWork();
  await act(async () => {
    await new Promise((resolveAfterDebounce) => {
      setTimeout(resolveAfterDebounce, PAST_REFRESH_DEBOUNCE_MS);
    });
  });
}

/** What the child under the provider reads from it. */
function ReadingProbe(props: { readonly label: string }): React.JSX.Element {
  const { reading, directory } = useAttention();
  return (
    <div>
      {props.label}:{reading.phase}:{directory.status}
    </div>
  );
}

describe("the window's attention provider — the reading outlives a destination", () => {
  it("performs each read once across a replaced subtree", async () => {
    let attentionReads = 0;
    let directoryReads = 0;
    const readAttention: AttentionProjectionReadCall = () => {
      attentionReads += 1;
      return Promise.resolve({
        items: [],
        droppedCount: 0,
        refusedSessions: [],
        addressedSessionIds: ["session-a"],
      });
    };
    const readDirectory: SessionDirectoryReadCall = () => {
      directoryReads += 1;
      return Promise.resolve([{ sessionId: "session-a", state: "active" }]);
    };
    const clock = new RealClock();
    const providerOver = (label: string): React.JSX.Element => (
      <AttentionProvider
        readAttention={readAttention}
        readDirectory={readDirectory}
        transportReconnect={NO_TRANSPORT_RECONNECT}
        sessionStoreRegistry={EMPTY_REGISTRY}
        clock={clock}
      >
        <ReadingProbe label={label} />
      </AttentionProvider>
    );

    const mounted = render(providerOver("the sessions destination"));
    await settle();
    expect(mounted.container.textContent).toBe("the sessions destination:read:served");

    mounted.rerender(providerOver("the session screen"));
    await settle();

    expect(mounted.container.textContent).toBe("the session screen:read:served");
    expect(attentionReads).toBe(1);
    expect(directoryReads).toBe(1);
  });
});
