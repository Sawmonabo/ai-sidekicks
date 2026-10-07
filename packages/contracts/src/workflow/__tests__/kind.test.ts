// The canvas draws a kind's handles and a stored edge is checked against them by id alone, so a
// handle whose id says another side or type than it declares would put an edge on the wrong port.
import { describe, expect, it } from "vitest";

import { WorkflowKindListResponseSchema } from "../kind.js";

function catalogWith(inputs: unknown[], outputs: unknown[]) {
  return {
    kinds: [
      {
        kind: "agent.run",
        version: 1,
        category: "agent",
        displayName: "Run an agent",
        description: "Runs one agent turn.",
        icon: "bot",
        inputs,
        outputs,
        outputsDeriveFromParams: false,
        params: [],
      },
    ],
  };
}

describe("a kind's handle specs", () => {
  it("accept ids that say their own side and type", () => {
    const parsed = WorkflowKindListResponseSchema.safeParse(
      catalogWith(
        [
          { id: "inputs/main/0", label: "Input", type: "main" },
          { id: "inputs/tool/0", label: "Tools", type: "tool" },
        ],
        [{ id: "outputs/main/10", label: "Output", type: "main" }],
      ),
    );
    expect(parsed.success).toBe(true);
  });

  it("refuse an id that says another type, another side or an unreadable index, or repeats", () => {
    const main = (id: string) => ({ id, label: "Handle", type: "main" });
    for (const { inputs, outputs } of [
      { inputs: [{ id: "inputs/tool/0", label: "Input", type: "main" }], outputs: [] },
      { inputs: [main("outputs/main/0")], outputs: [] },
      { inputs: [], outputs: [main("inputs/main/0")] },
      { inputs: [main("inputs/main/01")], outputs: [] },
      { inputs: [main("inputs/main/-1")], outputs: [] },
      { inputs: [main("inputs/main/0"), main("inputs/main/0")], outputs: [] },
      { inputs: [], outputs: [main("outputs/main/1"), main("outputs/main/1")] },
    ]) {
      const parsed = WorkflowKindListResponseSchema.safeParse(catalogWith(inputs, outputs));
      expect(parsed.success, JSON.stringify({ inputs, outputs })).toBe(false);
    }
  });
});
