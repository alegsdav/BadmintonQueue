// Dev-only stand-in for the Supabase client: open http://localhost:5173/?mock to try the board
// against the real schema running in your browser (PGlite). You are "You", an admin. Nothing touches the live project.
import { PGlite } from '@electric-sql/pglite';
import schema from '../../supabase/schema.sql?raw';
import { addPlayers, createDb, rpc, signInAs } from './db.js';

const migrations = Object.entries(import.meta.glob('../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true }))
  .sort(([a], [b]) => a.localeCompare(b)).map(([, sql]) => sql);

const NAMES = ['You', 'Maya', 'Jon', 'Priya', 'Sam', 'Ava', 'Leo', 'Noor', 'Kai', 'Rin', 'Theo', 'Isla', 'Marisol Featherstone-Okonkwo'];
const id = i => `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`;

export async function createMockClient() {
  const db = await createDb(PGlite, [schema, ...migrations]);
  await addPlayers(db, NAMES.map((name, i) => ({ id: id(i), name, email: i === 0 ? 'you@example.com' : `player${i}@example.com` })));
  const as = async (i, fn, args) => { await signInAs(db, id(i)); return rpc(db, fn, args); };
  // Court 1: team Maya & Jon vs team Priya & Sam. Court 2: Kai vs Rin. Waiting: Ava & Leo (a team), Noor, Isla for Court 1; Theo, Marisol for Court 2.
  for (const [i, c, s] of [[1, 0, 'a'], [2, 0, 'a'], [3, 0, 'b'], [4, 0, 'b'], [8, 1, 'a'], [9, 1, 'b']]) await as(i, 'join_court', { p_court: c, p_side: s });
  for (const [i, c] of [[5, 0], [7, 0], [11, 0], [10, 1], [12, 1]]) await as(i, 'join_queue', { p_court: c });
  const ava = (await as(0, 'get_state')).queue.find(e => e.members.includes(id(5)));
  await as(6, 'join_team', { p_entry: ava.id });
  await as(0, 'admin_pair', { p_user: id(2), p_target: id(1) });  // Maya & Jon, Priya & Sam play as teams
  await as(0, 'admin_pair', { p_user: id(4), p_target: id(3) });
  await signInAs(db, id(0));

  let signedIn = true;
  let chain = Promise.resolve();  // one PGlite connection: run calls one at a time
  const serial = fn => (chain = chain.then(fn, fn));
  return {
    rpc: (fn, args) => serial(async () => {
      try { return { data: await rpc(db, fn, args), error: null }; } catch (e) { return { data: null, error: { message: e.message } }; }
    }),
    auth: {
      getSession: async () => ({ data: { session: signedIn ? { user: { id: id(0) } } : null } }),
      signOut: async () => { signedIn = false; },
      signInWithPassword: async () => { signedIn = true; return { error: null }; },
      signUp: async () => ({ data: {}, error: { message: 'Sign-up is off in mock mode. Sign in with any details.' } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    channel: () => { const ch = { on: () => ch, subscribe: () => ch }; return ch; },
  };
}
