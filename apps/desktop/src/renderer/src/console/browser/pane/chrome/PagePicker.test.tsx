// The page picker: the whole list, including the pages the pane is not showing.
//
// 12.2's picker exists because the strip draws what the pane shows and a session owns
// more than that. So the cases below pin the two things a picker that merely repeated
// the strip would get wrong — a background page is listed and marked, and its Show
// control is the one that is enabled — and the two controls that are ABSENT rather
// than disabled when the console cannot justify offering them.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../../../core/index.js";
import { recordingChromeActs, type RecordedChromeAct } from "./chrome-acts.test-support.js";
import type { BrowserPage, PageListReading } from "../page-state.js";
import { PagePicker } from "./PagePicker.js";

function page(overrides: Partial<BrowserPage> & { readonly pageId: string }): BrowserPage {
  return {
    label: null,
    title: `Title ${overrides.pageId}`,
    url: `https://example.test/${overrides.pageId}`,
    host: "example.test",
    isLoading: false,
    isSelected: false,
    isShown: false,
    ...overrides,
  };
}

function servedPages(pages: readonly BrowserPage[]): PageListReading {
  return { kind: "served", frame: { contextName: null, pages } };
}

function renderPicker(
  reading: PageListReading,
  canOpenDevtools = true,
): readonly RecordedChromeAct[] {
  const { acts, recorded } = recordingChromeActs();
  render(<PagePicker reading={reading} acts={acts} canOpenDevtools={canOpenDevtools} />);
  return recorded;
}

describe("the page picker's readings", () => {
  it("distinguishes an unread list from a session that owns no pages", () => {
    renderPicker({ kind: "reading" });
    expect(screen.getByText("Pages not read")).toBeTruthy();
    expect(screen.queryByText("No pages open")).toBeNull();
  });

  it("says the producer finished rather than that the pages closed", () => {
    renderPicker({ kind: "ended" });
    expect(screen.getByText("Pages no longer reported")).toBeTruthy();
  });

  it("renders a refused list as a refusal", () => {
    renderPicker({
      kind: "refused",
      scope: "whole-answer",
      refusal: refuse("browser-pages", "page-subscription-failed", "The subscription broke."),
    });
    expect(screen.getByText(/The subscription broke\./)).toBeTruthy();
  });

  it("says the session owns none only where it owns none", () => {
    renderPicker(servedPages([]));
    expect(screen.getByText("No pages open")).toBeTruthy();
  });
});

describe("the page picker's rows", () => {
  it("lists a background page, marks it, and offers Show for it", () => {
    const recorded = renderPicker(
      servedPages([page({ pageId: "page-a", isShown: false, label: "Docs" })]),
    );
    expect(screen.getByText("Docs")).toBeTruthy();
    expect(screen.getByText("background")).toBeTruthy();
    const show = screen.getByRole("button", { name: "Show" });
    expect((show as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(show);
    expect(recorded).toEqual([{ member: "showPage", argument: "page-a" }]);
  });

  it("says a page is unlabelled rather than inventing a label", () => {
    renderPicker(servedPages([page({ pageId: "page-a" })]));
    expect(screen.getByText("Unlabelled")).toBeTruthy();
  });

  it("disables the controls whose act would be a no-op", () => {
    renderPicker(servedPages([page({ pageId: "page-a", isShown: true, isSelected: true })]));
    expect((screen.getByRole("button", { name: "Show" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Select" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("omits developer tools where no host could be created", () => {
    renderPicker(servedPages([page({ pageId: "page-a" })]), false);
    expect(screen.queryByRole("button", { name: "Developer tools" })).toBeNull();
  });

  it("offers reveal only for a page that is a local file", () => {
    renderPicker(
      servedPages([
        page({ pageId: "page-a", url: "file:///Users/someone/work/repo/index.html" }),
        page({ pageId: "page-b", url: "https://example.test/remote" }),
      ]),
    );
    expect(screen.getAllByRole("button", { name: "Reveal file" })).toHaveLength(1);
  });

  it("dispatches select and developer tools against the row's own page", () => {
    const recorded = renderPicker(
      servedPages([page({ pageId: "page-a" }), page({ pageId: "page-b" })]),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Select" })[1] as HTMLElement);
    fireEvent.click(screen.getAllByRole("button", { name: "Developer tools" })[0] as HTMLElement);
    expect(recorded).toEqual([
      { member: "selectPage", argument: "page-b" },
      { member: "openDevtools", argument: "page-a" },
    ]);
  });
});
