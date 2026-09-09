// The window between a form opening and the thing that checks it arriving.
//
// The schema compiler is behind a loader — the bridge door is on the initial import graph
// and the schema library is not something every launch may be charged for — so a form is on
// screen before anything can judge what is typed into it. That window is a state, and this
// file is what says what is true inside it: no verdict of any kind, no claim that the
// schema could not be compiled, and no act. It is the one suite in this directory that
// reads a form before it has finished opening; every other one mounts through the settled
// helper, which is why they can go on asserting about reports.
//
// THE LOADER IS SUBSTITUTED RATHER THAN RACED. Every claim here is about ORDERING — what
// is true before an answer, a schema that moves while a compile is outstanding, a mount
// that ends before one lands, a compile that must happen once and not per keystroke — and
// none of them can be stated against a promise that resolves whenever the module map feels
// like it. So the door is spied and its loader answers a promise the case settles, which
// is the same substitution `PhaseGraph.chunk-refusal.test.tsx` makes at this console's
// other loader. The spy keeps every other door export real, so the form under test is the
// real form, and what the substitution replaces is WHEN a verdict arrives and never what a
// verdict means — the reader's own refusals are pinned beside the reader
// (`bridge/wire-shapes/json-schema-check.test.ts`) and are not restated here.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadSchemaValidatorCompiler, type SchemaValidator } from "../../../bridge/index.js";
import { mountFormUnsettled } from "./use-schema-form.test-support.js";
import { settle } from "../../../core/settle.test-support.js";
import { SchemaFormAnswer } from "./SchemaFormAnswer.js";

vi.mock(import("../../../bridge/index.js"), { spy: true });

afterEach(cleanup);
// The door is left as this file found it. Every case installs its own substitution through
// `holdCompilerLoads`, so nothing here depends on the restore — it is what keeps the spy
// from outliving the file.
afterEach(() => {
  vi.restoreAllMocks();
});

/** A schema the mapper draws one control for and the reader compiles without complaint. */
const ONE_MEMBER_SCHEMA = {
  type: "object",
  properties: { title: { type: "string", title: "Title" } },
  required: ["title"],
} as const;

/** A second schema, distinct by identity, so a case can move a form from one to the other. */
const OTHER_MEMBER_SCHEMA = {
  type: "object",
  properties: { note: { type: "string", title: "Note" } },
  required: ["note"],
} as const;

/**
 * What a compiler that refused answers with.
 *
 * THAT IT REFUSES AT ALL IS THE READER'S BUSINESS AND IS PINNED THERE
 * (`bridge/wire-shapes/json-schema-check.test.ts`, over a `$ref` the library does not
 * implement). What is under test here is the form's handling of that verdict once it
 * arrives, which is a claim about this hook and is stated over the verdict rather than
 * over a schema chosen to provoke one.
 */
const REFUSED_COMPILE: SchemaValidator = {
  status: "uncompilable",
  detail: "This phase's schema could not be checked here, so only the JSON itself is checked.",
};

/**
 * The loader, held open until a case lets it answer.
 *
 * One compiler function shared by every load, so a case counting compiles is counting the
 * hook's calls rather than the substitution's.
 */
interface HeldCompilerLoads {
  /** What every held load resolves to, recording the schemas it was asked about. */
  readonly compiledSchemas: unknown[];
  /** Let every load put so far answer. */
  readonly deliver: () => Promise<void>;
}

function holdCompilerLoads(answer?: SchemaValidator): HeldCompilerLoads {
  const compiledSchemas: unknown[] = [];
  const waiting: (() => void)[] = [];
  const compile = (inputSchema: unknown): SchemaValidator => {
    compiledSchemas.push(inputSchema);
    return answer ?? { status: "compiled", check: () => ({ status: "invalid", issues: [] }) };
  };
  vi.mocked(loadSchemaValidatorCompiler).mockImplementation(
    () =>
      new Promise<(inputSchema: unknown) => SchemaValidator>((resolve) => {
        waiting.push(() => {
          resolve(compile);
        });
      }),
  );
  return {
    compiledSchemas,
    deliver: async () => {
      for (const answer of waiting.splice(0)) {
        answer();
      }
      // The hook settles from a promise callback of its own, so the turn that callback
      // runs on has to be let go of inside React's scope before a case reads the form
      // back — which is exactly what the shared settle is.
      await settle();
    },
  };
}

describe("a form whose compiler has not arrived", () => {
  it("has no verdict at all, rather than a clean one", async () => {
    const held = holdCompilerLoads();
    const mounted = mountFormUnsettled(ONE_MEMBER_SCHEMA);

    // The schema requires a member nothing has answered, so a compiled form reports an
    // issue here — which is what makes the absence below the window and not the answer.
    expect(mounted.form().validator.status).toBe("compiling");
    expect(mounted.form().report).toBeUndefined();

    await held.deliver();

    expect(mounted.form().validator.status).toBe("compiled");
    expect(mounted.form().report?.status).toBe("invalid");
  });

  it("does not say the schema could not be compiled, because nobody has tried yet", async () => {
    const held = holdCompilerLoads();
    // The mapper cannot draw this member, so this form opens on the raw editor — the one
    // surface that renders a sentence about an uncompilable schema.
    const { container } = render(
      <SchemaFormAnswer
        prompt="Anything?"
        inputSchema={{ type: "object", properties: { when: { type: ["string", "null"] } } }}
        onSubmit={() => undefined}
      />,
    );

    expect(container.querySelector(".meridian-schema-raw__editor")).not.toBeNull();
    expect(container.querySelector(".meridian-schema-raw__uncheckable")).toBeNull();

    await held.deliver();

    expect(container.querySelector(".meridian-schema-raw__uncheckable")).toBeNull();
  });

  it("offers no act, and says so where a reader who is not on the button can meet it", async () => {
    const held = holdCompilerLoads();
    const { container } = render(
      <SchemaFormAnswer
        prompt="Does this look right?"
        inputSchema={ONE_MEMBER_SCHEMA}
        onSubmit={() => undefined}
      />,
    );

    const submit = screen.getByRole("button", { name: "Submit answer" });
    expect(submit).toHaveProperty("disabled", true);
    expect(container.querySelector("form")?.getAttribute("aria-busy")).toBe("true");

    await held.deliver();

    expect(submit).toHaveProperty("disabled", false);
    expect(container.querySelector("form")?.getAttribute("aria-busy")).toBeNull();
  });

  it("sends nothing while the act is closed, which is the claim the attribute stands for", async () => {
    const held = holdCompilerLoads();
    const sent: unknown[] = [];
    render(
      <SchemaFormAnswer
        prompt="Does this look right?"
        inputSchema={ONE_MEMBER_SCHEMA}
        onSubmit={(answer) => sent.push(answer)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    expect(sent).toHaveLength(0);

    await held.deliver();
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));

    // Negative control on the case above: the control really does send once it is armed,
    // so the empty list before the delivery is the closure and not a broken form.
    expect(sent).toHaveLength(1);
  });
});

describe("a compile that loses its subject", () => {
  it("does not apply a late compile to the schema that replaced it", async () => {
    const held = holdCompilerLoads();
    const mounted = mountFormUnsettled(ONE_MEMBER_SCHEMA);
    mounted.showSchema(OTHER_MEMBER_SCHEMA);

    // Both loads are outstanding and both answer here. The abandoned one is not merely
    // ignored on arrival — the compile itself never runs, because the round that would
    // have admitted it was released the moment the schema moved.
    await held.deliver();

    expect(held.compiledSchemas).toEqual([OTHER_MEMBER_SCHEMA]);
    expect(mounted.form().plan.shape).toBe("fields");
    expect(screen.queryByLabelText("Title")).toBeNull();
  });

  it("shows no verdict from the schema it has left, from the render the schema moves in", async () => {
    const held = holdCompilerLoads();
    const mounted = mountFormUnsettled(ONE_MEMBER_SCHEMA);
    await held.deliver();
    expect(mounted.form().report?.status).toBe("invalid");

    mounted.showSchema(OTHER_MEMBER_SCHEMA);

    // Not one render of the previous schema's verdict over the new schema's controls: the
    // validator is keyed on the schema, so the arm moves in the same render the schema
    // does rather than in an effect one commit later.
    expect(mounted.form().validator.status).toBe("compiling");
    expect(mounted.form().report).toBeUndefined();
  });

  it("never compiles for a mount that has ended", async () => {
    const held = holdCompilerLoads();
    const mounted = mountFormUnsettled(ONE_MEMBER_SCHEMA);

    mounted.unmount();
    await held.deliver();

    expect(held.compiledSchemas).toEqual([]);
  });
});

describe("how often one schema is compiled", () => {
  it("compiles once per schema per mount, however many renders the form takes", async () => {
    const held = holdCompilerLoads();
    const mounted = mountFormUnsettled(ONE_MEMBER_SCHEMA);
    await held.deliver();

    for (const typed of ["S", "Sh", "Shi", "Ship"]) {
      act(() => {
        mounted.form().setRawText(typed);
      });
    }
    await held.deliver();

    expect(held.compiledSchemas).toEqual([ONE_MEMBER_SCHEMA]);
  });

  it("compiles again for a schema it has not seen, which is what makes the count a rule", async () => {
    const held = holdCompilerLoads();
    const mounted = mountFormUnsettled(ONE_MEMBER_SCHEMA);
    await held.deliver();

    mounted.showSchema(OTHER_MEMBER_SCHEMA);
    await held.deliver();

    expect(held.compiledSchemas).toEqual([ONE_MEMBER_SCHEMA, OTHER_MEMBER_SCHEMA]);
  });
});

describe("a schema that could not be compiled, once the compiler is here", () => {
  it("falls back to the raw editor, says why, and offers the act again", async () => {
    const held = holdCompilerLoads(REFUSED_COMPILE);
    const { container } = render(
      <SchemaFormAnswer
        prompt="Anything?"
        inputSchema={ONE_MEMBER_SCHEMA}
        onSubmit={() => undefined}
      />,
    );

    // The mapper drew a control for this schema, so the arm below is the VALIDATOR's
    // doing: a form that promised to check a member it cannot check would be worse than
    // one that says so and takes the answer as JSON.
    expect(container.querySelector(".meridian-schema-raw__editor")).toBeNull();

    await held.deliver();

    expect(container.querySelector(".meridian-schema-raw__editor")).not.toBeNull();
    expect(container.querySelector(".meridian-schema-raw__uncheckable")?.textContent).toBe(
      REFUSED_COMPILE.status === "uncompilable" ? REFUSED_COMPILE.detail : "",
    );
    // And the act is open again: the form has a verdict about this schema — that it has
    // none — which is a different fact from not having asked yet.
    expect(screen.getByRole("button", { name: "Submit answer" })).toHaveProperty("disabled", false);
  });
});
