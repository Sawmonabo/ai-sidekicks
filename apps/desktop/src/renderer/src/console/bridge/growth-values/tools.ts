// The tool plane's values: one call a provider made, and one tool the daemon has
// exposed into a session.
//
// One of the domain modules behind `growth-values/index.ts`. The barrel states the
// rules every value here obeys — why a shape earns a name, what belongs in the
// signature table instead, and what belongs in a module of its own — and publishes
// the whole set. Import from the barrel; this file is the domain's own text.

export interface GrowthToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly argumentsJson: string;
  /**
   * The run that owns the page this call addresses, by the label a surface shows.
   *
   * Carried rather than looked up, because ownership is by RUN: a page belongs to the
   * run that opened it, and a lookup from another run answers not found rather than
   * forbidden. A relay frame that named no run would leave the surface rendering the
   * call unable to say whose work it is — and a console that guessed would attribute
   * one agent's browsing to another on any session with two attached.
   */
  readonly owningRunLabel: string;
}

/**
 * One tool the daemon has exposed into a session, as the registry read returns it.
 *
 * The registered shape is the function-form provider tool: a name, a description, and
 * a JSON Schema for the arguments. `inputSchema` stays an opaque record rather than a
 * parsed schema type because it IS a JSON Schema document and the console neither
 * validates against it nor compiles it — the approvals pane renders what a tool takes,
 * and a parsed type here would be a second schema vocabulary with one reader.
 *
 * A named value rather than an inline reply shape because the read answers with a
 * LIST of them: the element type is what a surface's props and its row component both
 * name, which is the second reader this module's header asks for.
 */
export interface GrowthCallbackTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}
