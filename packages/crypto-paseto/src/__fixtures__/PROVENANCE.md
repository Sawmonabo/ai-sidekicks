# `v4.json` — vendored upstream test vectors

**Source**: https://github.com/paseto-standard/test-vectors/blob/master/v4.json **Upstream commit SHA**: `32d7406591eb022f9eff88abb84106dd9d42c0f2` **SHA-256 of vendored file**: `0b72948b65d1f73f574c9ad2aa3481ec27bf8c632f5f6e1596cd41f5b9703387`

## Updating the vectors

When upstream publishes new vectors:

1. Download `v4.json` from the new upstream commit and record its `shasum -a 256`.
2. Update this file with the new commit SHA and sha256.
3. Run `pnpm --filter @ai-sidekicks/crypto-paseto test` to confirm the suite still passes.
