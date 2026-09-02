// The accessibility tier for the collaboration family.
//
// `Spec-023 §Console Test Tiers` names axe-core over every surface in both schemes,
// and this family owns five of them: two destinations the frame mounts — the
// all-sessions list and the settings frame — and three sidebar surfaces whose host
// has not landed, so they are exercised as components. The rule set, the violation
// formatting, and the planted negative control all come from `axe-run.ts`; a family
// running its own tags would report clean against a different standard.
//
// BOTH SCHEMES, DELIBERATELY, ON THE DESTINATIONS
//
// Contrast is the rule most likely to pass in one scheme and fail in the other, and
// the unit tier's contrast test measures the palette rather than the rendered
// composition — a muted label on a tinted card is a pair no token table knows
// about. The component mounts run in one scheme because they carry no surface of
// their own: they inherit the tokens the destinations are already measured under,
// and a second scheme there would re-measure the same pairs.
//
// The scheme is set through the system preference and never by stamping the
// attribute, because `ConsoleRoot` owns that attribute and overwrites a stamped one
// on its first paint — which would silently run both cases against the light
// palette and report the contrast rules as clean in a scheme nobody measured.

import type {
  ChannelListResponseChannel,
  PresenceReadResponseParticipant,
} from "@ai-sidekicks/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme, renderSettled } from "../console-harness.js";
import { axeViolationsIn, plantedViolationIds } from "./axe-run.js";

import "../../../src/renderer/src/console/collaboration/index.js";
import { ManualClock } from "../../../src/renderer/src/console/core/index.js";
import {
  ConsoleRoot,
  installMeridianTokens,
} from "../../../src/renderer/src/console/frame/index.js";
import { createFixtureBridge } from "../../../src/renderer/src/console/bridge/index.js";
import {
  COLLABORATION_SCENARIO,
  COLLABORATION_SCENARIO_ID,
} from "../../../src/renderer/src/console/bridge/scenarios/collaboration.js";
import {
  ActivityIndicatorRegistry,
  type ChannelActivityLabels,
} from "../../../src/renderer/src/console/collaboration/activity-model.js";
import { ChannelList } from "../../../src/renderer/src/console/collaboration/ChannelList.js";
import { rosterRowsFrom } from "../../../src/renderer/src/console/collaboration/presence-model.js";
import { Roster } from "../../../src/renderer/src/console/collaboration/Roster.js";
import { SentInvites } from "../../../src/renderer/src/console/collaboration/SentInvites.js";
import {
  CONSOLE_SCHEMES,
  ParticipantHueAllocator,
} from "../../../src/renderer/src/console/tokens/index.js";

/** The instant the roster's relative stamps are measured against. */
const AUDIT_INSTANT_MILLISECONDS = Date.parse("2026-01-01T10:00:00.000Z");

/** Identifiers render as themselves: an audit must not depend on a name read. */
const LABELS: ChannelActivityLabels = {
  participantLabel: (participantId) => participantId.replace("participant-", ""),
  runLabel: (runId) => runId,
};

/** Every destination this family owns, by the address a person types. */
const FAMILY_DESTINATIONS: readonly { readonly label: string; readonly hash: string }[] = [
  { label: "all-sessions list", hash: "#/sessions" },
  { label: "settings frame", hash: "#/settings" },
];

function channel(
  id: string,
  name: string,
  state: ChannelListResponseChannel["state"],
): ChannelListResponseChannel {
  return {
    id: id as ChannelListResponseChannel["id"],
    name,
    state,
    participantCount: 4,
  };
}

function participant(
  participantId: string,
  state: PresenceReadResponseParticipant["state"],
): PresenceReadResponseParticipant {
  return {
    participantId: participantId as PresenceReadResponseParticipant["participantId"],
    state,
    lastSeen: "2026-01-01T09:59:30.000Z",
  };
}

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  await emulateSystemScheme("light");
});

describe("accessibility — the destinations this family owns", () => {
  for (const scheme of CONSOLE_SCHEMES) {
    for (const destination of FAMILY_DESTINATIONS) {
      it(`has no axe violation on the ${destination.label} in the ${scheme} scheme`, async () => {
        await emulateSystemScheme(scheme);
        document.location.hash = destination.hash;
        const { container } = await renderSettled(
          <ConsoleRoot scenarioId={COLLABORATION_SCENARIO_ID} />,
        );

        expect(await axeViolationsIn(container)).toStrictEqual([]);
      });
    }
  }
});

describe("accessibility — the surfaces this family fills a seat with", () => {
  it("has no axe violation in the channel list", async () => {
    const { container } = await renderSettled(
      <ChannelList
        state={{
          kind: "loaded",
          value: [
            channel("channel-main", "main", "active"),
            channel("channel-review", "review", "active"),
            channel("channel-relay", "relay", "muted"),
            channel("channel-old", "old", "archived"),
          ],
        }}
        openPane={() => undefined}
        activity={new ActivityIndicatorRegistry(new ManualClock())}
        labels={LABELS}
        isCatchingUp={false}
      />,
    );

    expect(await axeViolationsIn(container)).toStrictEqual([]);
  });

  it("has no axe violation in the roster", async () => {
    const allocator = new ParticipantHueAllocator();
    const participants = [
      participant("participant-sawyer", "online"),
      participant("participant-priya", "idle"),
      participant("participant-implementer", "offline"),
    ];
    const { container } = await renderSettled(
      <Roster
        state={{ kind: "loaded", value: participants }}
        rows={rosterRowsFrom(
          participants,
          (participantId) => allocator.assignmentFor(participantId),
          "participant-sawyer",
        )}
        nowMilliseconds={AUDIT_INSTANT_MILLISECONDS}
        labels={LABELS}
        composingChannelFor={(participantId) =>
          participantId === "participant-priya" ? "review" : undefined
        }
        isLastKnown={false}
      />,
    );

    expect(await axeViolationsIn(container)).toStrictEqual([]);
  });

  it("has no axe violation in the sent-invite ledger", async () => {
    const { container } = await renderSettled(
      <SentInvites
        bridge={createFixtureBridge({ scenario: COLLABORATION_SCENARIO })}
        sessionId={COLLABORATION_SCENARIO.sessionId}
      />,
    );

    expect(await axeViolationsIn(container)).toStrictEqual([]);
  });

  it("finds a planted violation, so every clean result above means something", async () => {
    // axe returning nothing is the expected result, and a misconfigured run — wrong
    // root, wrong tags, an exception swallowed — returns exactly the same nothing.
    expect(await plantedViolationIds()).toContain("image-alt");
  });
});
