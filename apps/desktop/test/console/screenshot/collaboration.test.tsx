// The screenshot tier for the collaboration family: the two destinations it owns,
// and the three surfaces inside a session it fills a seat with.
//
// `Spec-023 §Console Test Tiers` names a screenshot tier "per component and per
// scheme", and this family is split across both halves of that sentence. Two of
// its surfaces are whole destinations the frame mounts — the all-sessions list and
// the settings frame — so those are captured THROUGH `ConsoleRoot` at the address a
// person types, which is the only way to pin the composition rather than the
// component: the rail beside it, the surface's own width, and the scheme the frame
// stamped are all part of what a reviewer is looking at.
//
// The other three — the channel list, the roster, and the sent-invite ledger — are
// sidebar sections. Their host is another family's workspace surface, which has not
// landed, so mounting them through the frame today would capture the frame's
// reserved-slot absence and call it a channel list. They are captured as components
// instead, which is the other half of the same sentence, and each is driven by the
// same loaded state its own unit test drives it with rather than by a shape written
// for a picture.
//
// The family stylesheet is imported through the family's own door, for its side
// effect. A component mounted without it renders unstyled and the capture would pin
// a layout nobody ships.
//
// Every reference name below is UN-MINTED at the time this file lands. The tier
// compares against images the `macos-15` runner renders and this lane cannot mint
// one; they are produced by dispatching
// `.github/workflows/console-screenshot-baselines.yml` with `mode: regenerate` on
// this branch. Until that runs, this file is red on `darwin` and skipped everywhere
// else, which is the honest state — a lane that wrote its own references would have
// committed images no CI run reproduces.

import type {
  ChannelListResponseChannel,
  PresenceReadResponseParticipant,
} from "@ai-sidekicks/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme, pressKeys, renderSettled } from "../console-harness.js";
import {
  announceOffPinnedPlatform,
  requireCapturedElement,
  skipOffPinnedPlatform,
} from "./baseline-platform.js";

import "../../../src/renderer/src/console/collaboration/index.js";
import { ManualClock } from "../../../src/renderer/src/console/core/index.js";
import {
  ConsoleRoot,
  installMeridianTokens,
} from "../../../src/renderer/src/console/frame/index.js";
import {
  COLLABORATION_SCENARIO,
  COLLABORATION_SCENARIO_ID,
} from "../../../src/renderer/src/console/bridge/scenarios/collaboration.js";
import { createFixtureBridge } from "../../../src/renderer/src/console/bridge/index.js";
import {
  ActivityIndicatorRegistry,
  type ChannelActivityLabels,
} from "../../../src/renderer/src/console/collaboration/activity-model.js";
import { ChannelList } from "../../../src/renderer/src/console/collaboration/ChannelList.js";
import { rosterRowsFrom } from "../../../src/renderer/src/console/collaboration/presence-model.js";
import { Roster } from "../../../src/renderer/src/console/collaboration/Roster.js";
import { SentInvites } from "../../../src/renderer/src/console/collaboration/SentInvites.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/index.js";
import { ParticipantHueAllocator } from "../../../src/renderer/src/console/tokens/index.js";

/** The instant the roster's "last seen" figures are relative to. Fixed, so the capture is. */
const CAPTURE_INSTANT_MILLISECONDS = Date.parse("2026-01-01T10:00:00.000Z");

/** Identifiers render as themselves here: a capture must not depend on a name read. */
const LABELS: ChannelActivityLabels = {
  participantLabel: (participantId) => participantId.replace("participant-", ""),
  runLabel: (runId) => runId,
};

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

describe("screenshot — the destinations this family owns", () => {
  announceOffPinnedPlatform();

  for (const scheme of CONSOLE_SCHEMES) {
    it(`renders the sessions destination in the ${scheme} scheme`, async (context) => {
      skipOffPinnedPlatform(context);
      await emulateSystemScheme(scheme);
      document.location.hash = "#/sessions";
      const { container } = await renderSettled(
        <ConsoleRoot scenarioId={COLLABORATION_SCENARIO_ID} />,
      );

      await expect(requireCapturedElement(container, ".meridian-sessions")).toMatchScreenshot(
        `collaboration-sessions-${scheme}`,
      );
    });

    it(`renders the settings frame in the ${scheme} scheme`, async (context) => {
      skipOffPinnedPlatform(context);
      await emulateSystemScheme(scheme);
      document.location.hash = "#/settings";
      const { container } = await renderSettled(
        <ConsoleRoot scenarioId={COLLABORATION_SCENARIO_ID} />,
      );

      await expect(requireCapturedElement(container, ".meridian-settings")).toMatchScreenshot(
        `collaboration-settings-${scheme}`,
      );
    });
  }

  it("renders the settings frame with a search term entered", async (context) => {
    // The search is the settings surface's one interaction, and it changes the rail
    // into a result list — a different composition, not a different value, which is
    // why it earns a capture of its own rather than a unit assertion on a count.
    skipOffPinnedPlatform(context);
    await emulateSystemScheme("light");
    document.location.hash = "#/settings";
    const { container } = await renderSettled(
      <ConsoleRoot scenarioId={COLLABORATION_SCENARIO_ID} />,
    );
    const searchField = requireCapturedElement(container, ".meridian-settings__search-input");
    (searchField as HTMLInputElement).focus();
    await pressKeys("scheme");

    await expect(requireCapturedElement(container, ".meridian-settings")).toMatchScreenshot(
      "collaboration-settings-search-light",
    );
  });
});

describe("screenshot — the surfaces this family fills a seat with", () => {
  it("renders the channel list, main first and archived collapsed", async (context) => {
    skipOffPinnedPlatform(context);
    await emulateSystemScheme("light");
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

    await expect(requireCapturedElement(container, ".meridian-channels")).toMatchScreenshot(
      "collaboration-channels-light",
    );
  });

  it("renders the roster with presence, each row in its own hue", async (context) => {
    skipOffPinnedPlatform(context);
    await emulateSystemScheme("light");
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
        nowMilliseconds={CAPTURE_INSTANT_MILLISECONDS}
        labels={LABELS}
        composingChannelFor={(participantId) =>
          participantId === "participant-priya" ? "review" : undefined
        }
        isLastKnown={false}
      />,
    );

    await expect(requireCapturedElement(container, ".meridian-roster")).toMatchScreenshot(
      "collaboration-roster-light",
    );
  });

  it("renders the sent-invite ledger over the fixture's own read", async (context) => {
    // The real fixture bridge and the family's own scenario, because this component
    // performs its own read: handing it a hand-written state would capture a ledger
    // nobody's build produces, and the fixture serves `invitesList` from exactly the
    // scenario the two destinations above are captured under.
    skipOffPinnedPlatform(context);
    await emulateSystemScheme("light");
    const { container } = await renderSettled(
      <SentInvites
        bridge={createFixtureBridge({ scenario: COLLABORATION_SCENARIO })}
        sessionId={COLLABORATION_SCENARIO.sessionId}
      />,
    );

    await expect(requireCapturedElement(container, ".meridian-invites")).toMatchScreenshot(
      "collaboration-invites-light",
    );
  });
});
