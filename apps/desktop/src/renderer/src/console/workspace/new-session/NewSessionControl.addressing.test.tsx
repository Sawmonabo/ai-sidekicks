// WHICH composition a settlement lands in, and which bridge a draft belongs to.
//
// Split from `NewSessionControl.test.tsx`, which is about the acts being reachable at
// all. Every case here is about ADDRESSING: discard is reachable while a send is in
// flight and "+ New" is reachable the moment it is, so a continuation that wrote its
// result into whatever composition was on screen when it settled would show an older
// draft's refusal under a newer one — and a control that held its draft on nothing
// would keep sending through a bridge that has been replaced.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { type ConsoleBridge } from "../../bridge/index.js";
import { withDaemonCall } from "../../bridge/fixture-bridge.test-support.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { NewSessionControl } from "./NewSessionControl.js";
import {
  CREATE_REPLY,
  bridgeFor,
  bridgeQueueingCreates,
  openDraftWithPosture,
  politeText,
  press,
  renderControl,
  renderControlOn,
} from "./NewSessionControl.test-support.js";

describe("the composed new-session draft — which composition a settlement lands in", () => {
  it("drops a discarded draft's settlement rather than showing it under its replacement", async () => {
    // The defect: the continuation wrote its result into whatever composition was on
    // screen when it settled. Discard is reachable while a send is in flight and
    // "+ New" is reachable the moment it is, so a person who discarded and started
    // again was shown a refusal for a session THIS draft never sent.
    const queued = bridgeQueueingCreates();
    const container = renderControlOn(queued.bridge);
    await openDraftWithPosture();
    await press("Send");

    await press("Discard");
    await openDraftWithPosture();
    await act(async () => {
      queued.answerOldest();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("first-turn-missing");
    expect(politeText(container)).toBe("");
    // The replacement is untouched and still sendable — nothing about the old send
    // reached it, including its sending flag.
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
  });

  it("keeps Send disabled when an older draft's send settles under a newer one", async () => {
    // The second half of the same defect. One boolean over two drafts is cleared by
    // whichever send settles first, so the older one's `finally` re-enabled Send under
    // a composition whose own create was still in flight.
    const queued = bridgeQueueingCreates();
    const container = renderControlOn(queued.bridge);
    await openDraftWithPosture();
    await press("Send");
    await press("Discard");
    await openDraftWithPosture();
    await press("Send");
    expect(queued.pendingCount()).toBe(2);

    await act(async () => {
      queued.answerOldest();
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    expect(container.textContent).not.toContain("first-turn-missing");

    await act(async () => {
      queued.answerOldest();
      await Promise.resolve();
    });

    // The newer draft's own settlement is the one that lands.
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
    expect(container.textContent).toContain("first-turn-missing");
  });

  it("negative control: a settlement for the draft still on screen is rendered", async () => {
    // Without this, a control that dropped EVERY settlement would pass both cases
    // above — and no send would ever report anything.
    const queued = bridgeQueueingCreates();
    const container = renderControlOn(queued.bridge);
    await openDraftWithPosture();
    await press("Send");

    await act(async () => {
      queued.answerOldest();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("first-turn-missing");
    expect(politeText(container)).toBe(
      "The session was created, but not everything the draft asked for could be sent.",
    );
  });

  // The negative control: without it, a control whose Send button was wired to
  // nothing would satisfy every case above that only reads the opened panel — the
  // refusal text and the announcement are the only evidence a send happened at all.
  it("negative control: an unsent draft carries neither refusal nor announcement", async () => {
    const container = renderControl({ scriptsCreate: true });
    await press("+ New");
    await act(async () => {
      screen.getByRole("radio", { name: "Trusted" }).click();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("first-turn-missing");
    expect(container.textContent).not.toContain("session-create-failed");
    expect(politeText(container)).toBe("");
  });
});

/** The fixture bridge, plus a count of the creates that actually reached it. */
function bridgeCountingCreates(): {
  readonly bridge: ConsoleBridge;
  readonly createCount: () => number;
} {
  let creates = 0;
  const { bridge } = withDaemonCall(bridgeFor({ scriptsCreate: true }), async () => {
    creates += 1;
    return CREATE_REPLY;
  });
  return { bridge, createCount: () => creates };
}

describe("the composed new-session draft — the transport it would send through", () => {
  afterEach(cleanup);

  it("drops the draft when the bridge is replaced, and sends nothing through the retired one", async () => {
    // A draft holds the bridge it was composed against and sends `session.create`
    // through that one, so a reconnect leaves it addressed to a transport that is
    // gone: the send would either never land or land on a connection this console
    // will not read again, and the id it reported back would name a session nobody
    // can open. The draft goes with the transport, and "+ New" comes back.
    const retired = bridgeCountingCreates();
    const live = bridgeCountingCreates();
    const { rerender } = render(
      <LiveAnnouncerProvider>
        <NewSessionControl bridge={retired.bridge} />
      </LiveAnnouncerProvider>,
    );
    await openDraftWithPosture();

    rerender(
      <LiveAnnouncerProvider>
        <NewSessionControl bridge={live.bridge} />
      </LiveAnnouncerProvider>,
    );

    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.getByRole("button", { name: "+ New" })).toBeDefined();

    await openDraftWithPosture();
    await press("Send");

    expect(live.createCount()).toBe(1);
    expect(retired.createCount()).toBe(0);
  });

  it("negative control: with no replacement, the same composition reaches its own bridge", async () => {
    // Without this, the case above would pass over a control whose Send reached no
    // bridge at all, and "never the retired one" would be true of every bridge.
    const composed = bridgeCountingCreates();
    render(
      <LiveAnnouncerProvider>
        <NewSessionControl bridge={composed.bridge} />
      </LiveAnnouncerProvider>,
    );
    await openDraftWithPosture();
    await press("Send");

    expect(composed.createCount()).toBe(1);
  });
});
