// What the artifacts panel renders on each of its arms, and what it offers.

import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { formatByteQuantity, formatCount } from "@renderer/lib/wire-figures.js";
import { ARTIFACT_PRODUCER_ID, artifactRow } from "@test/helpers/artifact-summaries.js";
import { ArtifactsSection } from "./ArtifactsSection.js";

// Built rather than parsed, so the suite does not depend on `parseInstant`.
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
    // A total over unread rows would contradict the body, and filter buttons all reading zero
    // promise a narrowing this panel cannot do.
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
    // `listed` with no rows is a read that found none, not `loading`, so it renders its total.
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
    // The read served two artifacts; branching on the filtered rows would report the session
    // as empty.
    const { container } = render(
      <ArtifactsSection state={{ kind: "listed", rows }} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    const filter = within(container).getByRole("group", { name: "Filter by artifact type" });
    fireEvent.click(within(filter).getByText("summary"));
    expect(container.querySelectorAll(".meridian-artifact-row")).toHaveLength(0);

    const body = container.querySelector(".meridian-artifacts__body");
    expect(body?.textContent).toContain("No artifacts of the type this filter is set to");
    expect(body?.textContent).toContain("summary");
    expect(body?.textContent).toContain(formatCount(rows.length));
    expect(body?.textContent).not.toContain("Nothing made here yet.");
  });

  it("negative control: the session-empty copy survives, on the arm that earns it", () => {
    // Routing every empty body through the filter sentence would name a filter the user never
    // touched.
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
