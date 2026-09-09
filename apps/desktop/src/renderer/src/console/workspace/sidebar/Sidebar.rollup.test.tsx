// The column reading a section's own rollup: the counts on the header, and the rule
// the fold decides.

import { SIDEBAR_SECTION_IDS, SidebarSectionRegistry } from "../../seats/index.js";
import { SECTION_OWNER, disclosures, renderSidebar } from "./Sidebar.test-support.js";

/** A section whose tree buries its failure two levels down. */
function registryWithRollup(): SidebarSectionRegistry {
  const registry = new SidebarSectionRegistry();
  registry.register({
    id: "runs",
    owner: SECTION_OWNER,
    render: () => <p>runs</p>,
    rollup: () => [
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
    ],
  });
  return registry;
}

function headerFor(sidebar: HTMLElement, sectionId: string): HTMLButtonElement {
  const position = SIDEBAR_SECTION_IDS.indexOf(sectionId as (typeof SIDEBAR_SECTION_IDS)[number]);
  const header = disclosures(sidebar)[position];
  if (header === undefined) {
    throw new Error(`no header rendered for ${sectionId}`);
  }
  return header;
}

describe("a section that supplies a rollup", () => {
  it("shows its grouped counts, in the group order, and only where there is one", () => {
    const { sidebar } = renderSidebar(registryWithRollup());

    const counts = [
      ...headerFor(sidebar, "runs").querySelectorAll(".meridian-sidebar__rollup > *"),
    ].map((element) => element.textContent);

    // Pinned, needs-attention, running — and no "0 other", because a row of zeroes is
    // four numbers a person reads to learn nothing.
    expect(counts).toStrictEqual(["1 pinned", "1 needs attention", "2 running"]);
  });

  it("is open, because a child of a child of it is failing", () => {
    // The child-to-parent carry reaching the rule stated over the whole set: nothing
    // at the section's own level reports anything.
    const { sidebar } = renderSidebar(registryWithRollup());

    expect(headerFor(sidebar, "runs").getAttribute("aria-expanded")).toBe("true");
    expect(headerFor(sidebar, "runs").getAttribute("data-attention")).toBe("failure");
  });

  it("negative control: a section whose tree is calm carries no mark", () => {
    // Without this, a fold that marked every section supplying a tree would pass the
    // case above and open all eight.
    const registry = new SidebarSectionRegistry();
    registry.register({
      id: "runs",
      owner: SECTION_OWNER,
      render: () => <p>runs</p>,
      rollup: () => [{ nodeId: "run-1", label: "run one", group: "running" }],
    });
    const { sidebar } = renderSidebar(registry);

    expect(headerFor(sidebar, "runs").getAttribute("data-attention")).toBeNull();
    expect(
      headerFor(sidebar, "runs").querySelectorAll(".meridian-sidebar__rollup > *"),
    ).toHaveLength(1);
  });

  it("takes the section's own claim over the fold where it makes one", () => {
    // A section answering both is answering one question twice; the explicit claim is
    // the section's own and the fold stands in where there is none.
    const registry = new SidebarSectionRegistry();
    registry.register({
      id: "runs",
      owner: SECTION_OWNER,
      render: () => <p>runs</p>,
      attention: () => "attention",
      rollup: () => [{ nodeId: "run-1", label: "run one", group: "running", attention: "failure" }],
    });
    const { sidebar } = renderSidebar(registry);

    expect(headerFor(sidebar, "runs").getAttribute("data-attention")).toBe("attention");
  });

  it("shows no counts for a section that supplied no tree", () => {
    // The difference between "unavailable" and zero: a section whose read has not
    // answered supplies nothing, and nothing renders no numbers.
    const registry = new SidebarSectionRegistry();
    registry.register({ id: "runs", owner: SECTION_OWNER, render: () => <p>runs</p> });
    const { sidebar } = renderSidebar(registry);

    expect(headerFor(sidebar, "runs").querySelector(".meridian-sidebar__rollup")).toBeNull();
  });
});
