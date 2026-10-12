import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";
import { expect, it } from "vitest";

import { generalRow } from "../event-rows.test-support.js";
import { hasSameMembers } from "./row-retention.js";

it("tells a row apart from one that lost, gained or swapped a member, and keeps an equal one", () => {
  const payload = { text: "hello" };
  const rowOf = (members: { readonly payload: Readonly<Record<string, unknown>> }) =>
    generalRow({ id: "event-1", sequence: 1, type: "note", actor: "person-1", ...members });
  const row = rowOf({ payload });
  const { actor: _actor, ...withoutActor } = row;
  expect(hasSameMembers(row, { ...row })).toBe(true);
  expect(hasSameMembers(row, withoutActor)).toBe(false);
  expect(hasSameMembers(withoutActor, row)).toBe(false);
  expect(hasSameMembers(row, rowOf({ payload: { ...payload } }))).toBe(false);
  // As many members, one of them set to `undefined` where the other row has a different one.
  const withUndefinedContent = { ...withoutActor, content: undefined };
  expect(hasSameMembers(row, withUndefinedContent as unknown as TranscriptEventRow)).toBe(false);
});
