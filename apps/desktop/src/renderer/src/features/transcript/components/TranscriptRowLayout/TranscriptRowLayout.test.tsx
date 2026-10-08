// The row's load-bearing decisions: attribution fails closed for a hue step off the wheel (a
// wrap would attribute the row to the wrong user), a superseded row says so, and its time is
// written on the clock the machine is set to, read through the bridge, never the UI language's,
// and redrawn when the machine's clock changes.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { appFactsSwitches, readAppFactsSwitches, type MachineClock } from "#shared/app-facts.js";
import { createStubBridge } from "#shared/preload-api.js";
import { HUE_WHEEL_STEPS } from "#renderer/styles/palette.js";
import { FIXTURE_APP_META, FIXTURE_WINDOW_ID } from "#renderer/services/platform/bridge.fixture.js";
import { createLiveBridge } from "#renderer/services/platform/live-bridge.js";
import { bridgeWrapper, liveBridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { TranscriptRowLayout } from "./TranscriptRowLayout.js";

const OCCURRED_AT = "2026-09-01T13:04:05.123Z";

function renderRow(element: React.JSX.Element): HTMLElement {
  const { container } = render(element, { wrapper: liveBridgeWrapper() });
  const row = container.firstElementChild;
  if (!(row instanceof HTMLElement)) {
    throw new Error("TranscriptRowLayout rendered no element");
  }
  return row;
}

function edgeOf(row: HTMLElement): HTMLElement {
  const edge = row.querySelector(".meridian-transcript-row-layout__edge");
  if (!(edge instanceof HTMLElement)) {
    throw new Error("TranscriptRowLayout rendered no leading edge");
  }
  return edge;
}

function basicRow(
  overrides: Partial<React.ComponentProps<typeof TranscriptRowLayout>> = {},
): HTMLElement {
  return renderRow(
    <TranscriptRowLayout
      agentHueStep={0}
      occurredAtIso={OCCURRED_AT}
      authorLabel="Ada"
      {...overrides}
    />,
  );
}

describe("TranscriptRowLayout: attribution fails closed, never into another's hue", () => {
  it("refuses to wrap or clamp a step that is off the wheel", () => {
    const offWheelSteps = [HUE_WHEEL_STEPS, HUE_WHEEL_STEPS + 3, -1, 1.5, Number.NaN];
    const onWheelHues = Array.from({ length: HUE_WHEEL_STEPS }, (_unused, step) =>
      edgeOf(basicRow({ agentHueStep: step })).style.getPropertyValue("--meridian-row-hue"),
    );

    for (const step of offWheelSteps) {
      const row = basicRow({ agentHueStep: step });
      const hue = edgeOf(row).style.getPropertyValue("--meridian-row-hue");
      expect(row.classList.contains("meridian-transcript-row-layout--unattributed")).toBe(true);
      expect(hue).toBe("var(--meridian-edge-strong)");
      // A modulo wrap would land step 12 on step 0's hue and step 15 on step 3's.
      expect(onWheelHues).not.toContain(hue);
    }

    // The on-wheel hues are twelve distinct values, so the assertion above checks a populated
    // set.
    expect(new Set(onWheelHues).size).toBe(HUE_WHEEL_STEPS);
  });
});

describe("TranscriptRowLayout — superseded rows and the revealed footer", () => {
  it("marks a superseded row in its class and in visible text", () => {
    const row = basicRow({ isSuperseded: true });
    expect(row.classList.contains("meridian-transcript-row-layout--superseded")).toBe(true);
    expect(row.querySelector(".meridian-transcript-row-layout__superseded-mark")?.textContent).toBe(
      "Superseded",
    );

    const ordinary = basicRow();
    expect(ordinary.classList.contains("meridian-transcript-row-layout--superseded")).toBe(false);
    expect(ordinary.querySelector(".meridian-transcript-row-layout__superseded-mark")).toBeNull();
  });
});

describe("TranscriptRowLayout — the time on the machine's own clock", () => {
  it("reads 2:20 PM on a 12-hour clock, then 14:20 once the machine turns 24-hour time on", () => {
    // The facts go through main's switches and the preload's read of them, as a window's do: a US
    // machine at its 12-hour clock under a US English UI language.
    const app = readAppFactsSwitches(
      appFactsSwitches({
        ...FIXTURE_APP_META,
        locale: "en-US",
        regionLocale: "en-US",
        hourCycle: "h12",
      }),
    );
    const handlers: ((clock: MachineClock) => void)[] = [];
    const stub = createStubBridge(app, FIXTURE_WINDOW_ID);
    const bridge = createLiveBridge({
      ...stub,
      app: {
        ...stub.app,
        subscribeMachineClock: (handler) => {
          handlers.push(handler);
          return () => undefined;
        },
      },
    });
    // A local wall-clock instant, so the figure is the same in every time zone.
    const occurredAtIso = new Date(2026, 9, 6, 14, 20, 5).toISOString();
    const { container } = render(
      <TranscriptRowLayout agentHueStep={0} occurredAtIso={occurredAtIso} authorLabel="Ada" />,
      { wrapper: bridgeWrapper(bridge) },
    );
    const time = (): string | null =>
      container.querySelector(`[data-hover-label="${occurredAtIso}"]`)?.textContent ?? null;
    expect(time()).toBe("2:20:05 PM");

    act(() => {
      for (const handler of handlers) {
        handler({ regionLocale: "en-US", hourCycle: "h23" });
      }
    });

    expect(time()).toBe("14:20:05");
  });
});
