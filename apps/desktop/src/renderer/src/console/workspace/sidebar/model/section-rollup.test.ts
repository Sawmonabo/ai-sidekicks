// The rollup fold, held to the two claims the design track makes about it.

import {
  EMPTY_SECTION_ROLLUP,
  flattenSectionRollup,
  foldSectionRollup,
  strongerAttention,
} from "./section-rollup.js";
import { SIDEBAR_ROLLUP_GROUPS, type SidebarRollupNode } from "../../../seats/index.js";

/** A session › channel › run tree, with the failure buried two levels down. */
function sessionChannelRunTree(): readonly SidebarRollupNode[] {
  return [
    {
      nodeId: "channel-build",
      label: "build",
      group: "running",
      children: [
        { nodeId: "run-1", label: "run one", group: "running" },
        { nodeId: "run-2", label: "run two", group: "needs-attention", attention: "failure" },
      ],
    },
    { nodeId: "channel-review", label: "review", group: "pinned" },
  ];
}

describe("the section rollup fold", () => {
  it("carries a child's level up to the section", () => {
    // The whole of "child-to-parent": nothing at either top-level node reports
    // anything, and the section is calling because a grandchild is.
    expect(foldSectionRollup(sessionChannelRunTree()).attention).toBe("failure");
  });

  it("negative control: a tree where nothing is calling folds to nothing", () => {
    // Without this, a fold that answered `"failure"` for every tree would pass the
    // case above. The same tree with the one attention removed must answer nothing.
    const calm: readonly SidebarRollupNode[] = [
      {
        nodeId: "channel-build",
        label: "build",
        group: "running",
        children: [{ nodeId: "run-1", label: "run one", group: "running" }],
      },
    ];

    expect(foldSectionRollup(calm).attention).toBeUndefined();
  });

  it("counts every node at every depth, per group", () => {
    const rollup = foldSectionRollup(sessionChannelRunTree());

    expect(rollup.nodeCount).toBe(4);
    expect(rollup.countsByGroup).toStrictEqual({
      pinned: 1,
      "needs-attention": 1,
      running: 2,
      rest: 0,
    });
  });

  it("states zero for a group nothing is in, rather than omitting it", () => {
    // Total over the closed set: a header reading the counts asks every group, and a
    // missing key would render as `undefined` rather than as "none of these".
    const counts = foldSectionRollup([]).countsByGroup;

    expect(Object.keys(counts).toSorted()).toStrictEqual([...SIDEBAR_ROLLUP_GROUPS].toSorted());
  });

  it("folds no tree at all to the empty rollup", () => {
    expect(foldSectionRollup([])).toStrictEqual({
      attention: EMPTY_SECTION_ROLLUP.attention,
      countsByGroup: EMPTY_SECTION_ROLLUP.countsByGroup,
      nodeCount: EMPTY_SECTION_ROLLUP.nodeCount,
    });
  });

  it("ranks failure over attention over nothing", () => {
    expect(strongerAttention("attention", "failure")).toBe("failure");
    expect(strongerAttention("attention", undefined)).toBe("attention");
    expect(strongerAttention(undefined, undefined)).toBeUndefined();
  });

  it("does not overflow the stack on a tree deeper than the call stack", () => {
    // The fold is iterative BECAUSE the depth is the projection's rather than this
    // module's. A recursive walk fails this case, which is what makes the claim in
    // the module header checkable rather than a comment.
    let deepest: SidebarRollupNode = { nodeId: "leaf", label: "leaf", group: "rest" };
    for (let depth = 0; depth < 20_000; depth += 1) {
      deepest = {
        nodeId: `node-${String(depth)}`,
        label: "node",
        group: "rest",
        children: [deepest],
      };
    }

    expect(foldSectionRollup([deepest]).nodeCount).toBe(20_001);
  });
});

describe("flattening a rollup for the rows a person reads", () => {
  it("orders siblings by group and keeps each one's children under it", () => {
    // Pinned first, then needs-attention, then running, then the rest — and the
    // channel's own runs stay under the channel rather than being lifted out and
    // sorted beside another channel's.
    const rows = flattenSectionRollup(sessionChannelRunTree());

    expect(rows.map((row) => row.node.nodeId)).toStrictEqual([
      "channel-review",
      "channel-build",
      "run-2",
      "run-1",
    ]);
    expect(rows.map((row) => row.depth)).toStrictEqual([0, 0, 1, 1]);
  });

  it("gives a parent the strongest level at or under it", () => {
    const rows = flattenSectionRollup(sessionChannelRunTree());
    const channel = rows.find((row) => row.node.nodeId === "channel-build");

    // The channel reports nothing of its own; what it shows is its failing run's.
    expect(channel?.node.attention).toBeUndefined();
    expect(channel?.rolledUpAttention).toBe("failure");
  });

  it("negative control: a calm sibling stays calm", () => {
    // Without this, a carry that painted every row with the tree's strongest level
    // would pass the case above while making the whole column read as failing.
    const rows = flattenSectionRollup(sessionChannelRunTree());

    expect(
      rows.find((row) => row.node.nodeId === "channel-review")?.rolledUpAttention,
    ).toBeUndefined();
  });
});
