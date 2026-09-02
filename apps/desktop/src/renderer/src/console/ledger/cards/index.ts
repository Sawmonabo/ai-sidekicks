// The ledger's card door — the classifier, the two cards, the machine-authored body,
// the streaming-markdown pipeline, and the fixture shell that fills the row seat.
//
// WHY EVERY LINE IS A STAR RE-EXPORT, on `ledger/frame/index.ts`' terms: the dead-code
// gate reports an unused re-export at the SPECIFIER, so a named barrel written ahead of
// its consumers is a list of findings, and the one exemption for that — a `@consumedBy`
// tag — is for a symbol a DIFFERENT task will import. Every consumer of this door is a
// sibling piece of this same family, so a tag here would name the task that already owns
// the file.
//
// `markdown/index.js` is a sub-barrel rather than twelve lines here, because those
// modules are one job — a segmenter with no parse decides nothing and a mapper with no
// segmenter re-parses the world — and `apps/desktop/AGENTS.md` puts a job that outgrows
// one file in a module directory rather than a flat pile.
//
// The comment on each line is the table a named barrel would have been: what the module
// carries, in dependency order, low to high.

export * from "./card-bounds.js"; // the caps and thresholds every card here spends
export * from "./card-family.js"; // the one classifier: icon, label, layout, tool state
export * from "./markdown-rules.js"; // what renders, what defers, and what stays inert
export * from "./wire-payload.js"; // reading one member off an open projected payload
export * from "./ansi-spans.js"; // ANSI as spans, with no HTML string on the path
export * from "./markdown/index.js"; // the streaming-markdown pipeline
export * from "./card-props.js"; // what every card is handed
export * from "./AnsiOutput.js"; // command output
export * from "./StreamingMarkdown.js"; // the committed-and-volatile split, mounted
export * from "./MachineBody.js"; // truncated and unreadable bodies, named
export * from "./MessageCard.js"; // participant words, agent replies, agent reasoning
export * from "./ToolCard.js"; // one line until opened
export * from "./fixture-shell-projection.js"; // this window's event log, read as rows
export * from "./FixtureShellRows.js"; // the row seat's stand-in, and its death notice
