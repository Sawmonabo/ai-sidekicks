// What a channel-scoped pane is a log of.
//
// Its own file beside `filters.test.ts` because the subject is not a narrowing. A
// facet is something a reader applies to a window and takes back off; a channel scope
// is the window's own subject, decided by the pane rather than by the reader, and the
// two are answered by different functions over the same rows.
//
// The claim that fails silently is the one about a row the scope cannot place: a row
// carrying no channel is not evidence that it belongs to this one, so a scope that
// admitted it would render another channel's work as this channel's.

import type { TimelineRow } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { channelIdOfRow, scopeLedgerRowsToChannel } from "./filters.js";
import { generalRow, rollbackBoundaryRow, runRow } from "../timeline-rows.test-support.js";

describe("filters — a channel-scoped pane is a log of that channel", () => {
  const CHANNEL_ONE = "019b793b-7b60-7c11-8110-c4a11e10001a";
  const CHANNEL_TWO = "019b793b-7b60-7c11-8120-c4a11e10002b";
  /** A channel no ROW names — only a boundary's own typed payload does. */
  const CHANNEL_THREE = "019b793b-7b60-7c11-8130-c4a11e10003c";

  /**
   * One run that spoke in both channels, one that spoke only in the second, a
   * session row, and a boundary.
   *
   * Shaped so every clause of the scope is exercised by one window: only the two
   * message rows carry a channel, so the run rows and the boundary can be admitted
   * only through the claim, and run-a's second message is the row that proves a run
   * claimed by one channel does not drag its other channel's prose along.
   */
  function twoChannelWindow(): readonly TimelineRow[] {
    return [
      runRow({ id: "a-start", sequence: 1, type: "run.running", runId: "run-a", position: 0 }),
      runRow({
        id: "a-said-one",
        sequence: 2,
        type: "assistant.message",
        category: "assistant_output",
        runId: "run-a",
        position: 1,
        payload: { channelId: CHANNEL_ONE },
      }),
      runRow({
        id: "a-said-two",
        sequence: 3,
        type: "assistant.message",
        category: "assistant_output",
        runId: "run-a",
        position: 2,
        payload: { channelId: CHANNEL_TWO },
      }),
      rollbackBoundaryRow({ id: "a-boundary", sequence: 4, runId: "run-a", position: 1 }),
      runRow({
        id: "b-said",
        sequence: 5,
        type: "assistant.message",
        category: "assistant_output",
        runId: "run-b",
        position: 0,
        payload: { channelId: CHANNEL_TWO },
      }),
      generalRow({
        id: "session-renamed",
        sequence: 6,
        type: "session.renamed",
        category: "session_lifecycle",
      }),
    ];
  }

  it("keeps the channel's own rows and the runs that produced them", () => {
    // The run row and the boundary name no channel — no run-lifecycle payload does
    // — so without the claim a channel pane would show prose with no chapter to
    // fold it into, no receipt, and no boundary marking a rewind.
    const scoped = scopeLedgerRowsToChannel(twoChannelWindow(), CHANNEL_ONE);

    expect(scoped.map((row) => row.id)).toStrictEqual(["a-start", "a-said-one", "a-boundary"]);
  });

  it("never carries one channel's prose into another's pane", () => {
    // `run-a` spoke in both, and the claim admits its channel-less rows only.
    const scoped = scopeLedgerRowsToChannel(twoChannelWindow(), CHANNEL_TWO);

    expect(scoped.map((row) => row.id)).toStrictEqual([
      "a-start",
      "a-said-two",
      "a-boundary",
      "b-said",
    ]);
  });

  it("leaves a session row to the session", () => {
    // An absent channel member says the producer named no channel, not that it
    // named this one — so a scope that admitted it would put every session-level
    // row on every channel pane.
    for (const channelId of [CHANNEL_ONE, CHANNEL_TWO]) {
      expect(scopeLedgerRowsToChannel(twoChannelWindow(), channelId)).not.toContainEqual(
        expect.objectContaining({ id: "session-renamed" }),
      );
    }
  });

  it("negative control: a channel nothing named admits nothing at all", () => {
    // Without this the scope could be admitting on the claim alone, which would
    // show every run's rows under a channel that never held one.
    expect(
      scopeLedgerRowsToChannel(twoChannelWindow(), "019b793b-7b60-7c11-8130-000000000000"),
    ).toStrictEqual([]);
  });

  it("never lets a rollback boundary's own channel claim its run", () => {
    // THE DEFECT: the row reader cast every payload to a bag, and the boundary arm
    // carries the TYPED `run.rolled_back` event — which has a `channelId?` of its
    // own. A boundary of a run that spoke in channel one, carrying channel two,
    // therefore claimed the whole run into channel two: its chapter, its receipt
    // and its boundary rendered there with none of its prose.
    const rows = [
      ...twoChannelWindow().filter((row) => row.id !== "a-boundary"),
      rollbackBoundaryRow({
        id: "a-boundary",
        sequence: 4,
        runId: "run-a",
        position: 1,
        channelId: CHANNEL_THREE,
      }),
    ];

    expect(scopeLedgerRowsToChannel(rows, CHANNEL_THREE)).toStrictEqual([]);
  });

  it("still carries a boundary in with the run its rows claimed", () => {
    // The other half, and the reason the boundary is not simply dropped: the second
    // pass admits it for the run, so the rewind is still marked in the pane where
    // the run's prose is.
    const rows = [
      ...twoChannelWindow().filter((row) => row.id !== "a-boundary"),
      rollbackBoundaryRow({
        id: "a-boundary",
        sequence: 4,
        runId: "run-a",
        position: 1,
        channelId: CHANNEL_THREE,
      }),
    ];

    expect(scopeLedgerRowsToChannel(rows, CHANNEL_ONE).map((row) => row.id)).toStrictEqual([
      "a-start",
      "a-said-one",
      "a-boundary",
    ]);
  });

  it("negative control: the three open payload shapes still attribute", () => {
    // Without this the fix could have been "read no channel at all", which would
    // empty every channel pane — the reader has to keep seeing the shapes it is
    // supposed to see and stop seeing the one it is not.
    for (const row of twoChannelWindow()) {
      if (row.id === "a-said-one") {
        expect(channelIdOfRow(row)).toBe(CHANNEL_ONE);
      }
      if (row.id === "a-boundary") {
        expect(channelIdOfRow(row)).toBeUndefined();
      }
    }
    expect(
      channelIdOfRow(
        runRow({
          id: "a-tool",
          sequence: 7,
          type: "tool.invoked",
          category: "tool_activity",
          runId: "run-a",
          position: 3,
          payload: { toolName: "read_file", channelId: CHANNEL_TWO },
        }),
      ),
    ).toBe(CHANNEL_TWO);
    expect(
      channelIdOfRow(
        generalRow({
          id: "channel-made",
          sequence: 8,
          type: "channel.created",
          category: "session_lifecycle",
          payload: { channelId: CHANNEL_TWO },
        }),
      ),
    ).toBe(CHANNEL_TWO);
  });
});
