// A path field is answered only through the platform's folder chooser: once a folder is picked
// its name stands beside `Browse…`, and a chooser that cannot open says so beside the button. A
// repeating collection of them adds and removes its entries in its own words.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import type { WorkflowParamSpec } from "@ai-sidekicks/contracts/workflow/kind";

import type { FilePathRef, PickedFolder } from "#shared/preload-api.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { liveRegionText } from "#test/helpers/live-region.js";
import { seedParamAnswers, type ParamAnswers } from "./answers.js";
import { ParamForm } from "./ParamForm.js";

const FIELDS: readonly WorkflowParamSpec[] = [
  { id: "folder", label: "Folder", type: "path", required: true },
];

function FolderForm(props: { readonly pickFolder: () => Promise<PickedFolder | null> }) {
  const [answers, setAnswers] = useState<ParamAnswers>(() => seedParamAnswers(FIELDS));
  return (
    <ParamForm
      fields={FIELDS}
      answers={answers}
      onAnswersChange={setAnswers}
      issues={{}}
      idPrefix="test-form"
      pickFolder={props.pickFolder}
    />
  );
}

async function pressBrowse(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Folder Browse…" }));
    await Promise.resolve();
  });
}

describe("a path field", () => {
  it("draws the picked folder's name as a wire figure beside Browse…", async () => {
    const { container } = render(
      <FolderForm
        pickFolder={() =>
          Promise.resolve({ ref: "file-path-ref-1" as FilePathRef, name: "ai-sidekicks" })
        }
      />,
    );
    expect(container.querySelector(".meridian-figure--wire")).toBeNull();

    await pressBrowse();

    const name = screen.getByText("ai-sidekicks");
    expect(name.classList.contains("meridian-figure--wire")).toBe(true);
    expect(screen.getByRole("button", { name: "Folder Browse…" }).textContent).toBe("Browse…");
  });

  it("says the chooser could not open when main names no reason", async () => {
    const { container } = render(
      <FolderForm pickFolder={() => Promise.reject(new Error("dialog failed"))} />,
      { wrapper: LiveAnnouncerProvider },
    );

    await pressBrowse();

    expect(container.querySelector(".meridian-refusal")?.textContent).toBe(
      "Could not open the folder chooser.",
    );
    expect(liveRegionText(container, "assertive")).toBe("Could not open the folder chooser.");
  });
});

describe("a repeating collection", () => {
  it("adds an entry as Add <label> and removes it as Remove, named Remove <label> <n>", () => {
    const fields: readonly WorkflowParamSpec[] = [
      { id: "target", label: "Target", type: "collection", multiple: true, fields: [...FIELDS] },
    ];
    function TargetForm(): React.JSX.Element {
      const [answers, setAnswers] = useState<ParamAnswers>(() => seedParamAnswers(fields));
      return (
        <ParamForm
          fields={fields}
          answers={answers}
          onAnswersChange={setAnswers}
          issues={{}}
          idPrefix="test-form"
          pickFolder={() => Promise.resolve(null)}
        />
      );
    }
    render(<TargetForm />);

    fireEvent.click(screen.getByRole("button", { name: "Add Target" }));

    expect(screen.getByRole("button", { name: "Add Target" }).textContent).toBe("Add Target");
    const remove = screen.getByRole("button", { name: "Remove Target 1" });
    expect(remove.textContent).toBe("Remove");
    fireEvent.click(remove);
    expect(screen.queryByRole("button", { name: "Remove Target 1" })).toBeNull();
  });
});
