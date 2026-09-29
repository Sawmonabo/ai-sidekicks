// The window's attention reading outlives a destination.
//
// A person who navigates away must not take the reading down with them, or the window
// says "nothing is waiting on you" while the daemon is answering perfectly well.
// Lifetime is what is asserted here, and it is invisible to a case that mounts one
// tree and leaves it mounted.
//
// SO EVERY CASE SWAPS THE SUBTREE. The child under the binding is what a route change
// replaces, so re-rendering with a different child is a navigation as far as this seam
// is concerned, and the assertion is the number of times each call was put.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DesktopBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";
import { NO_TRANSPORT_RECONNECT } from "@renderer/lib/transport-reconnect.js";
import type { FrameBindingContext } from "@renderer/console/seats/index.js";
import type { SessionStore } from "../session/session-store.js";
import type { SessionStoreRegistry } from "../session/session-store-registry.js";
import {
  SessionAttentionBinding,
  useSessionAttention,
} from "@renderer/console/sessions/SessionAttentionBinding.js";
import { callsAnswering, settle } from "@renderer/features/sessions/SessionsFlyout.test-support.js";

/** A registry holding no store, which is all these reads ask of it. */
const EMPTY_REGISTRY = {
  openSessionIds: [],
  peek: (): SessionStore | undefined => undefined,
  subscribe: () => () => undefined,
} as unknown as SessionStoreRegistry;

/** The bridge members the reads reach for, attached and silent. */
const BRIDGE = {
  source: "fixture",
  attentionSubscribe: () => () => undefined,
  transportReconnect: NO_TRANSPORT_RECONNECT,
};

/** What the child under the binding reads from it. */
function ReadingProbe(props: { readonly label: string }): React.JSX.Element {
  const { reading, directory } = useSessionAttention();
  return (
    <div>
      {props.label}:{reading.phase}:{directory.status}
    </div>
  );
}

describe("the window's attention binding — the reading outlives a destination", () => {
  it("performs each read once across a replaced subtree", async () => {
    let attentionReads = 0;
    let directoryReads = 0;
    const answering = callsAnswering({ directorySessionIds: ["session-a"] });
    const readAttention: typeof answering.readAttention = () => {
      attentionReads += 1;
      return answering.readAttention();
    };
    const readDirectory: typeof answering.readDirectory = (signal) => {
      directoryReads += 1;
      return answering.readDirectory(signal);
    };
    const bindingOver = (label: string): React.JSX.Element => (
      <DesktopBridgeProvider bridge={BRIDGE as never}>
        <SessionAttentionBinding
          context={
            {
              bridge: BRIDGE,
              frameStore: {},
              sessionStoreRegistry: EMPTY_REGISTRY,
            } as unknown as FrameBindingContext
          }
          readAttention={readAttention}
          readDirectory={readDirectory}
        >
          <ReadingProbe label={label} />
        </SessionAttentionBinding>
      </DesktopBridgeProvider>
    );

    const mounted = render(bindingOver("the sessions destination"));
    await settle();
    expect(mounted.container.textContent).toBe("the sessions destination:read:served");

    mounted.rerender(bindingOver("the workspace"));
    await settle();

    expect(mounted.container.textContent).toBe("the workspace:read:served");
    expect(attentionReads).toBe(1);
    expect(directoryReads).toBe(1);
  });
});
