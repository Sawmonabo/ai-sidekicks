// Reading an incident recording back: the player, and the scenario it composes.
//
// `incident-recording.ts` owns what a recording IS and what writes one. This module owns
// the other direction, and the two halves are apart because the reader has a dependency
// the writer must not have: it crosses the console's OWN decode boundary,
// `bridge/daemon/session-event-payload.ts`, which is the whole point of a recording.
//
// WHY THE BOUNDARY AND NOT A SCHEMA PARSE. A recording could be validated against
// `EventEnvelopeSchema` and turned into beats by hand, and it would prove less than
// nothing: the defect class an incident exists for is a console that reads a frame the
// wire does send. So the player parses text into a value and hands that value to the
// same function a live subscription hands its deliveries to. What comes back is what
// the console would hold. If the boundary stops admitting a recorded frame, the replay
// refuses it, and the seeded incident's own suite fails — which is the alarm.
//
// AND THE COMPOSITION IS HERE RATHER THAN UNDER `scenarios/`, for the reason that
// directory's header gives: `scenarios/` holds INSTANCES, one per seat on the board, and
// this turns any recording into a playable one. The instance is the recording plus the
// session it belongs to; the machinery that joins them is the runtime's.

import { readConsoleSessionEvent } from "../../daemon/session-event-payload.js";
import type { IncidentRecording } from "./incident-recording.js";
import type { ConsoleScenario, ScenarioBeat } from "../scenario.js";

/** One recorded frame the console cannot read back, and why. */
export interface IncidentReplayRefusal {
  /** Position in the recording's own `deltas`, which is what a person opens to fix it. */
  readonly deltaIndex: number;
  readonly reason: string;
}

/**
 * Plays a recording back through the console's decode boundary.
 *
 * A CLASS rather than a function because the answer has two halves a caller reads
 * separately — the beats that replayed and the frames that refused — and because the
 * work is done ONCE, at construction: a scenario composed from a recording reads the
 * beats, its suite reads the refusals, and neither should re-parse the recording to do
 * it.
 */
export class IncidentPlayer {
  readonly #recording: IncidentRecording;
  readonly #beats: readonly ScenarioBeat[];
  readonly #refusals: readonly IncidentReplayRefusal[];

  public constructor(recording: IncidentRecording) {
    const beats: ScenarioBeat[] = [];
    const refusals: IncidentReplayRefusal[] = [];
    for (const [deltaIndex, delta] of recording.deltas.entries()) {
      const frame = parseRecordedFrame(delta.frameJson);
      if (frame === undefined) {
        refusals.push({
          deltaIndex,
          reason:
            "its text is not JSON, so no frame was recorded here at all. A recording holds " +
            "what a transport delivered; a delta whose text will not parse was edited by " +
            "hand or written by something that was not a recorder.",
        });
        continue;
      }
      const event = readConsoleSessionEvent(frame);
      if (event === undefined) {
        refusals.push({
          deltaIndex,
          reason:
            "the console's own decode boundary refused it. Either the recorded frame is not " +
            "an event envelope, or this console no longer reads a frame it used to read — " +
            "which is the defect an incident recording exists to catch, and is never a " +
            "reason to edit the recording.",
        });
        continue;
      }
      beats.push({ atMs: delta.atMs, event });
    }
    this.#recording = recording;
    this.#beats = beats;
    this.#refusals = refusals;
  }

  /** The recording this player was built from. */
  public get recording(): IncidentRecording {
    return this.#recording;
  }

  /** The beats that replayed, in recorded order. */
  public get beats(): readonly ScenarioBeat[] {
    return this.#beats;
  }

  /** The frames that did not. Empty is the passing state. */
  public get refusals(): readonly IncidentReplayRefusal[] {
    return this.#refusals;
  }
}

/** Everything a scenario states about itself except the script, which the recording is. */
export type IncidentScenarioShape = Omit<ConsoleScenario, "beats">;

/**
 * Compose the scenario one recording plays as.
 *
 * THROWS on any refusal, and the throw is the design rather than a missing arm. A
 * recording is DATA in this repository, not an input a window receives: it either reads
 * back or the build is wrong, and a composer that quietly dropped the frames it could
 * not read would put a truncated script on the scenario picker under the name of a
 * defect it no longer reproduces. `consoleScenario()` throws on the same reasoning for
 * the same reason — a caller asking for a scenario that is not there has a bug — and the
 * seeded incident's co-located suite is what reaches this before any window does.
 */
export function composeIncidentScenario(
  recording: IncidentRecording,
  shape: IncidentScenarioShape,
): ConsoleScenario {
  const player = new IncidentPlayer(recording);
  if (player.refusals.length > 0) {
    const detail = player.refusals
      .map((refusal) => `delta ${String(refusal.deltaIndex)}: ${refusal.reason}`)
      .join("\n");
    throw new RangeError(
      `the incident recording "${recording.incidentId}" does not replay: ${String(player.refusals.length)} of ${String(recording.deltas.length)} recorded frames were refused.\n${detail}`,
    );
  }
  return { ...shape, beats: player.beats };
}

/**
 * The value one recorded frame's text holds, or `undefined` where it holds none.
 *
 * `undefined` is unambiguous as the failure answer: `JSON.parse` never returns it — the
 * text `"undefined"` is not JSON and throws — so the only way to reach it here is the
 * catch.
 */
function parseRecordedFrame(frameJson: string): unknown {
  try {
    return JSON.parse(frameJson) as unknown;
  } catch {
    return undefined;
  }
}
