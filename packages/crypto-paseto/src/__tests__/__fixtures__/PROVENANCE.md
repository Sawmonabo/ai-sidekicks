# `v4.json` — vendored upstream test vectors

**Source**: https://github.com/paseto-standard/test-vectors/blob/master/v4.json **Upstream commit SHA**: `32d7406591eb022f9eff88abb84106dd9d42c0f2` **Retrieval date**: 2026-05-20 **SHA-256 of vendored file**: `0b72948b65d1f73f574c9ad2aa3481ec27bf8c632f5f6e1596cd41f5b9703387`

## Update protocol

When upstream publishes new vectors:

1. Re-run the download + `shasum -a 256` from `Task 8 Step 1` of the implementation plan.
2. Update this file with the new commit SHA + sha256.
3. Run `pnpm --filter @ai-sidekicks/crypto-paseto test` to confirm the suite still passes.
4. Commit as a single follow-up PR: `chore(crypto-paseto): bump RFC v4 vector fixture`.

## Audit log

| Date | Commit SHA | sha256 | Reason |
| --- | --- | --- | --- |
| 2026-05-20 | `32d7406591eb022f9eff88abb84106dd9d42c0f2` | `0b72948b65d1f73f574c9ad2aa3481ec27bf8c632f5f6e1596cd41f5b9703387` | Initial vendor for Plan-025 Tier 1 Partial |
