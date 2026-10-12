// The hand of a touch fling: touch events sent over the DevTools protocol at the hand's speed and
// not waited on, so a page busy with its own work does not hold the hand back, as a real one is
// not. The browser recognizes the drag and flings at the hand's speed once it lets go.
//
// A synthesized scroll gesture with a touch source would be shorter to write, but headless
// Chromium on Linux drops its moves and the box never scrolls; touch events scroll there too.

import { setTimeout as delay } from "node:timers/promises";

import type { CDPSession } from "playwright";

/** One touch fling: where the hand lands, how far it travels and how fast. */
export interface TouchFlingGesture {
  /** Where the hand lands, in the CSS pixels of the page the session drives. */
  readonly x: number;
  readonly y: number;
  /** How far the hand travels down the screen: toward a list's head when positive. */
  readonly distancePx: number;
  /** The hand's speed, in pixels a second. */
  readonly speed: number;
}

/**
 * How often the hand's place is sampled, as a touch screen samples it: four times a 60 Hz frame,
 * so a frame the page draws late never meets more than a sample's share of travel over a frame's.
 */
const HAND_SAMPLE_INTERVAL_MS = 1000 / 240;

/**
 * Plays `gesture` through `cdpSession`: the hand lands, travels at its speed one sample at a time,
 * each stamped with the time the hand reached that place, and lets go at full speed. Resolves once
 * the browser has taken every touch; the momentum after it is the caller's to wait for.
 */
export async function playTouchFling(
  cdpSession: CDPSession,
  gesture: TouchFlingGesture,
): Promise<void> {
  const travelMs = (Math.abs(gesture.distancePx) / gesture.speed) * 1000;
  const sampleCount = Math.max(1, Math.ceil(travelMs / HAND_SAMPLE_INTERVAL_MS));
  const touch = (
    type: "touchStart" | "touchMove" | "touchEnd",
    y: number | undefined,
    atMs: number,
  ): Promise<unknown> =>
    cdpSession.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: y === undefined ? [] : [{ x: gesture.x, y }],
      // The protocol's time stamps are seconds since the epoch.
      timestamp: (performance.timeOrigin + atMs) / 1000,
    });
  const startedAtMs = performance.now();
  // Each touch is sent on time and not waited on, so the hand moves on whatever the page does.
  const sent = [touch("touchStart", gesture.y, startedAtMs)];
  for (let sample = 1; sample <= sampleCount; sample += 1) {
    const atMs = startedAtMs + (travelMs * sample) / sampleCount;
    await delay(Math.max(0, atMs - performance.now()));
    sent.push(touch("touchMove", gesture.y + (gesture.distancePx * sample) / sampleCount, atMs));
  }
  sent.push(touch("touchEnd", undefined, startedAtMs + travelMs));
  await Promise.all(sent);
}
