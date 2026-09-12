// The seeded incident: the session whose log outgrew the ledger's window.
//
// The first member of the `incident` class `Spec-023 §Console Design (Meridian)`
// §The fixture bridge names — a scenario whose script is a RECORDING rather than an
// authored beat list. What the recording is and why it is bytes lives beside the frames
// in `ledger-window-growth-frames.ts` and in `scenario/runtime/incident/incident-recording.ts`;
// what is here is the session those frames belong to, which a recording of a wire
// cannot carry: who was in it, what its reads answer, and where the frame worth pinning
// falls.
//
// SCRIPTED THIN ON PURPOSE. One read is scripted, `session.read`, and everything else
// this window asks for is refused as the honest "nobody answered". An incident is
// evidence, and padding it with a roster and a registry nobody recorded would make the
// replay a demo of the surfaces that happened to be convenient rather than a replay of
// the session that broke. The frames are the claim; the rest of the scenario states only
// what the frames themselves need to render at all.

import {
  composeIncidentScenario,
  type ConsoleScenario,
  type IncidentRecording,
} from "../runtime/index.js";
import { LEDGER_WINDOW_GROWTH_DELTAS } from "./ledger-window-growth-frames.js";

export const LEDGER_WINDOW_GROWTH_INCIDENT_SCENARIO_ID = "incident-ledger-window-growth";

const SESSION_ID = "019b7a10-4c00-7d31-9f02-6b1a5e900001";
const PARTICIPANT_YOU = "019b7a10-4c00-79a4-8110-2c40117a0001";
const LANE_AGENT_IDS = [
  "019b7a10-4c00-79a4-8110-2c40117a0011",
  "019b7a10-4c00-79a4-8110-2c40117a0012",
  "019b7a10-4c00-79a4-8110-2c40117a0013",
  "019b7a10-4c00-79a4-8110-2c40117a0014",
] as const;

/** The recording itself, published so a suite can assert what it holds. */
export const LEDGER_WINDOW_GROWTH_RECORDING: IncidentRecording = {
  incidentId: "ledger-window-growth",
  summary:
    "A session whose log outgrew the ledger's window grew the surface instead of scrolling inside it, so every admitted row stayed mounted and the whole log was laid out and painted every frame. The four-lane frame-time reading and the steady-state heap growth both went past their ceilings.",
  recordedAtIso: "2026-01-14T11:20:00.000Z",
  deltas: LEDGER_WINDOW_GROWTH_DELTAS,
};

/**
 * The scenario the recording plays as.
 *
 * Composed at module evaluation and not memoized behind a function, for the same reason
 * every other scenario on the seat board is a constant: the board is read at boot and
 * the composition is a walk over fifty-one frames. It THROWS if the recording no longer
 * replays, which is the alarm `incident-replay.ts` describes — and which the co-located
 * suite reaches long before a window does.
 */
export const LEDGER_WINDOW_GROWTH_INCIDENT_SCENARIO: ConsoleScenario = composeIncidentScenario(
  LEDGER_WINDOW_GROWTH_RECORDING,
  {
    id: LEDGER_WINDOW_GROWTH_INCIDENT_SCENARIO_ID,
    label: "Incident — ledger window growth",
    purpose:
      "The recorded session behind the ledger-window-growth defect, replayed from the wire frames it arrived on: four lanes talking at a steady tick until the log is longer than the window that holds it.",
    sessionId: SESSION_ID,
    // The person, then the four lanes in the order they first spoke — which is the hue
    // allocator's input, and the order the recording itself establishes.
    participantIdsInJoinOrder: [PARTICIPANT_YOU, ...LANE_AGENT_IDS],
    viewingParticipantId: PARTICIPANT_YOU,
    startedAtIso: "2026-01-14T11:20:00.000Z",
    replies: [
      {
        call: "session.read",
        result: {
          session: {
            id: SESSION_ID,
            state: "active",
            config: {},
            metadata: {},
            createdAt: "2026-01-14T11:20:00.000Z",
            updatedAt: "2026-01-14T11:20:20.000Z",
          },
          timelineCursors: { latest: "ledger-window-growth-cursor-51" },
        },
      },
    ],
  },
);
