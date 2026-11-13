import { createClient } from '@supabase/supabase-js';
import './style.css';
import { adminButtons, buttonState, capOf, courtLayout, courtSlots, dropAction, findEntry, isLive, myPlace, nameOf, pairAction, placeLabel, queueRows, resolveSide, spotsLabel, teamName, validSelection, waitingLabel } from './logic.js';
import { courtArt, esc, racket } from './pixel.js';

const URL = import.meta.env.VITE_SUPABASE_URL, KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const $app = document.getElementById('app');
// Dev only: /?mock runs the real schema in the browser instead of the live project (stripped from production builds)
const MOCK = import.meta.env.DEV && new URLSearchParams(location.search).has('mock');
if (!MOCK && (!URL || !KEY)) {
  $app.innerHTML = '<main class="auth"><div class="panel"><h1>Almost there</h1><p class="mute">Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to <code>.env.local</code> (or Vercel’s environment variables), then restart.</p></div></main>';
  throw new Error('Missing Supabase env vars');
}
const sb = MOCK ? await (await import('./dev/mock.js')).createMockClient() : createClient(URL, KEY);

// ---- data layer: every change is a Postgres function in the Supabase project ----
const RPC = {
  state: ['get_state', () => ({})],
  join: ['join_queue', b => ({ p_court: b.court })],
  joinCourt: ['join_court', b => ({ p_court: b.court, p_side: b.side })],
  leave: ['leave_queue', () => ({})],
  leaveTeam: ['leave_ready_team', () => ({})],
  switchCourt: ['switch_court', b => ({ p_court: b.court, p_side: b.side ?? null })],
  moveQueue: ['move_queue', b => ({ p_court: b.court })],
  invite: ['invite_player', b => ({ p_user: b.userId })],
  candidates: ['invite_candidates', () => ({})],
  respond: ['respond_invite', b => ({ p_id: b.id, p_accept: b.accept })],
  cancelInvite: ['cancel_invite', b => ({ p_id: b.id })],
  win: ['report_win', b => ({ p_court: b.court, p_side: b.side })],
  // admin
  place: ['admin_place', b => ({ p_court: b.court, p_side: b.side, p_entry: b.entryId ?? null, p_user: b.userId ?? null })],
  queue: ['admin_queue', b => ({ p_queue_court: b.court, p_before: b.before ?? null, p_entry: b.entryId ?? null, p_user: b.userId ?? null })],
  swap: ['admin_swap', b => ({ p_a: b.a, p_b: b.b })],
  kick: ['admin_kick', b => ({ p_user: b.userId })],
  removePair: ['admin_remove_pair', b => ({ p_entry: b.entryId })],
  pair: ['admin_pair', b => ({ p_user: b.userId, p_target: b.targetId })],
  split: ['admin_split', b => ({ p_user: b.userId })],
  seat: ['admin_seat', b => ({ p_court: b.court, p_side: b.side, p_user: b.userId })],
  swapEntries: ['admin_swap_entries', b => ({ p_a: b.a, p_b: b.b })],
  players: ['admin_players', () => ({})],
  reset: ['admin_reset', b => ({ p_confirm: b.confirm })],
  allow: ['admin_allow', b => ({ p_email: b.email, p_add: b.add })],
  loser: ['admin_set_loser_back', b => ({ p_loser_back: b.loserBack })],
};
const api = async (k, b = {}) => { const [fn, m] = RPC[k]; const { data, error } = await sb.rpc(fn, m(b)); if (error) throw new Error(error.message); return data; };

let S = null, mode = 'login', authErr = '', authMsg = '', booted = false;
let requestId = 0, loadingRequest = null, sessionUser = null, signingOut = false, mutation = null;
let pendingRender = false;
let sel = null;          // {kind:'court', court, side} | {kind:'entry', id} | null
let adminMode = false, visibleInviteId = null;
// Only one dialog can be open: settings (with optional reset confirmation), or a player picker.
let dialog = null;
let drag = null;          // admin drag in progress: {src, label, x, y, pointerId, touch, timer, active, ghost, over}
let swallowClick = false; // true right after a drop, so the click that follows doesn't also select something
const adminOn = () => adminMode && !!S?.me?.isAdmin;
const incoming = state => state?.invites?.filter(invite => invite.to === state.me?.id) ?? [];

let toastT; const toast = m => { const t = document.getElementById('toast'); t.textContent = m; t.className = 'show'; clearTimeout(toastT); toastT = setTimeout(() => t.className = '', 3500); };

async function load(force) {
  if (signingOut || (!force && loadingRequest !== null)) return;
  const request = ++requestId;
  loadingRequest = request;
  try {
    const { data: { session }, error } = await sb.auth.getSession();
    if (request !== requestId) return;
    const user = session?.user.id ?? null;
    const changedUser = user !== sessionUser;
    if (changedUser) {
      sessionUser = user;
      S = dialog = sel = mutation = null;
      adminMode = false;
      visibleInviteId = null;
      endDrag();
      if (booted) render();
    }
    if (error) throw error;
    const next = user ? await api('state') : null;
    if (request !== requestId || (next?.me && next.me.id !== user)) return;
    const changedAdmin = S?.me?.isAdmin !== next?.me?.isAdmin;
    if (changedAdmin && !next?.me?.isAdmin) {
      adminMode = false;
      if (dialog && dialog.kind !== 'invite') dialog = null;
      if (sel?.user) sel = null;
      endDrag();
    }
    const invites = incoming(next);
    const incomingChanged = JSON.stringify(incoming(S)) !== JSON.stringify(invites);
    if (!invites.some(invite => invite.id === visibleInviteId)) visibleInviteId = invites[0]?.id ?? null;
    if (JSON.stringify(S) !== JSON.stringify(next)) pendingRender = true;
    S = next;
    sel = S?.me ? validSelection(S, sel) : null;
    const wasBooted = booted;
    booted = true;
    const editing = document.activeElement?.matches('input, select, textarea');
    if (force || !wasBooted || changedAdmin || (incomingChanged && !dialog) || (pendingRender && !editing)) render();
  } catch (error) {
    if (request !== requestId) return;
    booted = true;
    if (!S) render();
    toast(error.message);
  } finally {
    if (loadingRequest === request) loadingRequest = null;
  }
}

async function act(k, b, done) {
  if (mutation || signingOut) return false;
  const current = {};
  mutation = current;
  try {
    await api(k, b);
    if (mutation !== current || signingOut) return false;
    sel = null;
    await load(true);
    if (mutation !== current || signingOut) return false;
    if (done) toast(done);
    return true;
  } catch (error) {
    if (mutation === current && !signingOut) {
      toast(error.message);
      await load(true);
    }
    return false;
  } finally {
    if (mutation === current) mutation = null;
  }
}

async function signOut() {
  if (signingOut) return;
  signingOut = true;
  requestId++;
  mutation = null;
  try {
    const { error } = await sb.auth.signOut();
    if (error) toast(error.message);
  } catch (error) {
    toast(error.message);
  } finally {
    signingOut = false;
    await load(true);
  }
}

// ---- views ----
const WORDMARK = `<div class="brand">${racket()}<span>Slugminton</span></div>`;
const AUTH_MARK = `<div class="brand big">${racket({ strings: true })}<span>Slugminton</span></div>`;

function authView() {
  const reg = mode === 'register';
  return `<main class="auth"><div class="panel">${AUTH_MARK}
    <h1>${reg ? 'Join the club' : 'Next up on court'}</h1>
    <p class="mute">${reg ? 'Create an account to claim a spot on court.' : 'Sign in to see the courts and your place in line.'}</p>
    <form data-form="auth">${reg ? '<label>Your name<input type="text" name="name" autocomplete="name" required maxlength="40"></label>' : ''}
      <label>Email<input type="email" name="email" autocomplete="email" required></label>
      <label>Password<input type="password" name="password" placeholder="8+ characters" autocomplete="${reg ? 'new-password' : 'current-password'}" required minlength="8"></label>
      <button class="cta">${reg ? 'Create account' : 'Sign in'}</button></form>
    <p class="err" role="alert">${esc(authErr)}</p><p class="mute" role="status">${esc(authMsg)}</p>
    <button type="button" class="link" data-act="mode">${reg ? 'Already have an account? Sign in' : 'New here? Create an account'}</button></div></main>`;
}

function courtLabel(c, slots) {
  const team = ids => ids.filter(Boolean).map(id => nameOf(S, id)).join(' and ') || 'open';
  return `Court ${c + 1}: ${team(slots.a)} versus ${team(slots.b)}. ${spotsLabel(S, c) || 'Full'}. ${waitingLabel(S, c)}.`;
}

function courtBlock(court, c, preview) {
  const slots = courtSlots(S, c, preview), spots = spotsLabel(S, c);
  const picked = sel?.kind === 'court' && sel.court === c;
  const rows = queueRows(S, c);
  const list = rows.length ? `<div class="queue" data-scroll="${c}" tabindex="0" aria-label="Court ${c + 1} queue">${rows.map(r => {
    const on = sel?.kind === 'entry' && sel.id === r.id;
    return `<button type="button" class="row${on ? ' sel' : ''}" data-act="pickEntry" data-id="${esc(r.id)}" aria-pressed="${on}"><span class="n">${r.n}</span><span>${adminOn() ? r.members.map(id => `<span class="mem" data-user="${esc(id)}">${esc(nameOf(S, id))}</span>`).join(' &amp; ') : esc(r.names)}</span></button>`;
  }).join('')}</div>` : '';
  return `<section class="court-col">
    <button type="button" class="court${picked ? ' sel' : ''}" data-act="pickCourt" data-court="${c}" aria-pressed="${picked}" aria-label="${esc(courtLabel(c, slots))}">
      <span class="court-head"><span class="title">Court ${c + 1}${S.courtModes?.[c] === 'singles' ? ' <small>Singles</small>' : ''}<span class="hint">Tap to join or queue</span></span>${spots ? `<span class="spots">${spots}</span>` : ''}</span>
      ${courtArt(courtLayout(S, c, preview), id => nameOf(S, id), isLive(court), S.me.id)}
    </button>
    <div class="next" data-court="${c}"><div class="next-head"><span>Up next</span><span class="mute">${waitingLabel(S, c)}</span></div>${list}</div>
  </section>`;
}

function actionBar(st) {
  if (!st) return '';
  const button = btn => {
    const a = btn.action ? ` data-act="do" data-k="${btn.action.k}" data-b="${esc(JSON.stringify(btn.action.b))}"`
      : btn.local ? ` data-act="${btn.local}"` : '';
    return `<button type="button" class="cta${btn.secondary ? ' alt' : ''}"${a} aria-disabled="${btn.disabled}">${esc(btn.label)}</button>`;
  };
  return `<div class="bar${st.buttons.length > 1 ? ' stack' : ''}">${st.buttons.map(button).join('')}</div>`;
}

function adminStrip() {
  if (!adminOn()) return '';
  return `<div class="admin-strip"><p><b>Admin mode.</b> Drag players onto a side, onto someone to swap, into a queue, or to the bin (on a phone, press and hold first). Tap a player to team them up, split them, or remove them.</p>
    <button type="button" class="chip-btn" data-act="settings">Settings</button></div>`;
}

function resetView() {
  const n = S.queue.concat(...S.courts.flatMap(c => [c.a, c.b])).reduce((sum, e) => sum + e.members.length, 0);
  if (dialog.resetWord === null) {
    return `<div class="danger"><h3>Practice reset</h3><p class="mute">Take everyone off every court and out of every queue.</p>
      <button type="button" class="chip-btn warn" data-act="resetStart">Clear all courts and queues…</button></div>`;
  }
  return `<div class="danger confirm" role="alert"><h3>Clear everything?</h3>
    <p>This removes all ${n} ${n === 1 ? 'player' : 'players'} from every court and queue. It can't be undone.</p>
    <label>Type <b>CLEAR</b> to confirm<input type="text" data-input="resetWord" value="${esc(dialog.resetWord)}" autocomplete="off" autocapitalize="characters" spellcheck="false"></label>
    <div class="row-btns"><button type="button" class="chip-btn" data-act="resetCancel">Cancel</button>
      <button type="button" class="chip-btn warn" data-act="resetDo" aria-disabled="${dialog.resetWord.trim() !== 'CLEAR'}">Clear all courts and queues</button></div></div>`;
}

function pickerView() {
  const picker = dialog;
  if (!picker || picker.kind === 'settings') return '';
  const invite = picker.kind === 'invite', swap = picker.kind === 'swap';
  const skip = swap ? new Set(findEntry(S, e => e.members.includes(picker.user))?.entry.members ?? [picker.user]) : new Set();
  const pending = new Set((S.invites ?? []).map(i => i.from === S.me.id ? i.to : i.from));
  const players = picker.players.filter(p => !skip.has(p.id) && (!invite || !pending.has(p.id)));
  const q = picker.query.trim().toLowerCase();
  let hasMatches = false;
  const list = players.map(p => {
    const key = (invite ? p.name : `${p.name} ${p.email}`).toLowerCase();
    const match = key.includes(q);
    hasMatches ||= match;
    return `<li${match ? '' : ' hidden'}><button type="button" class="pick" data-act="pickPick" data-user="${esc(p.id)}" data-search="${esc(key)}">
      <b>${esc(p.name)}</b><span class="mute">${invite ? 'Invite' : esc(placeLabel(S, p.id))}</span></button></li>`;
  }).join('');
  const name = swap ? esc(nameOf(S, picker.user)) : '';
  const title = invite ? 'Invite a teammate' : swap ? `Swap ${name} with…` : `Add to Court ${picker.court + 1}`;
  const help = invite ? 'Choose a player. You’ll team up when they accept.'
    : swap ? `They trade places, teammates included. Pick someone who isn't signed up and they take ${name}'s spot while ${name} leaves.`
      : `${picker.side === 'a' ? 'Left' : 'Right'} side. Players already on a court or in line move here; a teammate in line keeps their spot.`;
  const results = picker.status === 'loading' ? '<p class="mute" role="status">Loading players…</p>'
    : picker.status === 'error' ? `<p class="err" role="alert">${esc(picker.error)}</p>`
      : `<ul class="picks" data-scroll="picks">${list}</ul>
        <p class="mute" data-empty-picks${hasMatches ? ' hidden' : ''}>${players.length ? 'No matching players.' : 'No available players.'}</p>`;
  const sent = invite ? (S.invites ?? []).filter(i => i.from === S.me.id) : [];
  const sentInvites = sent.length ? `<div class="sent-invites"><h3>Awaiting acceptance</h3><ul>
    ${sent.map(i => `<li><span>${esc(nameOf(S, i.to))}</span><button type="button" class="link" data-act="cancelInvite" data-id="${esc(i.id)}" aria-label="Cancel invite to ${esc(nameOf(S, i.to))}">Cancel</button></li>`).join('')}
    </ul></div>` : '';
  return `<div class="sheet-wrap"><button type="button" class="scrim" data-act="closePicker" aria-label="Close player list"></button>
    <section class="panel sheet" data-scroll="picker" role="dialog" aria-modal="true" aria-labelledby="picker-title">
      <div class="sheet-head"><h2 id="picker-title">${title}</h2><button type="button" class="chip-btn" data-act="closePicker">Close</button></div>
      <p class="mute">${help}</p>
      <input type="search" data-input="pickerSearch" value="${esc(picker.query)}" placeholder="${invite ? 'Search by name' : 'Search by name or email'}" aria-label="Search players">
      ${results}${sentInvites}
    </section></div>`;
}

function openPicker(what) {
  const picker = { ...what, status: 'loading', query: '', players: [] };
  dialog = picker; sel = null; render();
  $app.querySelector('[data-input="pickerSearch"]')?.focus();
  loadPicker(picker);
}

async function loadPicker(picker) {
  try {
    picker.players = await api(picker.kind === 'invite' ? 'candidates' : 'players');
    picker.status = 'ready';
  } catch (error) {
    picker.status = 'error';
    picker.error = error.message;
  }
  if (dialog === picker) render();
}

function closeDialog() {
  const kind = dialog?.kind;
  dialog = null;
  render();
  if (kind === 'invite') $app.querySelector('[data-act="openInvite"]')?.focus();
}

function inviteBanner() {
  const invites = incoming(S);
  if (!invites.length) return '';
  const index = Math.max(0, invites.findIndex(invite => invite.id === visibleInviteId));
  const invite = invites[index];
  const arrow = (direction, label, glyph) => `<button type="button" class="invite-arrow" data-act="${direction}" aria-label="${label}">${glyph}</button>`;
  const multiple = invites.length > 1;
  return `<section class="invite-banner${multiple ? ' multiple' : ''}" aria-label="Pending teammate invitations">
    ${multiple ? arrow('prevInvite', 'Previous invite', '‹') : ''}
    <p aria-live="polite"><strong>${esc(nameOf(S, invite.from))}</strong> invited you to team up.
      ${multiple ? `<span class="invite-count">${index + 1} of ${invites.length}</span>` : ''}</p>
    <div class="invite-actions">
      <button type="button" class="chip-btn invite-primary" data-act="acceptInvite" data-id="${esc(invite.id)}">Accept</button>
      <button type="button" class="chip-btn" data-act="declineInvite" data-id="${esc(invite.id)}">Decline</button>
    </div>
    ${multiple ? arrow('nextInvite', 'Next invite', '›') : ''}
  </section>`;
}

function cycleInvite(offset, action) {
  const invites = incoming(S);
  if (invites.length < 2) return;
  const index = Math.max(0, invites.findIndex(invite => invite.id === visibleInviteId));
  visibleInviteId = invites[(index + offset + invites.length) % invites.length].id;
  render();
  $app.querySelector(`[data-act="${action}"]`)?.focus({ preventScroll: true });
}

function settingsView() {
  if (dialog?.kind !== 'settings' || !adminOn()) return '';
  const admins = S.admins?.list ?? [];
  return `<div class="sheet-wrap"><button type="button" class="scrim" data-act="closeSettings" aria-label="Close settings"></button>
    <section class="panel sheet" data-scroll="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div class="sheet-head"><h2 id="settings-title">Settings</h2><button type="button" class="chip-btn" data-act="closeSettings">Done</button></div>
      <label class="switch"><input type="checkbox" data-act="loser"${S.loserBack ? ' checked' : ''}>
        <span><b>Losers rejoin the queue</b><span class="mute">When off, the losing team leaves the court and has to sign up again.</span></span></label>
      <div class="admins"><h3>Admins</h3><p class="mute">Confirmed accounts with these emails get the admin tools.</p>
        <ul>${admins.map(m => `<li><span>${esc(m)}</span><button type="button" class="link" data-act="rmAdmin" data-email="${esc(m)}" aria-label="Remove ${esc(m)} as admin">Remove</button></li>`).join('')}</ul>
        <form data-form="allow" class="add"><input type="email" name="email" placeholder="name@ucsc.edu" required aria-label="New admin email"><button class="cta">Add</button></form></div>
      ${resetView()}
    </section></div>`;
}

function mainView() {
  const adm = adminOn(), picking = adm && (sel?.kind === 'player' || sel?.kind === 'pairWith');
  const st = picking ? adminButtons(S, sel) : buttonState(S, sel), dim = sel && !picking;
  const adminBtn = S.me.isAdmin ? `<button type="button" class="signout${adm ? ' on' : ''}" data-act="admin" aria-pressed="${adm}">Admin</button>` : '';
  const place = myPlace(S);
  const canInvite = !S.readyTeammate && (!place || (place.where === 'queue' && place.entry.members.length === 1 && capOf(S, place.court) === 2));
  const placedPartner = place?.entry.members.find(id => id !== S.me.id);
  const teammateName = S.readyTeammate?.name ?? (placedPartner ? nameOf(S, placedPartner) : null);
  const teammate = teammateName === null ? '' : `<div class="teammate"><span>Teammate: <strong>${esc(teammateName)}</strong></span>${S.readyTeammate ? '<button type="button" class="link" data-act="leaveTeam">Leave team</button>' : ''}</div>`;
  const hasSent = S.invites?.some(i => i.from === S.me.id);
  const invite = `<button type="button" class="signout" data-act="openInvite"${canInvite || hasSent ? '' : ' disabled title="Invites are available when off court, unpaired, and outside a singles queue"'}>Invite</button>`;
  return `<div class="board${dim ? ' has-sel' : ''}${adm ? ' admin' : ''}${sel?.kind === 'pairWith' ? ' pairing' : ''}"${dialog ? ' inert' : ''}>
    ${inviteBanner()}
    <header class="top${teammate ? ' has-teammate' : ''}">${WORDMARK}${teammate}<div class="top-actions">${invite}${adminBtn}<button type="button" class="signout" data-act="out">Sign out</button></div></header>
    ${adminStrip()}
    <div class="courts">${S.courts.map((court, c) => courtBlock(court, c, st?.preview)).join('')}</div>
    ${dim ? '<button type="button" class="scrim" data-act="clear" aria-label="Close selection"></button>' : ''}
    ${actionBar(st)}${adm ? '<div class="bin" aria-hidden="true">Drop here to remove</div>' : ''}</div>${settingsView()}${pickerView()}`;
}

/** Which half of the court was tapped: a "+" spot's own side, else the half under the pointer (null for keyboard). */
function tappedSide(e, courtButton) {
  const spot = e.target.closest('.open');
  if (spot) return spot.dataset.side;
  if (!e.detail) return null;
  const art = courtButton.querySelector('.art')?.getBoundingClientRect();
  if (!art) return null;
  return e.clientX < art.left + art.width / 2 ? 'a' : 'b';
}

function render() {
  if (!booted) return;
  if (drag?.active) { pendingRender = true; return; }  // never rebuild the board under a drag
  pendingRender = false;
  const active = document.activeElement;
  const focusedInput = active?.dataset.input;
  const scrolls = [...$app.querySelectorAll('[data-scroll]')].map(el => [el.dataset.scroll, el.scrollTop]);
  $app.innerHTML = S && S.me ? mainView() : authView();
  for (const [k, top] of scrolls) { const el = $app.querySelector(`[data-scroll="${k}"]`); if (el) el.scrollTop = top; }
  if (sel?.user) $app.querySelectorAll(`[data-user="${CSS.escape(sel.user)}"]`).forEach(el => el.classList.add('picked'));
  if (focusedInput) {
    const input = $app.querySelector(`[data-input="${CSS.escape(focusedInput)}"]`);
    input?.focus({ preventScroll: true });
    if (input && active.selectionStart !== null) input.setSelectionRange(active.selectionStart, active.selectionEnd);
  }
}

// ---- events ----
/** A tap on the dimmed scrim selects the court or queue row under it, so switching takes one tap. */
/** Admin mode: tapping a player (on court, or a name in line) selects them; while pairing, it picks the partner. */
function adminTap(e) {
  if (e.target.closest('.bar, .admin-strip, .top')) return false;
  const open = e.target.closest('.open[data-side]');
  if (open && sel?.kind !== 'pairWith') { openPicker({ kind: 'seat', court: +open.closest('.court').dataset.court, side: open.dataset.side }); return true; }
  let user = e.target.closest('.tag[data-user]:not(.preview), .mem[data-user], .tm[data-user]')?.dataset.user;
  if (!user && sel?.kind === 'pairWith') {  // a tap on a single's row also counts as that player
    const row = e.target.closest('.row[data-id]'), found = row && findEntry(S, x => x.id === row.dataset.id);
    if (found?.entry.members.length === 1) user = found.entry.members[0];
  }
  if (!user) return false;
  if (sel?.kind === 'pairWith') {
    const a = pairAction(S, sel.user, user);
    if (a?.error) toast(a.error); else if (a) act(a.k, a.b, a.msg);
    return true;
  }
  sel = sel?.kind === 'player' && sel.user === user ? null : { kind: 'player', user };
  render();
  return true;
}

function underScrim(e) {
  return document.elementsFromPoint(e.clientX, e.clientY).map(el => el.closest('[data-act="pickCourt"],[data-act="pickEntry"]')).find(Boolean) || null;
}

$app.addEventListener('click', e => {
  if (swallowClick) { swallowClick = false; e.preventDefault(); e.stopPropagation(); return; }  // the click that ends a drag
  if (adminOn() && !dialog && adminTap(e)) return;
  let b = e.target.closest('[data-act]'); if (!b) return;
  if (b.dataset.act === 'clear') b = underScrim(e) || b;
  const d = b.dataset;
  const map = {
    pickCourt: () => { const c = +d.court; sel = { kind: 'court', court: c, side: resolveSide(S, c, tappedSide(e, b)) }; render(); },
    pickEntry: () => { sel = sel?.kind === 'entry' && sel.id === d.id ? null : { kind: 'entry', id: d.id }; render(); },
    clear: () => { sel = null; render(); },
    do: () => {
      const args = JSON.parse(d.b);
      act(d.k, args, d.k === 'invite' ? `Invite sent to ${nameOf(S, args.userId)}` : undefined);
    },
    out: signOut,
    mode: () => { mode = mode === 'login' ? 'register' : 'login'; authErr = authMsg = ''; render(); },
    admin: () => { adminMode = !adminMode; sel = null; render(); },
    settings: () => { dialog = { kind: 'settings', resetWord: null }; sel = null; render(); $app.querySelector('[data-act="closeSettings"]:not(.scrim)')?.focus(); },
    openInvite: () => openPicker({ kind: 'invite' }),
    leaveTeam: () => act('leaveTeam', {}, 'You left the team'),
    prevInvite: () => cycleInvite(-1, d.act),
    nextInvite: () => cycleInvite(1, d.act),
    acceptInvite: () => act('respond', { id: d.id, accept: true }, 'You’re teammates'),
    declineInvite: () => act('respond', { id: d.id, accept: false }, 'Invite declined'),
    cancelInvite: async () => {
      const picker = dialog;
      if (await act('cancelInvite', { id: d.id }, 'Invite cancelled') && dialog === picker) loadPicker(picker);
    },
    pickPick: async () => {
      const picker = dialog;
      const player = picker?.players?.find(p => p.id === d.user);
      if (!player) return;
      let ok;
      if (picker.kind === 'invite') ok = await act('invite', { userId: d.user }, `Invite sent to ${player.name}`);
      else if (picker.kind === 'swap') ok = await act('swap', { a: picker.user, b: d.user }, `Swapped ${nameOf(S, picker.user)} and ${player.name}`);
      else ok = await act('seat', { court: picker.court, side: picker.side, userId: d.user }, `Moved ${player.name} to Court ${picker.court + 1}`);
      if (ok && dialog === picker) closeDialog();
    },
    swapPick: () => { if (sel?.user) openPicker({ kind: 'swap', user: sel.user }); },
    closePicker: closeDialog,
    resetStart: () => { dialog.resetWord = ''; render(); $app.querySelector('[data-input="resetWord"]')?.focus(); },
    resetCancel: () => { dialog.resetWord = null; render(); },
    resetDo: async () => {
      const settings = dialog;
      if (settings.resetWord?.trim() !== 'CLEAR') return;
      if (await act('reset', { confirm: 'CLEAR' }, 'All courts and queues are cleared') && dialog === settings) closeDialog();
    },
    pairStart: () => { if (sel?.user) { sel = { kind: 'pairWith', user: sel.user }; render(); } },
    closeSettings: closeDialog,
    loser: () => act('loser', { loserBack: b.checked }, b.checked ? 'Losers now rejoin the queue' : 'Losers now leave the court'),
    rmAdmin: () => {
      const self = d.email === S.me.email?.toLowerCase();
      if (confirm(self ? 'Remove your own admin access? You will lose the admin tools.' : `Remove ${d.email} as an admin?`)) act('allow', { email: d.email, add: false }, 'Admin removed');
    },
  };
  map[d.act]?.();
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (drag) { endDrag(); return; }
  if (dialog) { closeDialog(); return; }
  if (!sel) return;
  sel = null; render();
});

// ---- admin drag and drop: pointer events, so it works with a mouse and (after a press and hold) on touch ----
const HOLD_MS = 300;

function dragSource(el) {
  const mem = el.closest('.mem[data-user]');
  if (mem) return { src: { kind: 'player', user: mem.dataset.user }, label: nameOf(S, mem.dataset.user) };
  const team = el.closest('.tag.team[data-entry]');
  if (team) {
    const found = findEntry(S, e => e.id === team.dataset.entry);
    return found ? { src: { kind: 'entry', id: team.dataset.entry }, label: teamName(S, found.entry.members) } : null;
  }
  const tag = el.closest('.tag[data-user]:not(.preview)');
  if (tag) return { src: { kind: 'player', user: tag.dataset.user }, label: nameOf(S, tag.dataset.user) };
  const row = el.closest('.row[data-id]');
  if (row) {
    const found = findEntry(S, e => e.id === row.dataset.id);
    return found ? { src: { kind: 'entry', id: row.dataset.id }, label: teamName(S, found.entry.members) } : null;
  }
  return null;
}

/** What is under the pointer: the bin, a player, a queue row, a queue, or a court half. */
function dropTarget(x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    if (el.closest('.bin')) return { el: el.closest('.bin'), t: { kind: 'bin' } };
    const team = el.closest('.tag.team[data-entry]');
    if (team && team.dataset.entry !== drag?.src.id) return { el: team, t: { kind: 'team', id: team.dataset.entry } };
    const tag = el.closest('.tag[data-user]:not(.preview)');
    if (tag && tag.dataset.user !== drag?.src.user) return { el: tag, t: { kind: 'player', user: tag.dataset.user } };
    const row = el.closest('.row[data-id]');
    if (row && row.dataset.id !== drag?.src.id) return { el: row, t: { kind: 'row', court: +row.closest('.next').dataset.court, id: row.dataset.id } };
    const next = el.closest('.next[data-court]');
    if (next) return { el: next, t: { kind: 'queueEnd', court: +next.dataset.court } };
    const court = el.closest('.court[data-court]');
    if (court) {
      const art = court.querySelector('.art').getBoundingClientRect();
      return { el: court, t: { kind: 'side', court: +court.dataset.court, side: x < art.left + art.width / 2 ? 'a' : 'b' } };
    }
  }
  return null;
}

function startDrag(x = drag?.x, y = drag?.y) {
  if (!drag || drag.active) return;
  clearTimeout(drag.timer);
  if (sel) { sel = null; render(); }
  drag.active = true;
  navigator.vibrate?.(30);
  drag.ghost = Object.assign(document.createElement('div'), { className: 'drag-ghost', textContent: drag.label });
  document.body.append(drag.ghost);
  $app.querySelector('.board')?.classList.add('dragging');
  moveDrag(x, y);
}

function moveDrag(x, y) {
  drag.x = x; drag.y = y;
  drag.ghost.style.transform = `translate(${x}px, ${y}px)`;
  const over = dropTarget(x, y);
  if (drag.over?.el !== over?.el || drag.over?.t.side !== over?.t.side) {
    if (drag.over) { drag.over.el.classList.remove('drop-on'); delete drag.over.el.dataset.drop; }
    if (over) { over.el.classList.add('drop-on'); if (over.t.kind === 'side') over.el.dataset.drop = over.t.side; }
  }
  drag.over = over;
}

function endDrag(drop = false) {
  if (!drag) return;
  const d = drag; drag = null;
  clearTimeout(d.timer);
  if (!d.active) return;
  d.ghost.remove();
  if (d.over) { d.over.el.classList.remove('drop-on'); delete d.over.el.dataset.drop; }
  $app.querySelector('.board')?.classList.remove('dragging');
  swallowClick = true; setTimeout(() => { swallowClick = false; }, 400);
  if (pendingRender) { pendingRender = false; render(); }
  if (!drop) return;
  const a = dropAction(S, d.src, d.over?.t);
  if (a?.error) toast(a.error);
  else if (a) act(a.k, a.b, a.msg);
}

$app.addEventListener('pointerdown', e => {
  if (!adminOn() || dialog || drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const s = dragSource(e.target); if (!s) return;
  const touch = e.pointerType !== 'mouse';
  drag = { ...s, x: e.clientX, y: e.clientY, pointerId: e.pointerId, touch, active: false };
  if (touch) drag.timer = setTimeout(startDrag, HOLD_MS);
});
document.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  if (drag.active) { moveDrag(e.clientX, e.clientY); return; }
  const dist = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
  if (!drag.touch && dist > 5) startDrag(e.clientX, e.clientY);
  else if (drag.touch && dist > 10) endDrag();  // moved before the hold: let the page scroll
});
document.addEventListener('pointerup', e => { if (drag && e.pointerId === drag.pointerId) endDrag(true); });
document.addEventListener('pointercancel', e => { if (drag && e.pointerId === drag.pointerId) endDrag(); });
document.addEventListener('touchmove', e => { if (drag?.active) e.preventDefault(); }, { passive: false });  // no scrolling mid-drag
$app.addEventListener('contextmenu', e => { if (adminOn() && dragSource(e.target)) e.preventDefault(); });

$app.addEventListener('input', e => {
  const k = e.target.dataset.input;
  if (k === 'pickerSearch') {
    dialog.query = e.target.value;
    const q = dialog.query.trim().toLowerCase();
    const picks = [...$app.querySelectorAll('.pick[data-search]')];
    for (const pick of picks) pick.parentElement.hidden = !pick.dataset.search.includes(q);
    const empty = $app.querySelector('[data-empty-picks]');
    if (empty) empty.hidden = picks.some(pick => !pick.parentElement.hidden);
  }
  if (k === 'resetWord') { dialog.resetWord = e.target.value; $app.querySelector('[data-act="resetDo"]')?.setAttribute('aria-disabled', String(dialog.resetWord.trim() !== 'CLEAR')); }
});

$app.addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target, v = Object.fromEntries(new FormData(f));
  if (f.dataset.form === 'allow') { act('allow', { email: String(v.email).trim(), add: true }, 'Admin added'); return; }
  if (f.dataset.form !== 'auth') return;
  authErr = authMsg = '';
  try {
    const email = String(v.email).trim().toLowerCase();
    if (mode === 'login') {
      const { error } = await sb.auth.signInWithPassword({ email, password: v.password });
      if (error) throw error;
    } else {
      const { data, error } = await sb.auth.signUp({ email, password: v.password, options: { data: { name: String(v.name).trim() }, emailRedirectTo: location.origin } });
      if (error) throw error;
      if (!data.session) { authMsg = 'Check your email to confirm your account, then sign in.'; mode = 'login'; }
    }
    await load(true);
  } catch (x) {
    authErr = x.code === 'email_not_confirmed'
      ? 'Confirm your email using the link we sent before signing in.'
      : x.code === 'invalid_credentials'
        ? 'Email or password is incorrect. Check your details and try again.'
        : x.message;
    render();
  }
});

// ---- live updates: Supabase Realtime, plus a slow poll as a safety net ----
let t; const poke = () => { clearTimeout(t); t = setTimeout(() => load(false), 150); };
const ch = sb.channel('queue'); ['entries', 'entry_members', 'invites'].forEach(tb => ch.on('postgres_changes', { event: '*', schema: 'public', table: tb }, poke)); ch.subscribe();
sb.auth.onAuthStateChange(() => { setTimeout(() => load(true), 0); });
setInterval(() => load(false), 6000);
load(true);
