// The handshake read has four phases, and exactly one of them puts anything on screen.
//
// Every case drives the REAL hook over a REAL port — the fixture's for the scripted
// answers, the refusing one for a window that has no seam to ask through, and a real
// port with exactly one method replaced where the case needs an answer no shipped
// scenario states. A hand-written promise shaped like a port would agree with whatever
// the hook did with it, which is the one thing these cases are for.
//
// AND THE SUPPRESSION CLAIM IS STRUCTURAL. `ConsoleVersionReading` carries the mismatch
// on the refused arm and on no other, so "a healthy window shows nothing" and "a window
// that has not heard back shows nothing stale" are asserted by narrowing rather than by
// reading a field back — an arm with no facts on it has no version pair to have kept.
// The last describe closes that from the other end, in the composed window.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, type GrowthPort } from "../bridge/index.js";
import {
  createRefusingGrowthPort,
  type GrowthServedValue,
} from "../bridge/growth-port/growth-port.js";
import { FLAGSHIP_SCENARIO, FLAGSHIP_SCENARIO_ID } from "../bridge/scenarios/flagship.js";
import { LEDGER_SCENARIO, LEDGER_SCENARIO_ID } from "../bridge/scenarios/ledger.js";
import { settleReactWork } from "../core/act-settlement.test-support.js";
import { liveRegionText } from "../primitives/live-region.test-support.js";
import { parseRoute } from "../routing/index.js";
import { FrameStore } from "../store/index.js";
import { SESSIONS_HASH, mountConsole } from "./ConsoleRoot.test-support.js";
import {
  VERSION_BANNER_ID,
  useConsoleVersionReading,
  useVersionBannerRaise,
  type ConsoleVersionReading,
} from "./version-banner.js";

/** The version this console proposes in every case below. */
const CONSOLE_VERSION = "2026-05-01";

/** A version the runtime speaks and this console does not. */
const RUNTIME_ONLY_VERSION = "2026-09-01";

/** A real port with exactly one method answering a stated handshake. */
function handshakePort(value: GrowthServedValue<"daemonNegotiationRead">): GrowthPort {
  return {
    ...createRefusingGrowthPort(),
    daemonNegotiationRead: async () => ({ status: "served", value }),
  };
}

function ReadingProbe(props: {
  readonly growth: GrowthPort;
  readonly onObserve: (reading: ConsoleVersionReading) => void;
}): React.JSX.Element {
  props.onObserve(useConsoleVersionReading(props.growth));
  return <></>;
}

function observeReading(growth: GrowthPort): ConsoleVersionReading[] {
  const observed: ConsoleVersionReading[] = [];
  render(
    <ReadingProbe
      growth={growth}
      onObserve={(reading) => {
        observed.push(reading);
      }}
    />,
  );
  return observed;
}

function lastReading(observed: readonly ConsoleVersionReading[]): ConsoleVersionReading {
  const reading = observed.at(-1);
  if (reading === undefined) {
    throw new Error("the probe never rendered, so there is no reading to read");
  }
  return reading;
}

afterEach(() => {
  cleanup();
});

describe("useConsoleVersionReading — one read, four phases", () => {
  it("shows nothing at all while the read is in flight", () => {
    const observed = observeReading(
      handshakePort({
        compatible: true,
        consoleProtocolVersion: CONSOLE_VERSION,
        daemonProtocolVersion: CONSOLE_VERSION,
      }),
    );

    // The first phase is load-bearing: a reading that started settled would decide
    // what to draw for a handshake nobody had read back yet.
    expect(observed[0]).toStrictEqual({ phase: "reading" });
  });

  it("is unreachable — and carries no mismatch — when the seam does not serve the read", async () => {
    const observed = observeReading(createRefusingGrowthPort());

    await settleReactWork();
    const settled = lastReading(observed);
    expect(settled.phase).toBe("unreachable");
    // "Suppressed while unreachable, never stale": the arm has no mismatch to hold,
    // so there is no last-known verdict for a later render to keep showing.
    expect(settled).not.toHaveProperty("mismatch");
    if (settled.phase === "unreachable") {
      expect(settled.refusal.code).toBe("wire-unregistered");
      expect(settled.refusal.operationId).toBe("daemonNegotiationRead");
      expect(settled.refusal.slateRow).toBe("daemon-version-negotiation");
    }
  });

  it("settles to a bare agreement — no versions, nothing to draw — when the two builds met", async () => {
    const observed = observeReading(
      handshakePort({
        compatible: true,
        consoleProtocolVersion: CONSOLE_VERSION,
        daemonProtocolVersion: CONSOLE_VERSION,
      }),
    );

    await settleReactWork();
    const settled = lastReading(observed);
    // The whole arm, asserted whole: `Spec-023` says a compatible handshake renders
    // nothing, and an arm carrying facts would be an invitation to draw them.
    expect(settled).toStrictEqual({ phase: "agreed" });
  });

  it("reads the pair AND the refusal when the runtime turned the handshake down", async () => {
    const observed = observeReading(
      handshakePort({
        compatible: false,
        reason: "version.floor_exceeded",
        consoleProtocolVersion: CONSOLE_VERSION,
        daemonProtocolVersion: RUNTIME_ONLY_VERSION,
        daemonSupportedProtocols: [RUNTIME_ONLY_VERSION],
      }),
    );

    await settleReactWork();
    const settled = lastReading(observed);
    expect(settled.phase).toBe("refused");
    if (settled.phase === "refused") {
      // The pair rides the refusal rather than being carried beside it: a person told
      // the two sides disagree and not which two versions disagreed has been told
      // nothing they can act on.
      expect(settled.mismatch.consoleProtocolVersion).toBe(CONSOLE_VERSION);
      expect(settled.mismatch.daemonProtocolVersion).toBe(RUNTIME_ONLY_VERSION);
      expect(settled.mismatch.daemonSupportedProtocols).toStrictEqual([RUNTIME_ONLY_VERSION]);
      expect(settled.mismatch.reason).toBe("version.floor_exceeded");
      expect(settled.mismatch.movingSide).toBe("console");
    }
  });

  it("keeps a refusal that published no set apart from one that published an empty one", async () => {
    const observed = observeReading(
      handshakePort({
        compatible: false,
        reason: "protocol.handshake_already_completed",
        consoleProtocolVersion: CONSOLE_VERSION,
        daemonProtocolVersion: CONSOLE_VERSION,
      }),
    );

    await settleReactWork();
    const settled = lastReading(observed);
    expect(settled.phase).toBe("refused");
    if (settled.phase === "refused") {
      // Not `[]`. The daemon omits this member on the already-completed refusal, and
      // reading the omission as an empty list would say the runtime speaks no version
      // at all — a claim nobody made.
      expect(settled.mismatch.daemonSupportedProtocols).toBeUndefined();
    }
  });
});

describe("the remedy — chosen by which side is out of range", () => {
  it.each([
    ["version.floor_exceeded", "console"],
    ["version.ceiling_exceeded", "runtime"],
    ["protocol.handshake_already_completed", "neither"],
  ] as const)("sends %s to the %s", async (reason, movingSide) => {
    const observed = observeReading(
      handshakePort({
        compatible: false,
        reason,
        consoleProtocolVersion: CONSOLE_VERSION,
        daemonProtocolVersion: RUNTIME_ONLY_VERSION,
        daemonSupportedProtocols: [RUNTIME_ONLY_VERSION],
      }),
    );

    await settleReactWork();
    const settled = lastReading(observed);
    // Asserted before the narrowing below, not only inside it: a `phase` that had
    // settled anywhere else would skip the block and pass this case having checked
    // nothing at all.
    expect(settled.phase).toBe("refused");
    if (settled.phase === "refused") {
      expect(settled.mismatch.movingSide).toBe(movingSide);
      // Every arm says reads carry on, because that is the half of the state a person
      // most needs and the half a refusal banner is least likely to carry.
      expect(settled.mismatch.remedy).toContain("Reads carry on");
    }
  });

  it("negative control: the remedy is not one sentence with the side swapped in", async () => {
    // Without this, a table whose three rows shared one sentence would satisfy every
    // case above and would tell an operator to update the console for a connection
    // fault that no installer can fix.
    const remedies = new Set<string>();
    for (const reason of [
      "version.floor_exceeded",
      "version.ceiling_exceeded",
      "protocol.handshake_already_completed",
    ] as const) {
      const observed = observeReading(
        handshakePort({
          compatible: false,
          reason,
          consoleProtocolVersion: CONSOLE_VERSION,
          daemonProtocolVersion: RUNTIME_ONLY_VERSION,
        }),
      );
      await settleReactWork();
      const settled = lastReading(observed);
      expect(settled.phase).toBe("refused");
      if (settled.phase === "refused") {
        remedies.add(settled.mismatch.remedy);
      }
      cleanup();
    }

    expect(remedies.size).toBe(3);
  });
});

describe("the fixture's own handshake outcomes", () => {
  it("serves the flagship's scripted agreement, which draws nothing", async () => {
    const outcome = await createFixtureBridge({
      scenario: FLAGSHIP_SCENARIO,
    }).growth.daemonNegotiationRead({});

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      expect(outcome.value.compatible).toBe(true);
      // The agreeing ack carries no supported set, because the daemon's does not.
      expect(outcome.value).not.toHaveProperty("daemonSupportedProtocols");
    }
  });

  it("serves the ledger's scripted refusal, so the banner is reachable from a scenario", async () => {
    const outcome = await createFixtureBridge({
      scenario: LEDGER_SCENARIO,
    }).growth.daemonNegotiationRead({});

    expect(outcome.status).toBe("served");
    if (outcome.status === "served" && !outcome.value.compatible) {
      expect(outcome.value.reason).toBe("version.floor_exceeded");
      expect(outcome.value.daemonSupportedProtocols).not.toContain(
        outcome.value.consoleProtocolVersion,
      );
    }
  });

  it("keeps both answers out of the live bridge, which still has no wire for either", async () => {
    const outcome = await createRefusingGrowthPort().daemonNegotiationRead({});

    expect(outcome.status).toBe("unavailable");
    expect(outcome).not.toHaveProperty("value");
  });
});

describe("the composed window — the banner is refusal-scoped and announced once", () => {
  it("raises ONE banner, announces its remedy, and draws the pair beneath it", async () => {
    // THE ANNOUNCEMENT IS THE CLAIM. The refusal used to be drawn straight into the
    // surface tree, so it never entered the frame's banner list and
    // `banner-announcements.ts` never saw it: a window told a person, in the widest
    // shape the grammar has, that it could no longer change the session — and told a
    // screen reader nothing at all.
    const mounted = await mountConsole({ scenarioId: LEDGER_SCENARIO_ID });

    // Exactly one, which is the duplication guard: a supplement that drew its own
    // refusal beside the frame's would put one code and one sentence on screen twice
    // and announce them once.
    const banners = mounted.container.querySelectorAll(".meridian-refusal--banner");
    expect(banners).toHaveLength(1);
    expect(banners[0]?.textContent).toContain("version.floor_exceeded");
    // Undismissable: the claim that this window cannot change the session has not
    // stopped being true, so it may not be put away.
    expect(mounted.container.querySelector(".meridian-refusal__dismiss")).toBeNull();

    // The REMEDY and not the code. Spoken, a dotted wire code is a token nobody can
    // act on, read letter by letter ahead of the sentence that matters.
    const announced = liveRegionText(mounted.container, "assertive");
    expect(announced).toContain("below the local runtime's minimum");
    expect(announced).not.toContain("version.floor_exceeded");

    // And the two facts a `FrameBanner` cannot carry, drawn once beneath that row.
    const supplements = mounted.container.querySelectorAll(".meridian-version-banner");
    expect(supplements).toHaveLength(1);
    expect(supplements[0]?.textContent).toContain("Protocol");
  });

  it("negative control: a window whose handshake AGREED mounts no element and says nothing", async () => {
    // The rule this pins is the one the surface exists for. Without it a frame that
    // rendered on the settled arm rather than the refused one would pass every case
    // above while putting a permanent version strip across every healthy window —
    // which is exactly what it did before the arms were split. Queried by class and
    // not by role: a native `<details>` carries the same implicit `group` role the
    // refusal banner does, so a role query would find some other surface's and pass.
    const mounted = await mountConsole({ scenarioId: FLAGSHIP_SCENARIO_ID });

    expect(mounted.container.querySelector(".meridian-version-banner")).toBeNull();
    expect(mounted.container.querySelector(".meridian-refusal--banner")).toBeNull();
    expect(mounted.container.textContent).not.toContain("Protocol");
    expect(liveRegionText(mounted.container, "assertive")).toBe("");
  });
});

describe("the raise — both edges, because a banner outlives the render that put it there", () => {
  /** The refused reading the cases below raise from. */
  const REFUSED: ConsoleVersionReading = {
    phase: "refused",
    mismatch: {
      reason: "version.floor_exceeded",
      consoleProtocolVersion: CONSOLE_VERSION,
      daemonProtocolVersion: RUNTIME_ONLY_VERSION,
      daemonSupportedProtocols: [RUNTIME_ONLY_VERSION],
      movingSide: "console",
      remedy: "Update the console.",
    },
  };

  function RaiseProbe(props: {
    readonly frameStore: FrameStore;
    readonly reading: ConsoleVersionReading;
  }): React.JSX.Element {
    useVersionBannerRaise(props.frameStore, props.reading);
    return <></>;
  }

  it("raises an undismissable banner carrying the reason and the remedy", () => {
    const frameStore = new FrameStore({ initialRoute: parseRoute(SESSIONS_HASH) });

    render(<RaiseProbe frameStore={frameStore} reading={REFUSED} />);

    expect(frameStore.getState().banners).toStrictEqual([
      {
        id: VERSION_BANNER_ID,
        dismissible: false,
        code: "version.floor_exceeded",
        detail: "Update the console.",
      },
    ]);
  });

  it("clears it when the reading stops being a refusal, and when the window goes away", () => {
    // The edge a bridge swap reaches: the banner list is store state that outlives
    // this render, so a raise with no matching clear leaves a permanent strip across
    // a window whose runtime it no longer describes.
    const frameStore = new FrameStore({ initialRoute: parseRoute(SESSIONS_HASH) });
    const mounted = render(<RaiseProbe frameStore={frameStore} reading={REFUSED} />);
    expect(frameStore.getState().banners).toHaveLength(1);

    mounted.rerender(<RaiseProbe frameStore={frameStore} reading={{ phase: "agreed" }} />);
    expect(frameStore.getState().banners).toStrictEqual([]);

    mounted.rerender(<RaiseProbe frameStore={frameStore} reading={REFUSED} />);
    expect(frameStore.getState().banners).toHaveLength(1);

    mounted.unmount();
    expect(frameStore.getState().banners).toStrictEqual([]);
  });

  it("negative control: a settled agreement raises nothing to begin with", () => {
    // Without this the clear above would pass against a hook that raised on no arm
    // at all, which is the state the whole announcement claim rests on not being.
    const frameStore = new FrameStore({ initialRoute: parseRoute(SESSIONS_HASH) });

    render(<RaiseProbe frameStore={frameStore} reading={{ phase: "reading" }} />);
    expect(frameStore.getState().banners).toStrictEqual([]);

    render(<RaiseProbe frameStore={frameStore} reading={{ phase: "agreed" }} />);
    expect(frameStore.getState().banners).toStrictEqual([]);
  });
});
