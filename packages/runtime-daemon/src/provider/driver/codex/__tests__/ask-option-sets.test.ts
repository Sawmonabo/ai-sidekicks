// The input-ask choice set: what `readCodexAskOptionSet` reads from each ask shape.

import { describe, expect, it } from "vitest";

import { readCodexAskOptionSet } from "../ask-option-sets.js";
import { THREAD_ID, TURN_ID } from "../__fixtures__/app-server-doubles.js";

describe("readCodexAskOptionSet (the input-ask choice set)", () => {
  it("reads `item/tool/requestUserInput` options with value === label", () => {
    // `ToolRequestUserInputOption` is `{ label, description }` in the pinned protocol with no value
    // member, so the label is the answer token the provider expects back; an index or hash would be
    // one it does not recognize.
    const reading = readCodexAskOptionSet("item/tool/requestUserInput", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: "item-1",
      isBlocking: true,
      questions: [
        {
          id: "q1",
          header: "Pick a branch",
          question: "Which branch?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "main", description: "the default branch" },
            { label: "develop", description: "the integration branch" },
          ],
        },
      ],
    });

    expect(reading).toStrictEqual({
      kind: "read",
      options: [
        { value: "main", label: "main" },
        { value: "develop", label: "develop" },
      ],
    });
  });

  it("reads all three MCP single-select enum arms", () => {
    const untitled = readCodexAskOptionSet("mcpServer/elicitation/request", {
      threadId: THREAD_ID,
      turnId: null,
      serverName: "files",
      mode: "form",
      message: "choose",
      requestedSchema: {
        type: "object",
        properties: { pick: { type: "string", enum: ["a", "b"] } },
      },
    });
    expect(untitled).toStrictEqual({
      kind: "read",
      options: [
        { value: "a", label: "a" },
        { value: "b", label: "b" },
      ],
    });

    // The one arm where value and label differ, which is why `ProviderAskOption` has both.
    const titled = readCodexAskOptionSet("mcpServer/elicitation/request", {
      threadId: THREAD_ID,
      turnId: null,
      serverName: "files",
      mode: "form",
      message: "choose",
      requestedSchema: {
        type: "object",
        properties: {
          pick: {
            type: "string",
            oneOf: [
              { const: "a", title: "Alpha" },
              { const: "b", title: "Beta" },
            ],
          },
        },
      },
    });
    expect(titled).toStrictEqual({
      kind: "read",
      options: [
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
      ],
    });

    // The legacy arm pairs positionally and its names array is optional and may be short: an entry
    // with no name falls back to its own value, since a missing caption is not a missing choice.
    const legacy = readCodexAskOptionSet("mcpServer/elicitation/request", {
      threadId: THREAD_ID,
      turnId: null,
      serverName: "files",
      mode: "form",
      message: "choose",
      requestedSchema: {
        type: "object",
        properties: {
          pick: { type: "string", enum: ["a", "b", "c"], enumNames: ["Alpha", "Beta"] },
        },
      },
    });
    expect(legacy).toStrictEqual({
      kind: "read",
      options: [
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
        { value: "c", label: "c" },
      ],
    });
  });

  it("drops a multi-question ask rather than merging two sets into one", () => {
    const reading = readCodexAskOptionSet("item/tool/requestUserInput", {
      questions: [
        { id: "q1", options: [{ label: "main", description: "" }] },
        { id: "q2", options: [{ label: "yes", description: "" }] },
      ],
    });

    // A flat list built from two questions answers neither.
    expect(reading).toMatchObject({ kind: "dropped", declaredCount: 2 });
  });

  it("drops a MIXED-QUESTION ask: one option-bearing question beside a free-text sibling", () => {
    // Eligibility is the total ask shape, not the option-bearing count. The answer covers every
    // declared question and `ProviderAskOption` carries no question identity, so a flat set can
    // stand in for it only where the ask declares exactly one question. Counting only
    // option-bearing questions would let every pick produce an answer missing a question the
    // provider still awaits.
    const freeTextSibling = readCodexAskOptionSet("item/tool/requestUserInput", {
      questions: [
        { id: "q1", question: "Which branch?", options: [{ label: "main", description: "" }] },
        { id: "q2", question: "Why?" },
      ],
    });
    // The ask's question count is what explains the drop.
    expect(freeTextSibling).toMatchObject({ kind: "dropped", declaredCount: 2 });

    // An empty option list on the sibling is the same shape: it publishes no choices, so the choice
    // set cannot carry that question either.
    const emptyOptionSibling = readCodexAskOptionSet("item/tool/requestUserInput", {
      questions: [
        { id: "q1", options: [{ label: "main", description: "" }] },
        { id: "q2", options: [] },
      ],
    });
    expect(emptyOptionSibling).toMatchObject({ kind: "dropped", declaredCount: 2 });
  });

  it(
    "drops a MIXED-FIELD form: one single-select " +
      "beside any sibling answers the form for neither",
    () => {
      // Eligibility is the total form shape, not the enum count. A form's answer is one object
      // keyed by property name and `ProviderAskOption` carries no property identity, so a flat set
      // can stand in for it only where the form has exactly one property. Counting only
      // enum-bearing properties would make the commonest real elicitation look answerable, and
      // every pick would omit a field the provider awaits.
      const requiredSibling = readCodexAskOptionSet("mcpServer/elicitation/request", {
        mode: "form",
        requestedSchema: {
          type: "object",
          required: ["pick", "reason"],
          properties: {
            pick: { type: "string", enum: ["a", "b"] },
            reason: { type: "string" },
          },
        },
      });
      // The form's property count is what explains the drop.
      expect(requiredSibling).toMatchObject({ kind: "dropped", declaredCount: 2 });

      // Requiredness is deliberately not consulted: an optional sibling is equally unanswerable by
      // a value with no field name, so refining on `required` would reopen the defect.
      const optionalSibling = readCodexAskOptionSet("mcpServer/elicitation/request", {
        mode: "form",
        requestedSchema: {
          type: "object",
          required: ["pick"],
          properties: {
            pick: { type: "string", enum: ["a", "b"] },
            note: { type: "string" },
          },
        },
      });
      expect(optionalSibling).toMatchObject({ kind: "dropped", declaredCount: 2 });
    },
  );

  it("drops the WHOLE set when one option is unreadable, never a partial one", () => {
    const reading = readCodexAskOptionSet("mcpServer/elicitation/request", {
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: { pick: { type: "string", enum: ["fine", "   "] } },
      },
    });

    // A partial set silently removes a choice the provider offered, so the card would look complete
    // yet could not express the answer the provider awaits.
    expect(reading).toMatchObject({ kind: "dropped", declaredCount: 2 });
  });
});
