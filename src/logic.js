// Pure view logic for the court board. No DOM, no network: everything here is unit-tested.
// State shape comes from the get_state() RPC; keys added by the court-board migration are optional
// so the board still renders against the older database (one shared queue, doubles everywhere).

/** @param {any} S @param {number} c @returns {1|2} players per side on court c */
export const capOf = (S, c) => (S.courtModes?.[c] === 'singles' ? 1 : 2);

const sizeOf = list => list.reduce((n, e) => n + e.members.length, 0);

/** Waiting entries for court c, in queue order. Entries without a court (legacy) wait for any court. */
export const courtQueue = (S, c) => S.queue.filter(e => e.queueCourt == null || e.queueCourt === c);

/** Open player spots on one side of court c. */
export const sideRoom = (S, c, side) => Math.max(0, capOf(S, c) - sizeOf(S.courts[c][side]));

/** @returns {number} open player spots on court c */
export const openSpots = (S, c) => sideRoom(S, c, 'a') + sideRoom(S, c, 'b');

export const isLive = court => court.a.length > 0 && court.b.length > 0;

/** The side to join on court c: the one asked for if it has room, else any side with room, else null (queue). */
export const resolveSide = (S, c, wanted) => {
  if (wanted && sideRoom(S, c, wanted) > 0) return wanted;
  return ['a', 'b'].find(s => sideRoom(S, c, s) > 0) ?? null;
};

/**
 * One entry per slot on each side: a user id, or null for an open spot.
 * With a preview, the signed-in player is drawn in the first open slot of that side.
 */
export const courtSlots = (S, c, preview = null) => {
  const cap = capOf(S, c), court = S.courts[c];
  const fill = list => {
    const ids = list.flatMap(e => e.members).slice(0, cap);
    return [...ids, ...Array(cap - ids.length).fill(null)];
  };
  const slots = { a: fill(court.a), b: fill(court.b) };
  if (preview?.court === c && preview.side) {
    const i = slots[preview.side].indexOf(null);
    if (i >= 0) slots[preview.side][i] = S.me.id;
  }
  return slots;
};

export const nameOf = (S, id) => S.names?.[id] || (id === S.me?.id ? S.me.name : 'Player');
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

export const queueRows = (S, c) => courtQueue(S, c).map((e, i) => ({ id: e.id, n: i + 1, names: teamName(S, e.members), size: e.members.length, members: e.members }));

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
const LEAVE = () => go('Leave', 'leave', {});

function courtButtons(S, sel, place) {
  const c = sel.court, n = c + 1, court = S.courts[c];
  const onThis = place?.where === 'court' && place.court === c;
  const queuedHere = place?.where === 'queue' && place.court === c;
  const buttons = [];
  if (isLive(court) && (onThis || S.me.isAdmin)) {
    for (const side of ['a', 'b']) buttons.push(go(`${teamName(S, court[side].flatMap(e => e.members))} won`, 'win', { court: c, side }));
  }
  const secondary = b => (buttons.length ? { ...b, secondary: true } : b);
  if (onThis) return { buttons: [...buttons, secondary(LEAVE())], preview: null };
  if (queuedHere) {
    // a solo waiting for this court may take an open spot by hand (open spots next to someone are never filled automatically)
    const side = place.entry.members.length === 1 ? resolveSide(S, c, sel.side) : null;
    if (!side) return { buttons: [...buttons, secondary(LEAVE())], preview: null };
    return { buttons: [...buttons, secondary(go(`Join Court ${n}`, 'switchCourt', { court: c, side })), { ...LEAVE(), secondary: true }], preview: { court: c, side } };
  }

  const side = resolveSide(S, c, sel.side);
  const teamInQueue = place?.where === 'queue' && place.entry.members.length > 1;
  let main, preview = null;
  if (teamInQueue) {
    main = place.entry.members.length > capOf(S, c) ? off(`Court ${n} is singles`) : go(`Move team to Court ${n}`, 'moveQueue', { court: c });
  } else if (!place) {
    main = side ? go(`Join Court ${n}`, 'joinCourt', { court: c, side }) : go(`Join Court ${n} queue`, 'join', { court: c });
    preview = side ? { court: c, side } : null;
  } else {
    main = go(side ? `Leave & join Court ${n}` : `Leave & join Court ${n} queue`, 'switchCourt', { court: c, side });
    preview = side ? { court: c, side } : null;
  }
  return { buttons: [...buttons, secondary(main)], preview };
}

function entryButtons(S, id, place) {
  const entry = S.queue.find(e => e.id === id);
  const one = b => ({ buttons: [b], preview: null });
  if (!entry) return null;
  if (entry.members.includes(S.me.id)) return one(LEAVE());
  if (entry.members.length > 1) return one(off('Team is full'));
  if (entry.queueCourt != null && capOf(S, entry.queueCourt) === 1) return one(off('Singles queue'));
  if (place?.where === 'court') return one(off('Finish your game first'));
  if (place && place.entry.members.length > 1) return one(off('You already have a partner'));
  return one(go('Join team', 'joinTeam', { entryId: id }));
}

/**
 * The bottom actions for the current selection, or null when nothing is selected (no bar is shown).
 * @param {any} S state from get_state()
 * @param {null | {kind: 'court', court: number, side?: 'a'|'b'|null} | {kind: 'entry', id: string}} sel
 * @returns {null | {buttons: {label: string, disabled: boolean, secondary?: boolean, action?: {k: string, b: object}}[], preview: null | {court: number, side: 'a'|'b'}}}
 */
export function buttonState(S, sel) {
  const place = myPlace(S);
  if (sel?.kind === 'court' && S.courts[sel.court]) return courtButtons(S, sel, place);
  if (sel?.kind === 'entry') return entryButtons(S, sel.id, place);
  return null;
}

/** Drop a selection that no longer points at anything (e.g. the selected player got placed on court). */
export const validSelection = (S, sel) => {
  if (sel?.kind === 'court') return S.courts[sel.court] ? sel : null;
  if (sel?.kind === 'entry') return S.queue.some(e => e.id === sel.id) ? sel : null;
  if (sel?.kind === 'player' || sel?.kind === 'pairWith') return findEntry(S, e => e.members.includes(sel.user)) ? sel : null;
  return null;
};

/** True when the player just moved from waiting onto a court. */
export const justCalledUp = (before, after) => before?.where === 'queue' && after?.where === 'court';

// ---- admin drag and drop ----

/** The entry matching pred, and where it is: on a court side, or waiting (court null). */
export const findEntry = (S, pred) => {
  for (let c = 0; c < S.courts.length; c++) {
    for (const side of ['a', 'b']) {
      const entry = S.courts[c][side].find(pred);
      if (entry) return { entry, court: c, side };
    }
  }
  const entry = S.queue.find(pred);
  return entry ? { entry, court: null, side: null } : null;
};

/**
 * What an admin drop does.
 * @param {any} S
 * @param {{kind: 'player', user: string} | {kind: 'entry', id: string}} src a player on court, or a team or player in line
 * @param {{kind: 'player', user: string} | {kind: 'side', court: number, side: 'a'|'b'} | {kind: 'row', court: number, id: string} | {kind: 'queueEnd', court: number} | {kind: 'bin'}} target
 * @returns {null | {error: string} | {k: string, b: object, msg: string}} null when the drop changes nothing
 */
export function dropAction(S, src, target) {
  if (!src || !target) return null;
  const found = src.kind === 'player' ? findEntry(S, e => e.members.includes(src.user)) : findEntry(S, e => e.id === src.id);
  if (!found) return null;
  const { entry } = found;
  const single = src.kind === 'player' ? src.user : entry.members.length === 1 ? entry.members[0] : null;
  const who = single ? nameOf(S, single) : teamName(S, entry.members);
  const mover = src.kind === 'player' ? { userId: src.user } : { entryId: entry.id };
  const size = single ? 1 : entry.members.length;

  if (target.kind === 'bin') {
    return single ? { k: 'kick', b: { userId: single }, msg: `Removed ${who}` } : { k: 'removePair', b: { entryId: entry.id }, msg: `Removed ${who}` };
  }
  if (target.kind === 'player') {
    if (entry.members.includes(target.user)) return null;
    if (single) return { k: 'swap', b: { a: single, b: target.user }, msg: `Swapped ${who} and ${nameOf(S, target.user)}` };
    const other = findEntry(S, e => e.members.includes(target.user));  // a whole team trades places with that player
    return other ? { k: 'swapEntries', b: { a: entry.id, b: other.entry.id }, msg: `Swapped ${who} and ${teamName(S, other.entry.members)}` } : null;
  }
  if (target.kind === 'team') {
    const other = findEntry(S, e => e.id === target.id);
    if (!other || other.entry === entry) return null;
    if (src.kind === 'player' && entry.members.length > 1) return { error: 'Drag the whole team, or split them up first.' };
    return { k: 'swapEntries', b: { a: entry.id, b: other.entry.id }, msg: `Swapped ${who} and ${teamName(S, other.entry.members)}` };
  }
  if (target.kind === 'side') {
    const { court: c, side } = target;
    if (found.court === c && found.side === side) return null;
    if (sideRoom(S, c, side) < size) {
      return { error: single ? 'That side is full. Drop onto a player to swap them.' : `That side of Court ${c + 1} has no room for a team.` };
    }
    return { k: 'place', b: { court: c, side, ...mover }, msg: `Moved ${who} to Court ${c + 1}` };
  }
  if (target.kind === 'row' || target.kind === 'queueEnd') {
    const c = target.court, before = target.kind === 'row' ? target.id : null;
    if (before === entry.id) return null;
    if (size > capOf(S, c)) return { error: `Court ${c + 1} is singles, so teams can't wait for it.` };
    if (found.court === null && (src.kind === 'entry' || entry.members.length === 1)) {
      const line = courtQueue(S, c), i = line.indexOf(entry);
      if (i >= 0 && (before ? line[i + 1]?.id === before : i === line.length - 1)) return null;  // already in that spot
    }
    return { k: 'queue', b: { court: c, before, ...mover }, msg: `Moved ${who} in line for Court ${c + 1}` };
  }
  return null;
}

// ---- admin pairing: tap a player, then "Team up with…" and tap the partner ----

const partnerOf = (S, user) => findEntry(S, e => e.members.includes(user))?.entry.members.find(id => id !== user) ?? null;

/**
 * Bottom buttons while an admin has a player selected. A button with `local` is handled in the page, not sent to the database.
 * @param {any} S @param {{kind: 'player' | 'pairWith', user: string}} sel
 */
export function adminButtons(S, sel) {
  const name = nameOf(S, sel.user);
  if (sel.kind === 'pairWith') {
    return { buttons: [{ label: `Now tap ${name}'s new partner`, disabled: true }, { label: 'Cancel', disabled: false, local: 'clear', secondary: true }], preview: null };
  }
  const partner = partnerOf(S, sel.user);
  const buttons = [{ label: partner ? `Pair ${name} with someone else` : `Team ${name} up with…`, disabled: false, local: 'pairStart' },
    { label: `Swap ${name} with…`, disabled: false, secondary: true, local: 'swapPick' }];
  if (partner) buttons.push({ label: `Split from ${nameOf(S, partner)}`, disabled: false, secondary: true, action: { k: 'split', b: { userId: sel.user } } });
  buttons.push({ label: `Remove ${name}`, disabled: false, secondary: true, action: { k: 'kick', b: { userId: sel.user } } });
  return { buttons, preview: null };
}

/**
 * Teaming `user` up with `target`: user joins target wherever target is.
 * @returns {null | {error: string} | {k: string, b: object, msg: string}}
 */
export function pairAction(S, user, target) {
  if (!user || !target || user === target) return null;
  const mine = findEntry(S, e => e.members.includes(user)), theirs = findEntry(S, e => e.members.includes(target));
  if (!mine || !theirs) return null;
  if (mine.entry === theirs.entry) return { error: `${nameOf(S, user)} and ${nameOf(S, target)} are already a team.` };
  if (theirs.entry.members.length > 1) return { error: `${nameOf(S, target)} already has a partner. Split them up first.` };
  const c = theirs.court ?? theirs.entry.queueCourt;
  if (c != null && capOf(S, c) < 2) return { error: `Court ${c + 1} is singles, so teams can't play or wait there.` };
  if (theirs.court != null) {
    const sameSide = mine.court === theirs.court && mine.side === theirs.side;
    if (sideRoom(S, theirs.court, theirs.side) + (sameSide ? 1 : 0) < 1) return { error: 'No room for a team on that side. Move someone off it first.' };
  }
  return { k: 'pair', b: { userId: user, targetId: target }, msg: `${nameOf(S, user)} and ${nameOf(S, target)} are now a team` };
}

/**
 * What to draw on each side of court c: a team (drawn side by side with one name tag), single players, and open spots.
 * With a preview, the signed-in player is drawn in the first open spot of that side.
 * @returns {{cap: 1|2, a: Spot[], b: Spot[]}} where Spot = {team: string, members: string[]} | {id: string, preview?: boolean} | {open: true}
 */
export function courtLayout(S, c, preview = null) {
  const cap = capOf(S, c), court = S.courts[c];
  const side = s => {
    const out = [];
    for (const e of court[s]) {
      if (cap === 2 && e.members.length === 2) out.push({ team: e.id, members: e.members });
      else e.members.forEach(id => out.push({ id }));
    }
    let used = out.reduce((n, x) => n + (x.team ? 2 : 1), 0);
    if (preview?.court === c && preview.side === s && used < cap) { out.push({ id: S.me.id, preview: true }); used++; }
    for (; used < cap; used++) out.push({ open: true });
    return out;
  };
  return { cap, a: side('a'), b: side('b') };
}

/** Where a player is, for the admin's player list. */
export function placeLabel(S, id) {
  const found = findEntry(S, e => e.members.includes(id));
  if (!found) return 'Not signed up';
  const partner = found.entry.members.find(m => m !== id);
  const withWho = partner ? ` with ${nameOf(S, partner)}` : '';
  if (found.court !== null) return `On Court ${found.court + 1}${withWho}`;
  const qc = found.entry.queueCourt;
  return `${qc == null ? 'In line' : `In line for Court ${qc + 1}`}${withWho}`;
}
