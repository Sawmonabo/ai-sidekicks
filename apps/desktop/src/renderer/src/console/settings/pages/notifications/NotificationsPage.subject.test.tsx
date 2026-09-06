// Which session's identity, and whose switches, are on screen — checked per frame.
//
// The chain is two reads, and both were held in `useState` cells cleared at the top
// of an effect. "Cleared first" is first within the EFFECT, which is one commit after
// the render that renamed the session — so that commit painted the previous session's
// participant and that person's stored switches under the new session's name.
//
// A case that looks at the DOM after `rerender` cannot see it: `act` flushes the
// passive effect before returning. The frames are recorded from `Profiler.onRender`
// instead — see `core/committed-frame.test-support.tsx`.

import { describe, expect, it } from "vitest";

import {
  SESSION_ID,
  bridgeWith,
  renderMovableNotificationsPage,
  servedPreferences,
  settle,
} from "./notifications-page.test-support.js";
import type { CallerParticipantOutcome } from "./attention-preference-model.js";

const OTHER_SESSION_ID = "session-notifications-other";

/** A stored key only a served preference read puts on screen. */
const STORED_KEY = "attention.mentions";

/** Two sessions, two people: the whole point is that one's switches never show under the other. */
function bridgeResolvingPerSession(): ReturnType<typeof bridgeWith> {
  const participantBySession: Readonly<Record<string, string>> = {
    [SESSION_ID]: "participant-ana",
    [OTHER_SESSION_ID]: "participant-bo",
  };
  return bridgeWith({
    callerParticipantRead: async (request) => {
      const participantId = participantBySession[request.sessionId];
      const outcome: CallerParticipantOutcome =
        participantId === undefined
          ? { status: "served", value: { participantId: "participant-unknown" } }
          : { status: "served", value: { participantId } };
      return await Promise.resolve(outcome);
    },
    attentionPreferenceRead: async (request) =>
      await Promise.resolve(
        servedPreferences([
          { key: `${STORED_KEY}.${request.participantId}`, value: { mentions: true } },
        ]),
      ),
  });
}

describe("the notifications page — whose switches are on screen", () => {
  it("commits no frame carrying the previous session's person under the new one", async () => {
    const page = renderMovableNotificationsPage(bridgeResolvingPerSession(), SESSION_ID);
    await settle();
    expect(page.container.textContent ?? "").toContain("participant-ana");

    page.forgetFrames();
    page.showSession(OTHER_SESSION_ID);

    // Every frame, not just the last: the defect was one frame that was painted and
    // then replaced, which is exactly the frame a person sees.
    expect(page.frames.filter((frame) => frame.includes("participant-ana"))).toStrictEqual([]);
  });

  it("negative control: the recorder does see the switches while the session holds", async () => {
    // Without this, the case above would hold for a recorder that captured nothing,
    // and the frame it exists to inspect would go unexamined while the suite stayed
    // green.
    const page = renderMovableNotificationsPage(bridgeResolvingPerSession(), SESSION_ID);
    await settle();

    expect(page.frames.filter((frame) => frame.includes("participant-ana"))).not.toStrictEqual([]);
  });

  it("reads the new session's person once the frames after it settle", async () => {
    const page = renderMovableNotificationsPage(bridgeResolvingPerSession(), SESSION_ID);
    await settle();
    page.showSession(OTHER_SESSION_ID);
    await settle();

    expect(page.container.textContent ?? "").toContain("participant-bo");
  });
});
