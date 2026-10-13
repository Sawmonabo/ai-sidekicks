// The feed's parses in turn: one whose slice throws on every read is reported once and leaves its
// turn, the parse behind it still finishes, in the same slice or the next, and no slice runs after.

import { describe, expect, it } from "vitest";

import { endEverySliceAtOnce, giveEverySliceTime } from "#test/helpers/slice-clock.js";
import { SteppedTasks } from "#test/helpers/stepped-tasks.js";
import { PreparedBodies, type RowParse } from "./prepared-bodies.js";

describe("the feed's parses in turn", () => {
  it.each([
    { clock: "every slice has time", setClock: giveEverySliceTime, sliceCount: 1 },
    { clock: "every slice ends after one read", setClock: endEverySliceAtOnce, sliceCount: 2 },
  ])(
    "take a parse whose read throws out of its turn, report it once, and read on, when $clock",
    async ({ setClock, sliceCount }) => {
      setClock();
      const tasks = new SteppedTasks();
      const reported: unknown[] = [];
      const view = {
        scheduler: tasks.window.scheduler,
        reportError: (failure: unknown) => {
          reported.push(failure);
        },
      } as unknown as Window;
      const bodies = new PreparedBodies();
      let finishingReadCount = 0;
      const finishing: RowParse = {
        readInTurn: () => {
          finishingReadCount += 1;
          bodies.leaveTurn(finishing);
          return true;
        },
      };
      let throwingReadCount = 0;
      const throwing: RowParse = {
        readInTurn: () => {
          throwingReadCount += 1;
          throw new Error("This parse throws on every read");
        },
      };
      // The last put in turn is read first, so the throwing parse stands ahead of the other.
      bodies.parseInTurn(finishing, view);
      bodies.parseInTurn(throwing, view);

      let taskCount = 0;
      while (taskCount < 10 && (await tasks.runNext())) {
        taskCount += 1;
      }

      expect(taskCount).toBe(sliceCount);
      expect(throwingReadCount).toBe(1);
      expect(reported).toHaveLength(1);
      expect(bodies.isInTurn(throwing)).toBe(false);
      expect(finishingReadCount).toBe(1);
    },
  );
});
