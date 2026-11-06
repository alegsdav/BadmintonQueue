// In-memory Postgres (PGlite) loaded with the real schema and migrations.
// Used by the SQL tests and by the dev-only ?mock board; never shipped in the production build.

// The few Supabase pieces the schema expects: auth.users, auth.uid(), the API roles and the realtime publication.
const BOOTSTRAP = `
create schema auth;
create table auth.users (id uuid primary key, email text not null, email_confirmed_at timestamptz, raw_user_meta_data jsonb);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
create role anon; create role authenticated;
create publication supabase_realtime;
`;

/** @param {any} PGlite the PGlite class @param {string[]} sqls schema.sql, then each migration in order */
export async function createDb(PGlite, sqls) {
  const db = new PGlite();
  await db.exec(BOOTSTRAP);
  for (const sql of sqls) await db.exec(sql);
  return db;
}

/** Act as this user (null = signed out) for the following calls. */
export const signInAs = (db, uid) => db.query(`select set_config('app.uid', $1, false)`, [uid ?? '']);

/** Call a database function by name with named arguments, like supabase.rpc(). */
export async function rpc(db, fn, args = {}) {
  const keys = Object.keys(args);
  if (![fn, ...keys].every(k => /^[a-z_]+$/.test(k))) throw new Error(`Bad rpc name: ${fn}`);
  const params = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
  const { rows } = await db.query(`select ${fn}(${params}) as r`, keys.map(k => args[k]));
  return rows[0]?.r ?? null;
}

/** Create confirmed accounts (profiles come from the signup trigger). @param {{id: string, name: string, email?: string}[]} people */
export async function addPlayers(db, people) {
  for (const p of people) {
    await db.query(`insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, $2, now(), $3)`,
      [p.id, p.email ?? `${p.name.toLowerCase()}@example.com`, { name: p.name }]);
  }
}
