// The replay dock. Every case here is really one claim: the control decides
// nothing.
//
// There is no local `isPlaying` and no remembered speed in this component, and the
// way to prove that is to render the same control under different positions and
// watch what it offers change with the engine's reading rather than with anything
// it kept. The granularity sentence gets the same treatment, because
// `replay-model.ts`'s fourth rule is precisely a claim the control could make on its own.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { formatClockTime } from "../../../primitives/index.js";
import { ReplayControls } from "./ReplayControls.js";
import { REPLAY_SPEEDS, type ReplayPosition } from "./replay-model.js";

const POSITION_ISO = "2026-01-01T09:00:10.000Z";

function position(overrides: Partial<ReplayPosition> = {}): ReplayPosition {
  return {
    state: "idle",
    speed: 1,
    granularity: "turn",
    elapsedMs: 10_000,
    spanMs: 20_000,
    positionIso: POSITION_ISO,
    revealedRowIds: ["r1", "r2"],
    ...overrides,
  };
}

/** What a mounted dock lets a case observe. */
interface ReplayHarness {
  readonly dock: HTMLElement;
  readonly acts: readonly string[];
}

function renderControls(overrides: Partial<ReplayPosition> = {}, isRevealed = true): ReplayHarness {
  const acts: string[] = [];
  const view = render(
    <ReplayControls
      position={position(overrides)}
      isRevealed={isRevealed}
      onPlay={() => acts.push("play")}
      onPause={() => acts.push("pause")}
      onSpeedChange={(speed) => acts.push(`speed:${String(speed)}`)}
      onScrub={(elapsedMs) => acts.push(`scrub:${String(elapsedMs)}`)}
      onJumpToNextSeam={() => acts.push("seam")}
      onReplayFromRowInView={() => acts.push("from-here")}
    />,
  );
  // Selected by attribute rather than by role, because the harness has to reach
  // the dock in BOTH states and a hidden element has no accessible name to match
  // on — which is exactly the property the density cases below assert, with the
  // role query that walks the accessibility tree.
  const dock = view.container.querySelector<HTMLElement>('[aria-label="Session replay"]');
  if (dock === null) {
    throw new Error("the replay dock did not render");
  }
  return { dock, acts };
}

describe("replay dock — density: hidden until the surface reveals it", () => {
  it("is hidden rather than unmounted, and hidden means unreachable", () => {
    // `hidden` is inert to the pointer and to assistive technology alike, which a
    // `visibility` rule alone would not be — so the default role query, which
    // walks the accessibility tree, is the one that says so.
    const { dock } = renderControls({}, false);
    expect(dock.hasAttribute("hidden")).toBe(true);
    expect(screen.queryByRole("group", { name: "Session replay" })).toBeNull();
  });

  it("negative control: revealed, it is reachable and carries no hidden attribute", () => {
    const { dock } = renderControls({}, true);
    expect(dock.hasAttribute("hidden")).toBe(false);
    expect(screen.queryByRole("group", { name: "Session replay" })).toBe(dock);
  });
});

describe("replay dock — the primary control is the engine's state, rendered", () => {
  it("offers play from idle and calls play", () => {
    const { acts } = renderControls({ state: "idle" });
    fireEvent.click(screen.getByRole("button", { name: "Play the session back" }));
    expect(acts).toStrictEqual(["play"]);
  });

  it("offers pause while playing and calls pause", () => {
    const { acts } = renderControls({ state: "playing" });
    fireEvent.click(screen.getByRole("button", { name: "Pause the replay" }));
    expect(acts).toStrictEqual(["pause"]);
  });

  it("negative control: from paused the same control resumes rather than pausing again", () => {
    // A control holding its own `isPlaying` would disagree with the engine the
    // first time playback ended on its own — this is where that shows.
    const { acts } = renderControls({ state: "paused" });
    fireEvent.click(screen.getByRole("button", { name: "Resume the replay" }));
    expect(acts).toStrictEqual(["play"]);
  });

  it("says what pressing it at the tail will do, rather than leaving a person to find out", () => {
    const { acts } = renderControls({ state: "at-tail", elapsedMs: 20_000 });
    fireEvent.click(screen.getByRole("button", { name: "Replay from the beginning" }));
    expect(acts).toStrictEqual(["play"]);
  });
});

describe("replay dock — the speeds", () => {
  it("offers exactly the three the engine can run, and marks the current one", () => {
    renderControls({ speed: 8 });
    const speedGroup = screen.getByRole("group", { name: "Replay speed" });
    const buttons = [...speedGroup.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toStrictEqual(
      REPLAY_SPEEDS.map((speed) => `${String(speed)}×`),
    );
    expect(buttons.filter((button) => button.getAttribute("aria-pressed") === "true")).toHaveLength(
      1,
    );
    expect(screen.getByRole("button", { name: "8×" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("negative control: a control rendering a fourth speed would be offering one the engine cannot run", () => {
    renderControls({ speed: 1 });
    const speedGroup = screen.getByRole("group", { name: "Replay speed" });
    expect(speedGroup.querySelectorAll("button")).toHaveLength(REPLAY_SPEEDS.length);
    expect(screen.getByRole("button", { name: "8×" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("hands the chosen speed straight to the engine", () => {
    const { acts } = renderControls({ speed: 1 });
    for (const speed of REPLAY_SPEEDS) {
      fireEvent.click(screen.getByRole("button", { name: `${String(speed)}×` }));
    }
    expect(acts).toStrictEqual(["speed:1", "speed:8", "speed:32"]);
  });
});

describe("replay dock — the position", () => {
  it("scrubs over the loaded span and reports the change in milliseconds", () => {
    const { acts } = renderControls();
    const scrubber = screen.getByRole("slider", { name: "Replay position" });
    expect(scrubber.getAttribute("max")).toBe("20000");
    expect((scrubber as HTMLInputElement).value).toBe("10000");
    fireEvent.change(scrubber, { target: { value: "15000" } });
    expect(acts).toStrictEqual(["scrub:15000"]);
  });

  it("announces the instant rather than a bare millisecond count", () => {
    renderControls();
    expect(
      screen.getByRole("slider", { name: "Replay position" }).getAttribute("aria-valuetext"),
    ).toBe(formatClockTime(POSITION_ISO));
  });

  it("shows the position as a clock reading carrying the exact wire instant", () => {
    // Rule 4's two halves at once: the visible text is an `Intl` reading, and the
    // exact value the daemon sent rides the `title` so nothing is lost by the
    // formatting.
    const { dock } = renderControls();
    const figure = dock.querySelector(`[title="${POSITION_ISO}"]`);
    expect(figure).not.toBeNull();
    expect(figure?.textContent).not.toBe(POSITION_ISO);
    expect(figure?.textContent).toBe(formatClockTime(POSITION_ISO));
  });

  it("negative control: with nothing loaded it says so instead of showing a time", () => {
    const { dock } = renderControls({ positionIso: undefined, elapsedMs: 0, spanMs: 0 });
    expect(
      screen.getByRole("slider", { name: "Replay position" }).getAttribute("aria-valuetext"),
    ).toBe("No rows loaded");
    expect(dock.querySelector("[title]")).toBeNull();
  });

  it("jumps to the next seam through the caller's own act", () => {
    const { acts } = renderControls();
    fireEvent.click(screen.getByRole("button", { name: "Jump to the next seam" }));
    expect(acts).toStrictEqual(["seam"]);
  });
});

describe("replay dock — the granularity sentence is the engine's reading, not the control's wish", () => {
  it("says turn granularity for a replay of delivered rows", () => {
    const { dock } = renderControls({ granularity: "turn" });
    expect(dock.textContent).toContain("Replay, turn granularity");
  });

  it("negative control: only a scenario replaying its own deltas earns the finer claim", () => {
    // If the control composed this sentence itself, both readings would be the
    // same string and this pair would prove nothing.
    const { dock } = renderControls({ granularity: "stream" });
    expect(dock.textContent).toContain("Replay, stream granularity");
    expect(dock.textContent).not.toContain("turn granularity");
  });
});

describe("the replay dock — replay from the row in view", () => {
  it("runs the caller's act", () => {
    // The engine's `replayFrom` had no production caller at all: the dock's whole
    // prop surface was play, pause, speed, scrub and next-seam, and the row seat
    // carries no callback for any renderer to hang one on.
    const { dock, acts } = renderControls();
    const control = dock.querySelector<HTMLElement>(".meridian-replay__from-here");
    if (control === null) {
      throw new Error("the dock drew no replay-from-here control");
    }
    fireEvent.click(control);
    expect(acts).toStrictEqual(["from-here"]);
  });

  it("negative control: it does not appear as a second scrubber", () => {
    // A second range input would be a second record of where the replay is, and the
    // two would disagree the first time playback ended on its own.
    const { dock } = renderControls();
    expect(dock.querySelectorAll('input[type="range"]')).toHaveLength(1);
  });
});
