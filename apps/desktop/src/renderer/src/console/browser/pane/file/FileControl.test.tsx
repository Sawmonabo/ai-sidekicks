// The file control, and the two things it is forbidden to do.
//
// It must not predict the boundary — every case below submits a path the daemon has
// not been asked about and asserts the act was dispatched anyway — and it must not
// echo one back on a refusal. The four roots arms are asserted separately because
// three of them are absences that mean different things, and a control that folded
// "not read" into "no roots" would tell a person local files are impossible here.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../../../core/index.js";
import { recordingChromeActs } from "../chrome/chrome-acts.test-support.js";
import { OUTSIDE_TRUST_ENVELOPE_CODE, type AdmittedRootsReading } from "./file-boundary.js";
import { FileControl } from "./FileControl.js";

const SERVED_ROOTS: AdmittedRootsReading = {
  kind: "served",
  roots: ["/Users/someone/work/repo"],
  unreportedWorkspaceCount: 0,
};

function renderControl(
  roots: AdmittedRootsReading,
  refusal = undefined as Parameters<typeof FileControl>[0]["refusal"],
): readonly { readonly member: string; readonly argument: string | number | undefined }[] {
  const { acts, recorded } = recordingChromeActs();
  render(<FileControl acts={acts} roots={roots} refusal={refusal} />);
  return recorded;
}

describe("the pane's local-file control", () => {
  it("dispatches the path it was given without checking it first", () => {
    const recorded = renderControl(SERVED_ROOTS);
    fireEvent.change(screen.getByLabelText("Local file"), {
      // Deliberately outside the one admitted root: the renderer predicts nothing.
      target: { value: "/etc/hosts" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    expect(recorded).toEqual([{ member: "openLocalFile", argument: "/etc/hosts" }]);
  });

  it("dispatches nothing for an empty draft", () => {
    const recorded = renderControl(SERVED_ROOTS);
    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    expect(recorded).toEqual([]);
  });

  it("names the rule on a boundary refusal, and keeps the path in the field", () => {
    const { acts, recorded } = recordingChromeActs();
    const { rerender } = render(
      <FileControl acts={acts} roots={SERVED_ROOTS} refusal={undefined} />,
    );
    const field = screen.getByLabelText("Local file");
    fireEvent.change(field, { target: { value: "/outside/root/page.html" } });
    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    rerender(
      <FileControl
        acts={acts}
        roots={SERVED_ROOTS}
        refusal={refuse(
          "browser-pane",
          OUTSIDE_TRUST_ENVELOPE_CODE,
          "That path is outside the trust envelope.",
        )}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("trust envelope");
    // The sentence names the rule; it does not repeat what the person typed.
    expect(screen.getByRole("status").textContent).not.toContain("/outside/root/page.html");
    expect((field as HTMLInputElement).value).toBe("/outside/root/page.html");
    expect(recorded).toHaveLength(1);
  });

  it("says nothing about the boundary for an unrelated refusal", () => {
    renderControl(
      SERVED_ROOTS,
      refuse("browser-pane", "page-open-failed", "The page could not be opened."),
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("discloses the admitted roots without claiming the check runs here", () => {
    renderControl(SERVED_ROOTS);
    expect(screen.getByText("/Users/someone/work/repo")).toBeTruthy();
    expect(screen.getByText(/can still be refused/)).toBeTruthy();
  });

  it("says the list is incomplete where a workspace reported no root", () => {
    renderControl({ kind: "served", roots: ["/one/root"], unreportedWorkspaceCount: 2 });
    expect(screen.getByText(/2 more workspaces are attached/)).toBeTruthy();
  });

  it("distinguishes an unread envelope from an empty one", () => {
    renderControl({ kind: "reading" });
    expect(screen.getByText("Admitted roots not read")).toBeTruthy();
    expect(screen.queryByText("No admitted roots")).toBeNull();
  });

  it("says the envelope is empty only where the daemon reported none", () => {
    renderControl({ kind: "served", roots: [], unreportedWorkspaceCount: 0 });
    expect(screen.getByText("No admitted roots")).toBeTruthy();
  });

  it("renders a refused roots read as a refusal, never as an empty envelope", () => {
    renderControl({
      kind: "refused",
      refusal: refuse("browser-file-boundary", "workspace-read-failed", "The read failed."),
    });
    expect(screen.getByText(/The read failed\./)).toBeTruthy();
    expect(screen.queryByText("No admitted roots")).toBeNull();
  });
});
