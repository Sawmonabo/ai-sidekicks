// A pick makes the session: one `session.create` and nothing else, settled into the destination's
// own start (the session's store opened, the list asked again, the screen on the session). A
// refused create is said in the picker and asks the list again, and the same row picked again,
// even after the picker was closed and opened, sends the same key, while a changed output speed
// names another create.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ProviderAccountId } from "@ai-sidekicks/contracts/provider/account/record";
import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import type { SessionCreateResponse, SessionLead } from "@ai-sidekicks/contracts/session/directory";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { bridgeAnswering } from "#test/helpers/fixture/bridge.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { contextWith } from "../../destination-acts.test-support.js";
import { sessionDestinationActs } from "../../destination-acts.js";
import { NewSessionControl } from "./NewSessionControl.js";

const CREATED_SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5ac0de";

const LEAD: SessionLead = {
  providerName: "claude" as ProviderId,
  modelId: "claude-opus-4-5",
  effort: "high",
};

const CREATE_REPLY: SessionCreateResponse = {
  sessionId: CREATED_SESSION_ID as SessionId,
  shape: "chat",
  state: "active",
  lead: { ...LEAD, providerAccountId: "claude-work-account" as ProviderAccountId },
};

/** The picker's chat row, whose name reads on into its `no repo`. */
const JUST_CHAT = /^Just chat/u;

/** Press a control by its name and let the create settle. */
async function press(name: string | RegExp): Promise<void> {
  await act(async () => {
    screen.getByRole("button", { name }).click();
    await crossMacrotaskBoundary();
  });
}

describe("the New session picker", () => {
  afterEach(cleanup);

  it("makes the session at the pick and opens it, after an unanswered create on the same key", async () => {
    let createCount = 0;
    const { bridge, calls } = bridgeAnswering(async (call, passThrough) => {
      if (call.method !== "session.create") {
        return await passThrough();
      }
      createCount += 1;
      if (createCount === 1) {
        throw new Error("the service did not answer");
      }
      return CREATE_REPLY;
    });
    const navigations: unknown[] = [];
    const openedSessionIds: string[] = [];
    let directoryRechecks = 0;
    const recheckDirectory = (): void => {
      directoryRechecks += 1;
    };
    const acts = sessionDestinationActs(
      contextWith({ navigations, openedSessionIds }),
      recheckDirectory,
    );
    const { container } = render(
      <LiveAnnouncerProvider>
        <NewSessionControl
          bridge={bridge}
          lead={LEAD}
          recentProjects={[]}
          onSessionCreated={acts.settleStartedSession}
          recheckDirectory={recheckDirectory}
        />
      </LiveAnnouncerProvider>,
    );

    await press("New session");
    await press(JUST_CHAT);

    // Refused: said in the picker that asked, which stays open, and nothing is opened.
    expect(container.querySelector(".meridian-refusal__message")?.textContent).toMatch(
      /^Couldn't start session · /u,
    );
    expect(navigations).toStrictEqual([]);
    // The unanswered create may have made a session, so the list is asked again.
    expect(directoryRechecks).toBe(1);

    // Closing and opening the picker clears the line and keeps the row's key.
    await press("New session");
    await press("New session");
    expect(container.querySelector(".meridian-refusal__message")).toBeNull();
    await press(JUST_CHAT);

    // One create per pick, a chat on the named lead, the second carrying the first one's key.
    const creates = calls.filter((call) => call.method === "session.create");
    expect(creates).toHaveLength(2);
    expect(creates[0]?.params).toMatchObject({ binding: { kind: "chat" }, lead: LEAD });
    const keys = creates.map(
      (call) => (call.params as { clientIdempotencyKey: string }).clientIdempotencyKey,
    );
    expect(keys[1]).toBe(keys[0]);
    // Settled into the destination's start: the store the list merges opened, the list asked
    // again and the screen on the session; the picker closed with its line.
    expect(openedSessionIds).toStrictEqual([CREATED_SESSION_ID]);
    expect(directoryRechecks).toBe(2);
    expect(navigations).toStrictEqual([{ kind: "session", sessionId: CREATED_SESSION_ID }]);
    expect(screen.queryByRole("button", { name: JUST_CHAT })).toBeNull();
    expect(container.querySelector(".meridian-refusal__message")).toBeNull();
  });

  it("sends a fresh key for the same row once the lead's output speed changed", async () => {
    const { bridge, calls } = bridgeAnswering(async (call, passThrough) => {
      if (call.method !== "session.create") {
        return await passThrough();
      }
      throw new Error("the service did not answer");
    });
    const control = (lead: SessionLead): React.JSX.Element => (
      <LiveAnnouncerProvider>
        <NewSessionControl
          bridge={bridge}
          lead={lead}
          recentProjects={[]}
          onSessionCreated={() => undefined}
          recheckDirectory={() => undefined}
        />
      </LiveAnnouncerProvider>
    );
    const { rerender } = render(control({ ...LEAD, outputSpeed: "standard" }));

    await press("New session");
    await press(JUST_CHAT);
    rerender(control({ ...LEAD, outputSpeed: "fast" }));
    await press(JUST_CHAT);

    const keys = calls
      .filter((call) => call.method === "session.create")
      .map((call) => (call.params as { clientIdempotencyKey: string }).clientIdempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });
});
