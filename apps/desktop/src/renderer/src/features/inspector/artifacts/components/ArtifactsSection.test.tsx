// What the artifacts panel renders on each of its arms, and what it offers.

import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { formatByteQuantity, formatCount } from "@renderer/lib/wire-figures.js";
import { ARTIFACT_PRODUCER_ID, artifactRow } from "@test/helpers/artifact-summaries.js";
import { ArtifactsSection } from "./ArtifactsSection.js";

// Built rather than parsed: a fixture instant is this suite's own decision, and the
// console's one reader of a wire stamp is `parseInstant`, not this line.
const NOW_MILLISECONDS = Date.UTC(2026, 0, 1, 9, 30, 0);

describe("ArtifactsSection — the arms are different absences", () => {
  it("says the read found none, when it did", () => {
    const { container } = render(
      <ArtifactsSection state={{ kind: "listed", rows: [] }} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    expect(container.textContent).toContain("Nothing made here yet.");
  });

  it("shows a read in flight without asserting a result", () => {
    const { container } = render(
      <ArtifactsSection state={{ kind: "loading" }} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Nothing made here yet.");
  });
});

describe("ArtifactsSection — a count is a reading, and only a list produces one", () => {
  it("states no session total and offers no type filter while a read is in flight", () => {
    // A head that reports a total over rows nobody read contradicts the body beneath it,
    // and seven buttons all reading zero promise that pressing one narrows a list this
    // panel does not have.
    const { container, queryByRole } = render(
      <ArtifactsSection state={{ kind: "loading" }} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    expect(container.textContent).not.toContain("in this session");
    expect(queryByRole("group", { name: "Filter by artifact type" })).toBeNull();
  });

  it("reports the total and every type's count once a list has answered", () => {
    const { container, getByRole } = render(
      <ArtifactsSection
        state={{ kind: "listed", rows: [artifactRow(), artifactRow({ id: "artifact-02" })] }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    expect(container.textContent).toContain(`${formatCount(2)} in this session`);
    expect(getByRole("group", { name: "Filter by artifact type" })).toBeDefined();
  });

  it("negative control: a served EMPTY list is a reading, so it keeps both", () => {
    // The arm that earns a zero. `listed` with no rows is a read that found none, which is
    // a different claim from `loading` and renders its own total.
    const { container, getByRole } = render(
      <ArtifactsSection state={{ kind: "listed", rows: [] }} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    expect(container.textContent).toContain(`${formatCount(0)} in this session`);
    expect(getByRole("group", { name: "Filter by artifact type" })).toBeDefined();
  });
});

describe("ArtifactsSection — the row's face", () => {
  it("carries type, state, size, and producer", () => {
    const row = artifactRow();
    const { container } = render(
      <ArtifactsSection
        state={{ kind: "listed", rows: [row] }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    expect(container.textContent).toContain("file");
    expect(container.textContent).toContain("published");
    expect(container.textContent).toContain(formatByteQuantity(row.size).text);
    expect(container.textContent).toContain(ARTIFACT_PRODUCER_ID);
  });

  it("keeps the exact byte count beside the scaled reading of it", () => {
    const { container } = render(
      <ArtifactsSection
        state={{ kind: "listed", rows: [artifactRow({ size: 4096 })] }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    expect(container.querySelector('[title="4096"]')).not.toBeNull();
  });

  it("keeps a superseded row visible as history", () => {
    const { container } = render(
      <ArtifactsSection
        state={{ kind: "listed", rows: [artifactRow({ state: "superseded" })] }}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    expect(container.querySelectorAll(".meridian-artifact-row")).toHaveLength(1);
    expect(container.textContent).toContain("superseded");
  });
});

describe("ArtifactsSection — the type filter is one filter over one list", () => {
  const rows = [
    artifactRow({ id: "a", artifactType: "file" }),
    artifactRow({ id: "b", artifactType: "diff" }),
  ];

  it("offers every type, including the ones at zero", () => {
    const { container } = render(
      <ArtifactsSection state={{ kind: "listed", rows }} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    const filter = within(container).getByRole("group", { name: "Filter by artifact type" });
    // Seven: the six types plus the member that selects them all.
    expect(within(filter).getAllByRole("button")).toHaveLength(7);
    expect(filter.textContent).toContain("workflow_output");
  });

  it("narrows the list when a type is pressed", () => {
    const { container } = render(
      <ArtifactsSection state={{ kind: "listed", rows }} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    expect(container.querySelectorAll(".meridian-artifact-row")).toHaveLength(2);
    const filter = within(container).getByRole("group", { name: "Filter by artifact type" });
    fireEvent.click(within(filter).getByText("diff"));
    expect(container.querySelectorAll(".meridian-artifact-row")).toHaveLength(1);
  });

  it("says the FILTER matched nothing, not that the session has nothing", () => {
    // The read served two artifacts. A panel that branched on the rows the filter kept
    // would report the session as empty here, hiding that the filter is what has no matches.
    const { container } = render(
      <ArtifactsSection state={{ kind: "listed", rows }} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    const filter = within(container).getByRole("group", { name: "Filter by artifact type" });
    fireEvent.click(within(filter).getByText("summary"));
    expect(container.querySelectorAll(".meridian-artifact-row")).toHaveLength(0);

    const body = container.querySelector(".meridian-artifacts__body");
    expect(body?.textContent).toContain("No artifacts of the type this filter is set to");
    // The type it is set to, and how many rows of other types it is hiding.
    expect(body?.textContent).toContain("summary");
    expect(body?.textContent).toContain(formatCount(rows.length));
    expect(body?.textContent).not.toContain("Nothing made here yet.");
  });

  it("negative control: the session-empty copy survives, on the arm that earns it", () => {
    // The other side of the same branch. A fix that routed every empty body through
    // the filter-scoped sentence would leave a read that genuinely found none with
    // no way to say so, and would name a filter the user never touched.
    const { container } = render(
      <ArtifactsSection state={{ kind: "listed", rows: [] }} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    const body = container.querySelector(".meridian-artifacts__body");
    expect(body?.textContent).toContain("Nothing made here yet.");
    expect(body?.textContent).not.toContain("this filter is set to");
  });

  it("negative control: a filter that matches keeps rendering the list", () => {
    const { container } = render(
      <ArtifactsSection state={{ kind: "listed", rows }} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    const filter = within(container).getByRole("group", { name: "Filter by artifact type" });
    fireEvent.click(within(filter).getByText("file"));
    expect(container.querySelectorAll(".meridian-artifact-row")).toHaveLength(1);
    const body = container.querySelector(".meridian-artifacts__body");
    expect(body?.textContent).not.toContain("this filter is set to");
  });
});
