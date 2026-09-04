// The holder's two guarantees, each with the failure it closes.
//
// Both are about a mounted surface being rebound. The first is what a render
// COMMITS on the pass that first sees the new subject, which is why every render is
// recorded here rather than only the settled one — a value cleared in an effect is
// already gone by the time an effect could see it, and the frame in between is the
// whole defect. The second is what a read still in flight does when it lands
// afterwards.

import { createElement } from "react";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConsoleBridge } from "./console-bridge.js";
import { useSessionScopedState } from "./session-scoped-state.js";

const BRIDGE_ONE = { source: "fixture" } as unknown as ConsoleBridge;
const BRIDGE_TWO = { source: "fixture" } as unknown as ConsoleBridge;
const SESSION_ONE = "session-one";
const SESSION_TWO = "session-two";

interface SubjectProps {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
}

/**
 * Mount the holder, recording every rendered value and the publisher each render
 * handed out.
 *
 * The publishers are kept because a stale settlement is precisely a call to the one
 * an earlier render produced; keeping only the newest would make that case
 * unreachable.
 */
function mountHolder(subject: SubjectProps): {
  readonly rendered: readonly string[];
  readonly publishers: readonly ((value: string) => void)[];
  readonly rebindTo: (next: SubjectProps) => Promise<void>;
  readonly forgetRenders: () => void;
} {
  const rendered: string[] = [];
  const publishers: ((value: string) => void)[] = [];
  function Holder(props: SubjectProps): null {
    const [value, publish] = useSessionScopedState(props.bridge, props.sessionId, "unasked");
    rendered.push(value);
    publishers.push(publish);
    return null;
  }
  const view = render(createElement(Holder, subject));
  return {
    rendered,
    publishers,
    rebindTo: async (next) => {
      await act(async () => {
        view.rerender(createElement(Holder, next));
        await Promise.resolve();
      });
    },
    forgetRenders: () => {
      rendered.length = 0;
    },
  };
}

/** Publish through the newest publisher a render handed out. */
async function publishNow(
  holder: ReturnType<typeof mountHolder>,
  value: string,
  publisherIndex = -1,
): Promise<void> {
  await act(async () => {
    holder.publishers.at(publisherIndex)?.(value);
    await Promise.resolve();
  });
}

describe("a value belongs to the subject it was produced under", () => {
  it("reads the initial value on the very render that commits a new session", async () => {
    const holder = mountHolder({ bridge: BRIDGE_ONE, sessionId: SESSION_ONE });
    await publishNow(holder, "session one's answer");
    expect(holder.rendered.at(-1)).toBe("session one's answer");

    holder.forgetRenders();
    await holder.rebindTo({ bridge: BRIDGE_ONE, sessionId: SESSION_TWO });
    expect(holder.rendered[0]).toBe("unasked");
    expect(holder.rendered.every((value) => value === "unasked")).toBe(true);
  });

  it("resets on a new bridge as well as a new session", async () => {
    // The fixture's scenario switch replaces the bridge under a surface addressed
    // to the same session id, so the session alone is not the subject.
    const holder = mountHolder({ bridge: BRIDGE_ONE, sessionId: SESSION_ONE });
    await publishNow(holder, "the first bridge's answer");
    holder.forgetRenders();
    await holder.rebindTo({ bridge: BRIDGE_TWO, sessionId: SESSION_ONE });
    expect(holder.rendered[0]).toBe("unasked");
  });

  it("drops a settlement published through the previous subject's publisher", async () => {
    const holder = mountHolder({ bridge: BRIDGE_ONE, sessionId: SESSION_ONE });
    const staleIndex = holder.publishers.length - 1;
    await holder.rebindTo({ bridge: BRIDGE_ONE, sessionId: SESSION_TWO });
    await publishNow(holder, "session two's own answer");
    await publishNow(holder, "session one's late answer", staleIndex);
    expect(holder.rendered.at(-1)).toBe("session two's own answer");
  });

  it("negative control: the current subject's publisher does publish", async () => {
    // Without this, a holder that rejected every publish would pass both cases
    // above and never show an answer at all.
    const holder = mountHolder({ bridge: BRIDGE_ONE, sessionId: SESSION_ONE });
    await holder.rebindTo({ bridge: BRIDGE_ONE, sessionId: SESSION_TWO });
    await publishNow(holder, "session two's own answer");
    expect(holder.rendered.at(-1)).toBe("session two's own answer");
  });
});
