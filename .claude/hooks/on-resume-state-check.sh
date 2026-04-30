#!/usr/bin/env bash
# SessionStart hook — fires on source=compact|resume. Surfaces live git/gh
# state so the inherited (potentially-stale) summary isn't load-bearing without
# verification. Always exits 0 — must never block startup.

git rev-parse --abbrev-ref HEAD 2>/dev/null
git status -sb 2>/dev/null
git log -5 --oneline 2>/dev/null
command -v gh >/dev/null 2>&1 && \
  gh pr list --state open --json number,title,headRefName,mergeStateStatus 2>/dev/null

exit 0
