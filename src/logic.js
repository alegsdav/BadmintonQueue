// Pure view logic for the court board. No DOM, no network: everything here is unit-tested.
// State shape comes from the get_state() RPC; keys added by the court-board migration are optional
// so the board still renders against the older database (one shared queue, doubles everywhere).

/** @param {any} S @param {number} c @returns {1|2} players per side on court c */
export const capOf = (S, c) => (S.courtModes?.[c] === 'singles' ? 1 : 2);

const sizeOf = list => list.reduce((n, e) => n + e.members.length, 0);

/** Waiting entries for court c, in queue order. Entries without a court (legacy) wait for any court. */
export const courtQueue = (S, c) => S.queue.filter(e => e.queueCourt == null || e.queueCourt === c);

/** @returns {number} open player spots on court c */
export const openSpots = (S, c) => {
  const cap = capOf(S, c), court = S.courts[c];
  return Math.max(0, cap - sizeOf(court.a)) + Math.max(0, cap - sizeOf(court.b));
};

export const isLive = court => court.a.length > 0 && court.b.length > 0;

/** One entry per slot on each side: a user id, or null for an open spot. */
export const courtSlots = (S, c) => {
  const cap = capOf(S, c), court = S.courts[c];
  const fill = list => {
    const ids = list.flatMap(e => e.members).slice(0, cap);
    return [...ids, ...Array(cap - ids.length).fill(null)];
  };
  return { a: fill(court.a), b: fill(court.b) };
};

export const nameOf = (S, id) => S.names?.[id] || 'Player';
export const teamName = (S, members) => members.map(id => nameOf(S, id)).join(' & ');

/** Where the signed-in player is right now. */
export const myPlace = S => {
  const me = S.me.id, mine = e => e.members.includes(me);
  for (let c = 0; c < S.courts.length; c++) {
    for (const side of ['a', 'b']) {
      const entry = S.courts[c][side].find(mine);
      if (entry) return { where: 'court', court: c, side, entry };
    }
  }
  const entry = S.queue.find(mine);
  if (!entry) return null;
  const court = entry.queueCourt ?? null;
  const line = court === null ? S.queue : courtQueue(S, court);
  return { where: 'queue', court, pos: line.indexOf(entry) + 1, entry };
};

export const queueRows = (S, c) => courtQueue(S, c).map((e, i) => ({ id: e.id, n: i + 1, names: teamName(S, e.members), size: e.members.length }));

export const waitingLabel = (S, c) => {
  const n = courtQueue(S, c).length;
  if (!n) return 'No one waiting';
  const unit = capOf(S, c) === 1 ? (n === 1 ? 'player' : 'players') : (n === 1 ? 'team' : 'teams');
  return `${n} ${unit} waiting`;
};

export const spotsLabel = (S, c) => {
  const n = openSpots(S, c);
  return n ? `${n} ${n === 1 ? 'spot' : 'spots'} open` : '';
};

const off = label => ({ label, disabled: true });
const go = (label, k, b) => ({ label, disabled: false, action: { k, b } });

function courtButton(S, c, place) {
  const court = S.courts[c], n = c + 1;
  if (isLive(court) && (S.me.isAdmin || (place?.where === 'court' && place.court === c))) {
    return { results: ['a', 'b'].map(side => ({ label: `${teamName(S, court[side].flatMap(e => e.members))} won`, action: { k: 'win', b: { court: c, side } } })) };
  }
  if (place?.where === 'court') return off(`You're on Court ${place.court + 1}`);
  if (place?.where === 'queue') {
    if (place.court === c) return off(`You're in line · #${place.pos}`);
    if (place.entry.members.length > capOf(S, c)) return off(`Court ${n} is singles`);
    return go(`Join Court ${n} queue`, 'moveQueue', { court: c });
  }
  const label = openSpots(S, c) > 0 && courtQueue(S, c).length === 0 ? `Join Court ${n}` : `Join Court ${n} queue`;
  return go(label, 'join', { court: c });
}

function entryButton(S, id, place) {
  const entry = S.queue.find(e => e.id === id);
  if (!entry) return off('Join');
  if (entry.members.includes(S.me.id)) return off(`That's you · #${place?.pos ?? 1}`);
  if (entry.members.length > 1) return off('Team is full');
  if (entry.queueCourt != null && capOf(S, entry.queueCourt) === 1) return off('Singles queue');
  if (place?.where === 'court') return off('Finish your game first');
  if (place && place.entry.members.length > 1) return off('You already have a partner');
  return go('Join team', 'joinTeam', { entryId: id });
}

/**
 * The single bottom action for the current selection.
 * @param {any} S state from get_state()
 * @param {null | {kind: 'court', court: number} | {kind: 'entry', id: string}} sel
 * @returns {{label: string, disabled: boolean, action?: {k: string, b: object}} | {results: {label: string, action: {k: string, b: object}}[]}}
 */
export function buttonState(S, sel) {
  const place = myPlace(S);
  if (sel?.kind === 'court' && S.courts[sel.court]) return courtButton(S, sel.court, place);
  if (sel?.kind === 'entry') return entryButton(S, sel.id, place);
  return off('Join');
}

/** Drop a selection that no longer points at anything (e.g. the selected player got placed on court). */
export const validSelection = (S, sel) => {
  if (sel?.kind === 'court') return S.courts[sel.court] ? sel : null;
  if (sel?.kind === 'entry') return S.queue.some(e => e.id === sel.id) ? sel : null;
  return null;
};

/** True when the player just moved from waiting onto a court. */
export const justCalledUp = (before, after) => before?.where === 'queue' && after?.where === 'court';
