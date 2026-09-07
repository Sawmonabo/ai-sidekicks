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

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emulateSystemScheme, renderSettled } from "../console-harness.js";
import {
  PLANTED_VIOLATION_RULE_ID,
  describeViolations,
  plantAxeViolation,
  runTierAxe,
} from "./axe-run.js";

import "../../../src/renderer/src/console/collaboration/index.js";
// The settings family's door, for its stylesheet: the nodes page below is audited as
// a component, and contrast is measured on the rendered composition rather than on
// the token table, so a page audited unstyled would report a palette nobody ships.
import "../../../src/renderer/src/console/settings/index.js";
// The notifications sub-module's door, for its stylesheet: the notification center
// below is audited as a component, and its coverage warning is a block of muted text
// over a list of inline refusals — pairs the token table alone cannot measure.
import "../../../src/renderer/src/console/sessions/notifications/index.js";
import { ManualClock } from "../../../src/renderer/src/console/core/index.js";
import {
  ConsoleRoot,
  installMeridianTokens,
} from "../../../src/renderer/src/console/frame/index.js";
import {
  createFixtureBridge,
  growthUnavailable,
} from "../../../src/renderer/src/console/bridge/index.js";
import {
  COLLABORATION_SCENARIO,
  COLLABORATION_SCENARIO_ID,
} from "../../../src/renderer/src/console/bridge/scenarios/collaboration.js";
import { ActivityIndicatorRegistry } from "../../../src/renderer/src/console/collaboration/activity-model.js";
import { ChannelList } from "../../../src/renderer/src/console/collaboration/channels/ChannelList.js";
import { rosterRowsFrom } from "../../../src/renderer/src/console/collaboration/members/presence-model.js";
import { Roster } from "../../../src/renderer/src/console/collaboration/members/Roster.js";
import { SentInvites } from "../../../src/renderer/src/console/collaboration/invites/SentInvites.js";
import { NotificationCenter } from "../../../src/renderer/src/console/sessions/notifications/NotificationCenter.js";
import { AttentionPlane } from "../../../src/renderer/src/console/sessions/notifications/attention-plane.js";
import { RuntimeNodesPage } from "../../../src/renderer/src/console/settings/pages/runtime-nodes/RuntimeNodesPage.js";
import type { SettingsPageContext } from "../../../src/renderer/src/console/settings/settings-page-registry.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/tokens.js";
import { ParticipantHueAllocator } from "../../../src/renderer/src/console/tokens/index.js";
import {
  COLLABORATION_INSTANT_MILLISECONDS,
  LABELS,
  ROSTER_AXES_DISAGREE_MS,
  channel,
  participant,
} from "../surfaces/collaboration-fixtures.js";
import { UNREPORTED_SHELL_STATE } from "../../../src/renderer/src/console/store/index.js";

/** Every destination this family owns, by the address a person types. */
const FAMILY_DESTINATIONS: readonly { readonly label: string; readonly hash: string }[] = [
  { label: "all-sessions list", hash: "#/sessions" },
  { label: "settings frame", hash: "#/settings" },
];

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

        expect(describeViolations(await runTierAxe(container))).toStrictEqual([]);
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
        onReopen={() => undefined}
      />,
    );

    expect(describeViolations(await runTierAxe(container))).toStrictEqual([]);
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
        state={{
          kind: "loaded",
          value: { participants, readAtMilliseconds: COLLABORATION_INSTANT_MILLISECONDS },
        }}
        rows={rosterRowsFrom(
          participants,
          (participantId) => allocator.assignmentFor(participantId),
          "participant-sawyer",
        )}
        nowMilliseconds={COLLABORATION_INSTANT_MILLISECONDS}
        labels={LABELS}
        composingChannelFor={(participantId) =>
          participantId === "participant-priya" ? "review" : undefined
        }
        isLastKnown={false}
        onReopen={() => undefined}
      />,
    );

    expect(describeViolations(await runTierAxe(container))).toStrictEqual([]);
  });

  it("has no axe violation in the sent-invite ledger", async () => {
    const { container } = await renderSettled(
      <SentInvites
        bridge={createFixtureBridge({ scenario: COLLABORATION_SCENARIO })}
        sessionId={COLLABORATION_SCENARIO.sessionId}
      />,
    );

    expect(describeViolations(await runTierAxe(container))).toStrictEqual([]);
  });

  it("has no axe violation on the settings nodes page with a roster served", async () => {
    // The page rather than the `#/settings/nodes` destination: its roster is
    // session-scoped and a window opened straight at a settings address has opened
    // none, so the destination would audit the "belongs to a session" absence and
    // never a rendered roster.
    const bridge = createFixtureBridge({ scenario: COLLABORATION_SCENARIO });
    bridge.scenarioEngine?.advance(ROSTER_AXES_DISAGREE_MS);
    const pageContext: SettingsPageContext = {
      bridge,
      openSection: () => undefined,
      retainedSessionId: COLLABORATION_SCENARIO.sessionId,
      retainedSessionStore: undefined,
      shellState: UNREPORTED_SHELL_STATE,
    };
    const { container } = await renderSettled(<RuntimeNodesPage context={pageContext} />);
    // An audit of the loading arm would be an audit of a spinner: assert the roster
    // is the thing on screen before measuring it.
    expect(container.querySelector('[aria-label="node-roster-loaded"]')).not.toBeNull();

    expect(describeViolations(await runTierAxe(container))).toStrictEqual([]);
  });

  it("has no axe violation in the notification center's partial reading", async () => {
    // The arm the destination capture cannot reach: the fixture serves the attention
    // projection for every session it is asked about, so the coverage warning — a
    // `not-checked` absence over a list of per-session refusals — only appears when a
    // session refuses. It is a composition of its own, with its own live region and
    // its own contrast pairs, so it is audited rather than assumed.
    const { container } = await renderSettled(
      <NotificationCenter
        reading={{
          phase: "read",
          plane: new AttentionPlane([]),
          droppedCount: 0,
          refusedSessions: [
            {
              sessionId: COLLABORATION_SCENARIO.sessionId,
              refusal: growthUnavailable("attentionProjectionRead"),
            },
          ],
        }}
      />,
    );

    expect(describeViolations(await runTierAxe(container))).toStrictEqual([]);
  });

  it("finds a planted violation, so every clean result above means something", async () => {
    // axe returning nothing is the expected result, and a misconfigured run — wrong
    // root, wrong tags, an exception swallowed — returns exactly the same nothing.
    const planted = plantAxeViolation();
    try {
      const violations = await runTierAxe(planted);
      expect(violations.map((violation) => violation.id)).toContain(PLANTED_VIOLATION_RULE_ID);
    } finally {
      planted.remove();
    }
  });
});
