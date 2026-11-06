// Runs the real schema + migrations in an in-memory Postgres (PGlite). Nothing here touches the live project.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, describe, expect, test } from 'vitest';
import { addPlayers, createDb, rpc, signInAs } from '../src/dev/db.js';

const dir = new URL('.', import.meta.url);
const read = f => readFileSync(new URL(f, dir), 'utf8');
const SQL = [read('schema.sql'), ...readdirSync(new URL('migrations/', dir)).sort().map(f => read(`migrations/${f}`))];

const NAMES = ['Admin', 'Maya', 'Jon', 'Priya', 'Sam', 'Ava', 'Leo', 'Noor', 'Kai'];
const P = Object.fromEntries(NAMES.map((n, i) => [n, `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`]));
const NAME = Object.fromEntries(Object.entries(P).map(([n, id]) => [id, n]));

let db;
const as = async (who, fn, args) => { await signInAs(db, P[who]); return rpc(db, fn, args); };
const admin = (fn, args) => as('Admin', fn, args);
const state = () => as('Admin', 'get_state');
const teams = list => list.map(e => e.members.map(id => NAME[id]).sort().join('+'));  // teammates sorted: join order can tie
/** Court c as "a: Jon+Maya | b: Priya" and queue c as ['Ava', 'Leo+Noor'] */
const board = async () => {
  const S = await state();
  return {
    courts: S.courts.map(ct => `a: ${teams(ct.a).join(', ')} | b: ${teams(ct.b).join(', ')}`),
    queues: S.courts.map((_, c) => teams(S.queue.filter(e => e.queueCourt === c))),
    S,
  };
};
const entryOf = async who => (await state()).queue.concat(...(await state()).courts.flatMap(c => [c.a, c.b])).find(e => e.members.includes(P[who]));

beforeEach(async () => {
  db = await createDb(PGlite, SQL);
  await addPlayers(db, NAMES.map(name => ({ id: P[name], name, email: name === 'Admin' ? 'you@example.com' : undefined })));
  // Court 1 full: team Jon+Maya (a) vs team Priya+Sam (b). Court 1 queue: Ava, Leo, Noor. Court 2: Kai alone on a.
  await put(['Maya', 'Jon'], 0, 'a'); await put(['Priya', 'Sam'], 0, 'b');
  for (const who of ['Ava', 'Leo', 'Noor']) await put([who], null, null, 0);
  await put(['Kai'], 1, 'a');
});
/** Seed one entry (a single or a team) straight into the tables. */
async function put(members, court, side, queueCourt = court) {
  const { rows: [{ id }] } = await db.query('insert into entries (court, side, queue_court) values ($1, $2, $3) returning id', [court, side, queueCourt]);
  for (const m of members) await db.query('insert into entry_members (user_id, entry_id) values ($1, $2)', [P[m], id]);
}

describe('admin-only', () => {
  test('players cannot call the new admin functions', async () => {
    await expect(as('Maya', 'admin_place', { p_court: 1, p_side: 'b', p_user: P.Maya })).rejects.toThrow('Admins only.');
    await expect(as('Maya', 'admin_queue', { p_queue_court: 0, p_user: P.Ava })).rejects.toThrow('Admins only.');
    await expect(as('Maya', 'admin_swap', { p_a: P.Maya, p_b: P.Ava })).rejects.toThrow('Admins only.');
  });

  test('signed-in clients may call the three entry points but not the helpers', async () => {
    const { rows } = await db.query(`select p.proname, has_function_privilege('authenticated', p.oid, 'execute') as ok
      from pg_proc p where p.proname like 'admin\\_%' and p.proname in ('admin_place','admin_queue','admin_swap','admin_detach','admin_target') order by 1`);
    expect(Object.fromEntries(rows.map(r => [r.proname, r.ok]))).toEqual({
      admin_detach: false, admin_place: true, admin_queue: true, admin_swap: true, admin_target: false });
  });
});

describe('admin_place', () => {
  test('puts a waiting player on a chosen open side', async () => {
    await admin('admin_place', { p_court: 1, p_side: 'b', p_user: P.Noor });
    const b = await board();
    expect(b.courts[1]).toBe('a: Kai | b: Noor');
    expect(b.queues[0]).toEqual(['Ava', 'Leo']);
  });

  test('moving one player of a pair leaves the partner where they were, and the queue fills the gap', async () => {
    await as('Leo', 'join_team', { p_entry: (await entryOf('Ava')).id });  // Ava + Leo team up in Court 1's queue
    await admin('admin_place', { p_court: 1, p_side: 'a', p_user: P.Jon });  // Jon leaves his pair for Kai's side
    const b = await board();
    expect(b.courts[1]).toBe('a: Jon, Kai | b: ');
    // Maya keeps her spot; Jon's open spot goes to the first single in line who fits (Noor, since Ava+Leo is a pair)
    expect(b.courts[0]).toBe('a: Maya, Noor | b: Priya+Sam');
    expect(b.queues[0]).toEqual(['Ava+Leo']);
  });

  test('a whole team moves together', async () => {
    await admin('admin_place', { p_court: 1, p_side: 'b', p_entry: (await entryOf('Priya')).id });
    const b = await board();
    expect(b.courts[1]).toBe('a: Kai | b: Priya+Sam');
  });

  test('a full side is refused and nothing changes', async () => {
    const before = await board();
    await expect(admin('admin_place', { p_court: 0, p_side: 'b', p_user: P.Ava })).rejects.toThrow('That side is full');
    expect((await board()).courts).toEqual(before.courts);
  });

  test('switching sides on the same court keeps the win streak; another court resets it', async () => {
    await as('Maya', 'report_win', { p_court: 0, p_side: 'a' });  // Jon+Maya win once; Ava and Leo come on to side b
    await admin('admin_kick', { p_user: P.Ava });                // side b now Leo + Noor
    await admin('admin_kick', { p_user: P.Leo });
    const team = (await entryOf('Maya')).id;
    expect((await entryOf('Maya')).streak).toBe(1);
    await admin('admin_kick', { p_user: P.Noor });                // side b empty
    await admin('admin_place', { p_court: 0, p_side: 'b', p_entry: team });
    expect((await board()).courts[0]).toBe('a:  | b: Jon+Maya');
    expect((await entryOf('Maya')).streak).toBe(1);
    await admin('admin_place', { p_court: 1, p_side: 'b', p_entry: team });
    expect((await entryOf('Maya')).streak).toBe(0);
  });
});

describe('admin_swap', () => {
  test('swaps two players on opposite sides of a court', async () => {
    await admin('admin_swap', { p_a: P.Jon, p_b: P.Priya });
    expect((await board()).courts[0]).toBe('a: Maya+Priya | b: Jon+Sam');
  });

  test('swaps a player on court with one waiting in line, who takes the court spot', async () => {
    await admin('admin_swap', { p_a: P.Sam, p_b: P.Leo });
    const b = await board();
    expect(b.courts[0]).toBe('a: Jon+Maya | b: Leo+Priya');
    expect(b.queues[0]).toEqual(['Ava', 'Sam', 'Noor']);
  });

  test('partners on the same team: nothing to swap', async () => {
    const before = await board();
    await admin('admin_swap', { p_a: P.Maya, p_b: P.Jon });
    expect((await board()).courts).toEqual(before.courts);
  });
});

describe('admin_queue', () => {
  test('reorders a queue: drop Noor ahead of Ava', async () => {
    await admin('admin_queue', { p_queue_court: 0, p_before: (await entryOf('Ava')).id, p_entry: (await entryOf('Noor')).id });
    expect((await board()).queues[0]).toEqual(['Noor', 'Ava', 'Leo']);
  });

  test('moves to the end, and later sign-ups still join behind', async () => {
    await admin('admin_queue', { p_queue_court: 0, p_before: (await entryOf('Leo')).id, p_entry: (await entryOf('Ava')).id });
    await admin('admin_queue', { p_queue_court: 0, p_entry: (await entryOf('Leo')).id });
    await as('Admin', 'join_queue', { p_court: 0 });
    expect((await board()).queues[0]).toEqual(['Ava', 'Noor', 'Leo', 'Admin']);
  });

  test("moves a waiting player to another court's queue, where an open spot pulls them on", async () => {
    await admin('admin_queue', { p_queue_court: 1, p_entry: (await entryOf('Leo')).id });
    const b = await board();
    expect(b.courts[1]).toBe('a: Kai, Leo | b: ');
    expect(b.queues[0]).toEqual(['Ava', 'Noor']);
  });

  test('takes a player off court into a spot in line; the first in line fills the court', async () => {
    await admin('admin_queue', { p_queue_court: 0, p_before: (await entryOf('Leo')).id, p_user: P.Sam });
    const b = await board();
    expect(b.courts[0]).toBe('a: Jon+Maya | b: Priya, Ava');
    expect(b.queues[0]).toEqual(['Sam', 'Leo', 'Noor']);
  });

  test('a team cannot join a singles court queue', async () => {
    await db.query('update settings set singles_courts = $1', [[1]]);
    await expect(admin('admin_queue', { p_queue_court: 1, p_entry: (await entryOf('Maya')).id })).rejects.toThrow('Teams cannot queue for a singles court.');
  });

  test('a stale queue spot is refused', async () => {
    const ava = (await entryOf('Ava')).id;
    await admin('admin_kick', { p_user: P.Ava });
    await expect(admin('admin_queue', { p_queue_court: 0, p_before: ava, p_entry: (await entryOf('Noor')).id })).rejects.toThrow('just changed');
  });
});

describe('admin_pair and admin_split', () => {
  test('players cannot pair or split', async () => {
    await expect(as('Maya', 'admin_pair', { p_user: P.Ava, p_target: P.Noor })).rejects.toThrow('Admins only.');
    await expect(as('Maya', 'admin_split', { p_user: P.Maya })).rejects.toThrow('Admins only.');
  });

  test('two singles in line: the dragged one joins the target at the target’s spot', async () => {
    await admin('admin_pair', { p_user: P.Ava, p_target: P.Noor });
    expect((await board()).queues[0]).toEqual(['Leo', 'Ava+Noor']);
  });

  test('a player in line can join a single on court, if that side has room', async () => {
    await admin('admin_pair', { p_user: P.Noor, p_target: P.Kai });
    const b = await board();
    expect(b.courts[1]).toBe('a: Kai+Noor | b: ');
    expect(b.queues[0]).toEqual(['Ava', 'Leo']);
  });

  test('leaving a team to join someone else: the old partner stays put', async () => {
    await admin('admin_pair', { p_user: P.Jon, p_target: P.Ava });
    const b = await board();
    expect(b.queues[0][0]).toBe('Ava+Jon');
    expect(b.courts[0]).toBe('a: Maya, Leo | b: Priya+Sam');  // Leo, first single in line, fills Jon's spot
  });

  test('two singles on the same court side become a team', async () => {
    await admin('admin_place', { p_court: 1, p_side: 'a', p_user: P.Noor });  // Court 2 side a: Kai, Noor
    await admin('admin_pair', { p_user: P.Noor, p_target: P.Kai });
    expect((await board()).courts[1]).toBe('a: Kai+Noor | b: ');
  });

  test('refused: a target who already has a partner, a full side, or a singles court', async () => {
    await expect(admin('admin_pair', { p_user: P.Ava, p_target: P.Maya })).rejects.toThrow('Maya already has a partner. Split them up first.');
    await admin('admin_place', { p_court: 1, p_side: 'a', p_user: P.Noor });  // Court 2 side a: Kai, Noor (full)
    await expect(admin('admin_pair', { p_user: P.Ava, p_target: P.Kai })).rejects.toThrow('No room for a team on that side.');
    await db.query('update settings set singles_courts = $1', [[1]]);
    await admin('admin_pair', { p_user: P.Leo, p_target: P.Ava });  // Court 1 is still doubles: allowed
    await admin('admin_kick', { p_user: P.Noor });
    await expect(admin('admin_pair', { p_user: P.Jon, p_target: P.Kai })).rejects.toThrow('singles court');
  });

  test('split in line: the partner keeps the spot, the other waits right behind', async () => {
    await admin('admin_pair', { p_user: P.Noor, p_target: P.Ava });  // Ava+Noor, Leo
    await admin('admin_split', { p_user: P.Ava });                   // Ava owned the spot, but nobody is sent to the end
    expect((await board()).queues[0]).toEqual(['Noor', 'Ava', 'Leo']);
    await as('Admin', 'join_queue', { p_court: 0 });
    expect((await board()).queues[0]).toEqual(['Noor', 'Ava', 'Leo', 'Admin']);
  });

  test('split on court: both stay on their side', async () => {
    await admin('admin_split', { p_user: P.Jon });
    expect((await board()).courts[0]).toBe('a: Jon, Maya | b: Priya+Sam');
    await expect(admin('admin_split', { p_user: P.Jon })).rejects.toThrow('not on a team');
  });
});
