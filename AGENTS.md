# AGENTS.md

Instructions for AI tools working in this repo (Codex, Cursor, Aider). Read [`CLAUDE.md`](CLAUDE.md) first: it is the project file for every tool and holds the commands, the rules, and where the docs live. This file adds only what is not there.

## Precedence

A user instruction outranks this file; this file outranks any skill or plugin text. When two instructions conflict, take the reversible reading and say so.

## Working style

- Do the task that was asked; report anything else you found as a follow-up with a reason, not as extra changes.
- Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; if something is not yet verified, say so.
- Ask before a hard-to-reverse action (force-push, deleting a branch someone else may hold, a settings change on GitHub). Do not ask before reversible work.
- Run the package's tests for what you changed; run `pnpm typecheck && pnpm lint` before opening a PR. Rerun a test only when a new failure justifies it.

## Subagents

A brief names the goal, the files and symbols that already exist, what not to touch, and what done looks like, and ends with the evidence sentence above. Split parallel work by non-overlapping file sets; parallel reading is safe, parallel writing conflicts. Effort is chosen per brief: `high` by default, `max` only for concurrency, authorization, or cryptography diffs.

## Research

Scratch notes go under `.agents/tmp/<topic>/` (gitignored). A committed document never links there; if a finding matters, write it into the document that needs it, with its source.

## Reviewing

Report every finding with a severity; do not pre-filter. The Codex review on a PR is advice on `develop` and a gate on `main`.
