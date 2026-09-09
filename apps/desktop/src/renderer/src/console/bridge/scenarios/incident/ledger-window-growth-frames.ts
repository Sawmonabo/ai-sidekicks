// The recorded frames of the ledger-window-growth incident. Bytes, not a script.
//
// EVERY LINE BELOW IS A RECORDING and not an authored beat, which is why they are
// spelled as JSON text rather than as the `ConsoleSessionEvent` literals every other
// scenario in this tree is written in. `scenario-runtime/incident/incident-recording.ts` carries
// the reasoning; the consequence here is the house rule for this file: **nothing in it
// is edited to make a test pass.** A frame the console can no longer read is the finding.
//
// WHAT THE DEFECT WAS. A session's ledger surface carried a `min-height: 100%` floor and
// no ceiling above it, and the deck bounded nothing either, so a log that outgrew its
// window grew the SURFACE instead of scrolling inside it: every admitted row stayed
// mounted, and the whole log was laid out and painted every frame. Measured on the
// endurance workload at the time — 51 of 51 rows mounted in a 5541-pixel track inside a
// 768-pixel window — which took the four-lane frame-time reading from 13.60 ms to
// 23.60 ms against a 16.7 ms ceiling and the steady-state heap growth past its own.
//
// WHY THE REPLAY REPRODUCES IT AND A UNIT TEST DOES NOT. Nothing about those frames is
// unusual: no oversized payload, no malformed member, no burst. What produced the defect
// was their NUMBER against a viewport — which is a property of the session and not of any
// one row, and is therefore only reachable by replaying the session. So the recording is
// 51 frames across four concurrent lanes at a steady tick, which is the smallest thing
// that outgrows a window: one session-opening frame and fifty turns of assistant output
// and tool activity, the shape the four-lane workload actually produced.

import type { IncidentWireDelta } from "../../scenario-runtime/index.js";

/** The recorded frames, in arrival order, ticked from the recording's own start. */
export const LEDGER_WINDOW_GROWTH_DELTAS: readonly IncidentWireDelta[] = [
  {
    atMs: 0,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150000","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":1,"occurredAt":"2026-01-14T11:20:00.000Z","category":"session_lifecycle","type":"session.created","actor":"019b7a10-4c00-79a4-8110-2c40117a0001","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","config":{},"metadata":{}},"version":"1.0"}',
  },
  {
    atMs: 400,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150001","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":2,"occurredAt":"2026-01-14T11:20:00.400Z","category":"assistant_output","type":"assistant.message","actor":"019b7a10-4c00-79a4-8110-2c40117a0011","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100001","contentType":"text/markdown","contentLength":637},"version":"1.0"}',
  },
  {
    atMs: 800,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150002","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":3,"occurredAt":"2026-01-14T11:20:00.800Z","category":"assistant_output","type":"assistant.message","actor":"019b7a10-4c00-79a4-8110-2c40117a0012","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100002","contentType":"text/markdown","contentLength":654},"version":"1.0"}',
  },
  {
    atMs: 1200,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150003","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":4,"occurredAt":"2026-01-14T11:20:01.200Z","category":"assistant_output","type":"assistant.message","actor":"019b7a10-4c00-79a4-8110-2c40117a0013","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100003","contentType":"text/markdown","contentLength":671},"version":"1.0"}',
  },
  {
    atMs: 1600,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150004","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":5,"occurredAt":"2026-01-14T11:20:01.600Z","category":"assistant_output","type":"assistant.message","actor":"019b7a10-4c00-79a4-8110-2c40117a0014","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100004","contentType":"text/markdown","contentLength":688},"version":"1.0"}',
  },
  {
    atMs: 2000,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150005","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":6,"occurredAt":"2026-01-14T11:20:02.000Z","category":"tool_activity","type":"tool.invoked","actor":"019b7a10-4c00-79a4-8110-2c40117a0011","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100001","toolName":"read_file","toolCallId":"019b7a10-4c00-7c20-8b01-000000000001"},"version":"1.0"}',
  },
  {
    atMs: 2400,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150006","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":7,"occurredAt":"2026-01-14T11:20:02.400Z","category":"tool_activity","type":"tool.invoked","actor":"019b7a10-4c00-79a4-8110-2c40117a0012","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100002","toolName":"edit_file","toolCallId":"019b7a10-4c00-7c20-8b01-000100000001"},"version":"1.0"}',
  },
  {
    atMs: 2800,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150007","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":8,"occurredAt":"2026-01-14T11:20:02.800Z","category":"tool_activity","type":"tool.invoked","actor":"019b7a10-4c00-79a4-8110-2c40117a0013","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100003","toolName":"run_tests","toolCallId":"019b7a10-4c00-7c20-8b01-000200000001"},"version":"1.0"}',
  },
  {
    atMs: 3200,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150008","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":9,"occurredAt":"2026-01-14T11:20:03.200Z","category":"tool_activity","type":"tool.invoked","actor":"019b7a10-4c00-79a4-8110-2c40117a0014","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100004","toolName":"search_repository","toolCallId":"019b7a10-4c00-7c20-8b01-000300000001"},"version":"1.0"}',
  },
  {
    atMs: 3600,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150009","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":10,"occurredAt":"2026-01-14T11:20:03.600Z","category":"tool_activity","type":"tool.result","actor":"019b7a10-4c00-79a4-8110-2c40117a0011","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100001","toolName":"read_file","toolCallId":"019b7a10-4c00-7c20-8b01-000000000002","durationMs":207,"contentLength":339},"version":"1.0"}',
  },
  {
    atMs: 4000,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150010","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":11,"occurredAt":"2026-01-14T11:20:04.000Z","category":"tool_activity","type":"tool.result","actor":"019b7a10-4c00-79a4-8110-2c40117a0012","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100002","toolName":"edit_file","toolCallId":"019b7a10-4c00-7c20-8b01-000100000002","durationMs":210,"contentLength":350},"version":"1.0"}',
  },
  {
    atMs: 4400,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150011","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":12,"occurredAt":"2026-01-14T11:20:04.400Z","category":"tool_activity","type":"tool.result","actor":"019b7a10-4c00-79a4-8110-2c40117a0013","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100003","toolName":"run_tests","toolCallId":"019b7a10-4c00-7c20-8b01-000200000002","durationMs":213,"contentLength":361},"version":"1.0"}',
  },
  {
    atMs: 4800,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150012","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":13,"occurredAt":"2026-01-14T11:20:04.800Z","category":"tool_activity","type":"tool.result","actor":"019b7a10-4c00-79a4-8110-2c40117a0014","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100004","toolName":"search_repository","toolCallId":"019b7a10-4c00-7c20-8b01-000300000002","durationMs":216,"contentLength":372},"version":"1.0"}',
  },
  {
    atMs: 5200,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150013","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":14,"occurredAt":"2026-01-14T11:20:05.200Z","category":"assistant_output","type":"assistant.thinking_update","actor":"019b7a10-4c00-79a4-8110-2c40117a0011","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100001","contentType":"text/plain","contentLength":427},"version":"1.0"}',
  },
  {
    atMs: 5600,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150014","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":15,"occurredAt":"2026-01-14T11:20:05.600Z","category":"assistant_output","type":"assistant.thinking_update","actor":"019b7a10-4c00-79a4-8110-2c40117a0012","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100002","contentType":"text/plain","contentLength":436},"version":"1.0"}',
  },
  {
    atMs: 6000,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150015","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":16,"occurredAt":"2026-01-14T11:20:06.000Z","category":"assistant_output","type":"assistant.thinking_update","actor":"019b7a10-4c00-79a4-8110-2c40117a0013","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100003","contentType":"text/plain","contentLength":445},"version":"1.0"}',
  },
  {
    atMs: 6400,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150016","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":17,"occurredAt":"2026-01-14T11:20:06.400Z","category":"assistant_output","type":"assistant.thinking_update","actor":"019b7a10-4c00-79a4-8110-2c40117a0014","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100004","contentType":"text/plain","contentLength":454},"version":"1.0"}',
  },
  {
    atMs: 6800,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150017","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":18,"occurredAt":"2026-01-14T11:20:06.800Z","category":"assistant_output","type":"assistant.message","actor":"019b7a10-4c00-79a4-8110-2c40117a0011","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100001","contentType":"text/markdown","contentLength":909},"version":"1.0"}',
  },
  {
    atMs: 7200,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150018","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":19,"occurredAt":"2026-01-14T11:20:07.200Z","category":"assistant_output","type":"assistant.message","actor":"019b7a10-4c00-79a4-8110-2c40117a0012","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100002","contentType":"text/markdown","contentLength":926},"version":"1.0"}',
  },
  {
    atMs: 7600,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150019","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":20,"occurredAt":"2026-01-14T11:20:07.600Z","category":"assistant_output","type":"assistant.message","actor":"019b7a10-4c00-79a4-8110-2c40117a0013","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100003","contentType":"text/markdown","contentLength":943},"version":"1.0"}',
  },
  {
    atMs: 8000,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150020","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":21,"occurredAt":"2026-01-14T11:20:08.000Z","category":"assistant_output","type":"assistant.message","actor":"019b7a10-4c00-79a4-8110-2c40117a0014","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100004","contentType":"text/markdown","contentLength":960},"version":"1.0"}',
  },
  {
    atMs: 8400,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150021","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":22,"occurredAt":"2026-01-14T11:20:08.400Z","category":"tool_activity","type":"tool.invoked","actor":"019b7a10-4c00-79a4-8110-2c40117a0011","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100001","toolName":"read_file","toolCallId":"019b7a10-4c00-7c20-8b01-000000000001"},"version":"1.0"}',
  },
  {
    atMs: 8800,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150022","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":23,"occurredAt":"2026-01-14T11:20:08.800Z","category":"tool_activity","type":"tool.invoked","actor":"019b7a10-4c00-79a4-8110-2c40117a0012","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100002","toolName":"edit_file","toolCallId":"019b7a10-4c00-7c20-8b01-000100000001"},"version":"1.0"}',
  },
  {
    atMs: 9200,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150023","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":24,"occurredAt":"2026-01-14T11:20:09.200Z","category":"tool_activity","type":"tool.invoked","actor":"019b7a10-4c00-79a4-8110-2c40117a0013","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100003","toolName":"run_tests","toolCallId":"019b7a10-4c00-7c20-8b01-000200000001"},"version":"1.0"}',
  },
  {
    atMs: 9600,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150024","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":25,"occurredAt":"2026-01-14T11:20:09.600Z","category":"tool_activity","type":"tool.invoked","actor":"019b7a10-4c00-79a4-8110-2c40117a0014","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100004","toolName":"search_repository","toolCallId":"019b7a10-4c00-7c20-8b01-000300000001"},"version":"1.0"}',
  },
  {
    atMs: 10000,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150025","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":26,"occurredAt":"2026-01-14T11:20:10.000Z","category":"tool_activity","type":"tool.result","actor":"019b7a10-4c00-79a4-8110-2c40117a0011","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100001","toolName":"read_file","toolCallId":"019b7a10-4c00-7c20-8b01-000000000002","durationMs":255,"contentLength":515},"version":"1.0"}',
  },
  {
    atMs: 10400,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150026","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":27,"occurredAt":"2026-01-14T11:20:10.400Z","category":"tool_activity","type":"tool.result","actor":"019b7a10-4c00-79a4-8110-2c40117a0012","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100002","toolName":"edit_file","toolCallId":"019b7a10-4c00-7c20-8b01-000100000002","durationMs":258,"contentLength":526},"version":"1.0"}',
  },
  {
    atMs: 10800,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150027","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":28,"occurredAt":"2026-01-14T11:20:10.800Z","category":"tool_activity","type":"tool.result","actor":"019b7a10-4c00-79a4-8110-2c40117a0013","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100003","toolName":"run_tests","toolCallId":"019b7a10-4c00-7c20-8b01-000200000002","durationMs":261,"contentLength":537},"version":"1.0"}',
  },
  {
    atMs: 11200,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150028","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":29,"occurredAt":"2026-01-14T11:20:11.200Z","category":"tool_activity","type":"tool.result","actor":"019b7a10-4c00-79a4-8110-2c40117a0014","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100004","toolName":"search_repository","toolCallId":"019b7a10-4c00-7c20-8b01-000300000002","durationMs":264,"contentLength":548},"version":"1.0"}',
  },
  {
    atMs: 11600,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150029","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":30,"occurredAt":"2026-01-14T11:20:11.600Z","category":"assistant_output","type":"assistant.thinking_update","actor":"019b7a10-4c00-79a4-8110-2c40117a0011","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100001","contentType":"text/plain","contentLength":571},"version":"1.0"}',
  },
  {
    atMs: 12000,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150030","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":31,"occurredAt":"2026-01-14T11:20:12.000Z","category":"assistant_output","type":"assistant.thinking_update","actor":"019b7a10-4c00-79a4-8110-2c40117a0012","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100002","contentType":"text/plain","contentLength":580},"version":"1.0"}',
  },
  {
    atMs: 12400,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150031","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":32,"occurredAt":"2026-01-14T11:20:12.400Z","category":"assistant_output","type":"assistant.thinking_update","actor":"019b7a10-4c00-79a4-8110-2c40117a0013","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100003","contentType":"text/plain","contentLength":589},"version":"1.0"}',
  },
  {
    atMs: 12800,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150032","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":33,"occurredAt":"2026-01-14T11:20:12.800Z","category":"assistant_output","type":"assistant.thinking_update","actor":"019b7a10-4c00-79a4-8110-2c40117a0014","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100004","contentType":"text/plain","contentLength":598},"version":"1.0"}',
  },
  {
    atMs: 13200,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150033","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":34,"occurredAt":"2026-01-14T11:20:13.200Z","category":"assistant_output","type":"assistant.message","actor":"019b7a10-4c00-79a4-8110-2c40117a0011","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100001","contentType":"text/markdown","contentLength":1181},"version":"1.0"}',
  },
  {
    atMs: 13600,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150034","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":35,"occurredAt":"2026-01-14T11:20:13.600Z","category":"assistant_output","type":"assistant.message","actor":"019b7a10-4c00-79a4-8110-2c40117a0012","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100002","contentType":"text/markdown","contentLength":1198},"version":"1.0"}',
  },
  {
    atMs: 14000,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150035","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":36,"occurredAt":"2026-01-14T11:20:14.000Z","category":"assistant_output","type":"assistant.message","actor":"019b7a10-4c00-79a4-8110-2c40117a0013","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100003","contentType":"text/markdown","contentLength":1215},"version":"1.0"}',
  },
  {
    atMs: 14400,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150036","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":37,"occurredAt":"2026-01-14T11:20:14.400Z","category":"assistant_output","type":"assistant.message","actor":"019b7a10-4c00-79a4-8110-2c40117a0014","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100004","contentType":"text/markdown","contentLength":1232},"version":"1.0"}',
  },
  {
    atMs: 14800,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150037","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":38,"occurredAt":"2026-01-14T11:20:14.800Z","category":"tool_activity","type":"tool.invoked","actor":"019b7a10-4c00-79a4-8110-2c40117a0011","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100001","toolName":"read_file","toolCallId":"019b7a10-4c00-7c20-8b01-000000000001"},"version":"1.0"}',
  },
  {
    atMs: 15200,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150038","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":39,"occurredAt":"2026-01-14T11:20:15.200Z","category":"tool_activity","type":"tool.invoked","actor":"019b7a10-4c00-79a4-8110-2c40117a0012","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100002","toolName":"edit_file","toolCallId":"019b7a10-4c00-7c20-8b01-000100000001"},"version":"1.0"}',
  },
  {
    atMs: 15600,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150039","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":40,"occurredAt":"2026-01-14T11:20:15.600Z","category":"tool_activity","type":"tool.invoked","actor":"019b7a10-4c00-79a4-8110-2c40117a0013","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100003","toolName":"run_tests","toolCallId":"019b7a10-4c00-7c20-8b01-000200000001"},"version":"1.0"}',
  },
  {
    atMs: 16000,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150040","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":41,"occurredAt":"2026-01-14T11:20:16.000Z","category":"tool_activity","type":"tool.invoked","actor":"019b7a10-4c00-79a4-8110-2c40117a0014","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100004","toolName":"search_repository","toolCallId":"019b7a10-4c00-7c20-8b01-000300000001"},"version":"1.0"}',
  },
  {
    atMs: 16400,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150041","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":42,"occurredAt":"2026-01-14T11:20:16.400Z","category":"tool_activity","type":"tool.result","actor":"019b7a10-4c00-79a4-8110-2c40117a0011","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100001","toolName":"read_file","toolCallId":"019b7a10-4c00-7c20-8b01-000000000002","durationMs":303,"contentLength":691},"version":"1.0"}',
  },
  {
    atMs: 16800,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150042","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":43,"occurredAt":"2026-01-14T11:20:16.800Z","category":"tool_activity","type":"tool.result","actor":"019b7a10-4c00-79a4-8110-2c40117a0012","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100002","toolName":"edit_file","toolCallId":"019b7a10-4c00-7c20-8b01-000100000002","durationMs":306,"contentLength":702},"version":"1.0"}',
  },
  {
    atMs: 17200,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150043","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":44,"occurredAt":"2026-01-14T11:20:17.200Z","category":"tool_activity","type":"tool.result","actor":"019b7a10-4c00-79a4-8110-2c40117a0013","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100003","toolName":"run_tests","toolCallId":"019b7a10-4c00-7c20-8b01-000200000002","durationMs":309,"contentLength":713},"version":"1.0"}',
  },
  {
    atMs: 17600,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150044","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":45,"occurredAt":"2026-01-14T11:20:17.600Z","category":"tool_activity","type":"tool.result","actor":"019b7a10-4c00-79a4-8110-2c40117a0014","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100004","toolName":"search_repository","toolCallId":"019b7a10-4c00-7c20-8b01-000300000002","durationMs":312,"contentLength":724},"version":"1.0"}',
  },
  {
    atMs: 18000,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150045","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":46,"occurredAt":"2026-01-14T11:20:18.000Z","category":"assistant_output","type":"assistant.thinking_update","actor":"019b7a10-4c00-79a4-8110-2c40117a0011","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100001","contentType":"text/plain","contentLength":715},"version":"1.0"}',
  },
  {
    atMs: 18400,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150046","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":47,"occurredAt":"2026-01-14T11:20:18.400Z","category":"assistant_output","type":"assistant.thinking_update","actor":"019b7a10-4c00-79a4-8110-2c40117a0012","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100002","contentType":"text/plain","contentLength":724},"version":"1.0"}',
  },
  {
    atMs: 18800,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150047","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":48,"occurredAt":"2026-01-14T11:20:18.800Z","category":"assistant_output","type":"assistant.thinking_update","actor":"019b7a10-4c00-79a4-8110-2c40117a0013","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100003","contentType":"text/plain","contentLength":733},"version":"1.0"}',
  },
  {
    atMs: 19200,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150048","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":49,"occurredAt":"2026-01-14T11:20:19.200Z","category":"assistant_output","type":"assistant.thinking_update","actor":"019b7a10-4c00-79a4-8110-2c40117a0014","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100004","contentType":"text/plain","contentLength":742},"version":"1.0"}',
  },
  {
    atMs: 19600,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150049","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":50,"occurredAt":"2026-01-14T11:20:19.600Z","category":"assistant_output","type":"assistant.message","actor":"019b7a10-4c00-79a4-8110-2c40117a0011","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100001","contentType":"text/markdown","contentLength":1453},"version":"1.0"}',
  },
  {
    atMs: 20000,
    frameJson:
      '{"id":"019b7a10-4c00-7ea1-8110-e5e0d1150050","sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","sequence":51,"occurredAt":"2026-01-14T11:20:20.000Z","category":"assistant_output","type":"assistant.message","actor":"019b7a10-4c00-79a4-8110-2c40117a0012","payload":{"sessionId":"019b7a10-4c00-7d31-9f02-6b1a5e900001","runId":"019b7a10-4c00-7b10-8a01-9f0d5e100002","contentType":"text/markdown","contentLength":1470},"version":"1.0"}',
  },
];
