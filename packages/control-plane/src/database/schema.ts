// The control plane's Postgres schema, applied whole on a database that has none.
//
// SQL lives in a TypeScript string because `tsc -b` copies no `.sql` file into
// `dist/`, and the package publishes only `dist/`.

/** The whole control-plane schema. `applyMigrations` executes it once, under an advisory lock. */
export const CONTROL_PLANE_SCHEMA_SQL: string = `
-- The identity anchor other tables key on.
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
