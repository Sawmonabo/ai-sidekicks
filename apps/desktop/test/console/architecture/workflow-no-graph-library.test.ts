// The workflows family imports no node-graph and no form library, and that absence
// is the deliverable rather than an omission.
//
// `Spec-023 §Console Libraries` ADOPTs a graph-rendering library for the workflow
// builder's canvas under named constraints — controlled mode, a connection-validity
// predicate evaluated during the drag, a stylesheet whose every token is driven from
// Meridian's — and every one of those constraints is a property of the BODY that
// draws nodes. Plan-017 authors that body; this console frames it, and the console's
// own task line makes a body authored here a review rejection.
//
// The consequence is checkable and this file checks it. A dependency pulled in
// before its consumer exists costs the bundle budget for a canvas nothing renders,
// and — worse — is the first move of drawing one here. The dead-code gate would
// catch a dependency nothing imports; it would say nothing at all about a family
// that imports one and renders a node with it.
//
// FORMS ARE ON THE SAME LIST FOR THE SAME REASON. The `human` phase's form is a
// schema walk Plan-017 owns, mounted through this family's draft slot, so a schema-
// form or form-state library appearing under these three directories means the form
// was authored here.
//
// SPECIFIERS, NOT TEXT. The check reads the module specifier of each import,
// export-from, dynamic import and require — deliberately not the file's raw text,
// because the slot headers NAME the library the owning task adopts, and a text scan
// would flag the very comments that record whose job it is. That distinction is
// asserted below rather than assumed.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { CONSOLE_SOURCE_DIRECTORY } from "../paths.js";

/**
 * The three directories that are one family under one task.
 *
 * Written as paths rather than inferred from a name, so a fourth directory joining
 * the family is an edit a reviewer sees rather than a silent widening — and so the
 * scan cannot quietly cover the whole console and pass because nothing anywhere
 * imports these libraries yet.
 */
const WORKFLOWS_FAMILY_DIRECTORIES: readonly string[] = [
  "workflows",
  join("panes", "workflow-builder"),
  join("panes", "workflow-run"),
];

/**
 * The packages this family may not import, by name.
 *
 * Two classes, one rule. The graph entries cover the adopted library and its
 * runtime sibling plus the layout and diagramming packages a canvas reaches for
 * next; the form entries cover schema-form renderers and form-state managers. A
 * subpath of any entry counts, so a deep import is not a way around the list.
 */
const FORBIDDEN_PACKAGES: readonly string[] = [
  "@xyflow/react",
  "@xyflow/system",
  "reactflow",
  "react-flow-renderer",
  "rete",
  "cytoscape",
  "jointjs",
  "@joint/core",
  "litegraph.js",
  "elkjs",
  "dagre",
  "@dagrejs/dagre",
  "d3-hierarchy",
  "@rjsf/core",
  "@rjsf/utils",
  "@rjsf/validator-ajv8",
  "@jsonforms/core",
  "@jsonforms/react",
  "react-hook-form",
  "formik",
  "uniforms",
  "ajv",
];

/**
 * Every module specifier `source` imports, in any of the four forms TypeScript
 * gives one.
 *
 * A pure function over text rather than a loop inside a test, so the controls below
 * can drive it with strings whose verdict is known and the checker is proved to
 * bite without perturbing a real module.
 */
function importedSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = [];
  const patterns: readonly RegExp[] = [
    /(?:^|\n)\s*(?:import|export)[^;\n]*?from\s*["']([^"']+)["']/gu,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

/** Which forbidden packages `source` imports, by name, or `[]`. */
function forbiddenImports(source: string): readonly string[] {
  return FORBIDDEN_PACKAGES.filter((packageName) =>
    importedSpecifiers(source).some(
      (specifier) => specifier === packageName || specifier.startsWith(`${packageName}/`),
    ),
  );
}

/** Every source module under the family, as paths relative to the console root. */
function workflowsFamilyModules(): readonly string[] {
  return WORKFLOWS_FAMILY_DIRECTORIES.flatMap((directory) =>
    readdirSync(join(CONSOLE_SOURCE_DIRECTORY, directory), {
      recursive: true,
      encoding: "utf8",
    })
      .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))
      .map((entry) => join(directory, entry)),
  ).sort();
}

function readFamilyModule(module: string): string {
  return readFileSync(join(CONSOLE_SOURCE_DIRECTORY, module), "utf8");
}

describe("the workflows family imports no graph or form library", () => {
  const modules = workflowsFamilyModules();

  it("finds a family to scan at all", () => {
    // Without this, a wrong directory list would scan nothing and every assertion
    // below would pass over the empty set.
    expect(modules.length).toBeGreaterThan(10);
    expect(modules).toContain(join("panes", "workflow-builder", "WorkflowBuilderPane.tsx"));
    expect(modules).toContain(join("panes", "workflow-builder", "slots", "NodeGraphSlot.tsx"));
  });

  it("no module under the family imports one", () => {
    const offenders = modules
      .map((module) => ({ module, packages: forbiddenImports(readFamilyModule(module)) }))
      .filter((entry) => entry.packages.length > 0)
      .map((entry) => `${relative(".", entry.module)}: ${entry.packages.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the checker bites on a planted import of each class", () => {
    // The clean result above is worth nothing unless the predicate fails on a
    // known-bad input, so both classes are planted and both are caught.
    expect(forbiddenImports('import { ReactFlow } from "@xyflow/react";')).toStrictEqual([
      "@xyflow/react",
    ]);
    expect(forbiddenImports('import Form from "@rjsf/core";')).toStrictEqual(["@rjsf/core"]);
    expect(forbiddenImports('const { useForm } = require("react-hook-form");')).toStrictEqual([
      "react-hook-form",
    ]);
    expect(forbiddenImports('await import("@xyflow/system");')).toStrictEqual(["@xyflow/system"]);
    expect(forbiddenImports('export { Background } from "reactflow";')).toStrictEqual([
      "reactflow",
    ]);
    expect(forbiddenImports('import layout from "@dagrejs/dagre/lib/layout.js";')).toStrictEqual([
      "@dagrejs/dagre",
    ]);
  });

  it("negative control: naming a library in prose is not importing it", () => {
    // The slot headers record which task adopts the canvas library, by name. A text
    // scan would flag exactly the comments that make the ownership legible, so the
    // distinction is asserted rather than trusted.
    expect(
      forbiddenImports("// The canvas library is @xyflow/react, and Plan-017 adopts it.\n"),
    ).toStrictEqual([]);
    expect(forbiddenImports('import { Nothing } from "../../primitives/index.js";')).toStrictEqual(
      [],
    );
  });

  it("negative control: the family really does import things, so the extractor runs", () => {
    // A specifier extractor that matched nothing at all would make the clean result
    // above vacuous over real files rather than over the empty set.
    const specifiers = importedSpecifiers(
      readFamilyModule(join("panes", "workflow-builder", "WorkflowBuilderPane.tsx")),
    );
    expect(specifiers).toContain("../../primitives/index.js");
  });
});
