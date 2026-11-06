import { createClient } from '@supabase/supabase-js';
import './style.css';
import { adminButtons, buttonState, courtSlots, dropAction, findEntry, isLive, justCalledUp, myPlace, nameOf, pairAction, queueRows, resolveSide, spotsLabel, teamName, validSelection, waitingLabel } from './logic.js';
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
  switchCourt: ['switch_court', b => ({ p_court: b.court, p_side: b.side ?? null })],
  moveQueue: ['move_queue', b => ({ p_court: b.court })],
  joinTeam: ['join_team', b => ({ p_entry: b.entryId })],
  win: ['report_win', b => ({ p_court: b.court, p_side: b.side })],
  // admin
  place: ['admin_place', b => ({ p_court: b.court, p_side: b.side, p_entry: b.entryId ?? null, p_user: b.userId ?? null })],
  queue: ['admin_queue', b => ({ p_queue_court: b.court, p_before: b.before ?? null, p_entry: b.entryId ?? null, p_user: b.userId ?? null })],
  swap: ['admin_swap', b => ({ p_a: b.a, p_b: b.b })],
  kick: ['admin_kick', b => ({ p_user: b.userId })],
  removePair: ['admin_remove_pair', b => ({ p_entry: b.entryId })],
  pair: ['admin_pair', b => ({ p_user: b.userId, p_target: b.targetId })],
  split: ['admin_split', b => ({ p_user: b.userId })],
  allow: ['admin_allow', b => ({ p_email: b.email, p_add: b.add })],
  loser: ['admin_set_loser_back', b => ({ p_loser_back: b.loserBack })],
};
const api = async (k, b = {}) => { const [fn, m] = RPC[k]; const { data, error } = await sb.rpc(fn, m(b)); if (error) throw new Error(error.message); return data; };

let S = null, mode = 'login', authErr = '', authMsg = '', booted = false, busy = false;
let sel = null;          // {kind:'court', court, side} | {kind:'entry', id} | null
let place;               // where I was at the last load (undefined until the first load)
let calledUp = null;     // court number for the "you're up" screen, or null
let movedMyself = false; // set after my own action, so stepping onto a court myself is not announced as "you're up"
let adminMode = false, settingsOpen = false;
let drag = null;          // admin drag in progress: {src, label, x, y, pointerId, touch, timer, active, ghost, over}
let swallowClick = false; // true right after a drop, so the click that follows doesn't also select something
const adminOn = () => adminMode && !!S?.me?.isAdmin;

let toastT; const toast = m => { const t = document.getElementById('toast'); t.textContent = m; t.className = 'show'; clearTimeout(toastT); toastT = setTimeout(() => t.className = '', 3500); };

async function load(force) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) S = null;
  else { try { S = await api('state'); } catch (e) { toast(e.message); } }
  if (S?.me) {
    const now = myPlace(S);
    if (justCalledUp(place, now) && !movedMyself) { calledUp = now.court; sel = null; navigator.vibrate?.([200, 100, 200]); }
    place = now; movedMyself = false;
    sel = validSelection(S, sel);
  }
  booted = true;
  if (force || !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '')) render();
}
async function act(k, b, done) {
  if (busy) return; busy = true;
  let ok = false;
  try { await api(k, b); sel = null; movedMyself = true; ok = true; } catch (e) { toast(e.message); } finally { busy = false; }
  await load(true);
  if (ok && done) toast(done);
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
  const previewSide = preview?.court === c ? preview.side : null;
  const picked = sel?.kind === 'court' && sel.court === c;
  const rows = queueRows(S, c);
  const list = rows.length ? `<div class="queue" data-scroll="${c}" tabindex="0" aria-label="Court ${c + 1} queue">${rows.map(r => {
    const on = sel?.kind === 'entry' && sel.id === r.id;
    return `<button type="button" class="row${on ? ' sel' : ''}" data-act="pickEntry" data-id="${esc(r.id)}" aria-pressed="${on}"><span class="n">${r.n}</span><span>${adminOn() ? r.members.map(id => `<span class="mem" data-user="${esc(id)}">${esc(nameOf(S, id))}</span>`).join(' &amp; ') : esc(r.names)}</span></button>`;
  }).join('')}</div>` : '';
  return `<section class="court-col">
    <button type="button" class="court${picked ? ' sel' : ''}" data-act="pickCourt" data-court="${c}" aria-pressed="${picked}" aria-label="${esc(courtLabel(c, slots))}">
      <span class="court-head"><span class="title">Court ${c + 1}${S.courtModes?.[c] === 'singles' ? ' <small>Singles</small>' : ''}</span>${spots ? `<span class="spots">${spots}</span>` : ''}</span>
      ${courtArt(slots, id => nameOf(S, id), isLive(court), S.me.id, previewSide)}
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

function upView() {
  if (calledUp === null) return '';
  return `<button type="button" class="up" data-act="closeUp" aria-label="You're up on Court ${calledUp + 1}. Tap to close.">
    <span class="up-title">You’re up,<br>baddie!</span><span class="up-court">Court ${calledUp + 1}</span></button>`;
}

function adminStrip() {
  if (!adminOn()) return '';
  return `<div class="admin-strip"><p><b>Admin mode.</b> Drag players onto a side, onto someone to swap, into a queue, or to the bin (on a phone, press and hold first). Tap a player to team them up, split them, or remove them.</p>
    <button type="button" class="chip-btn" data-act="settings">Settings</button></div>`;
}

function settingsView() {
  if (!settingsOpen || !adminOn()) return '';
  const admins = S.admins?.list ?? [];
  return `<div class="sheet-wrap"><button type="button" class="scrim" data-act="closeSettings" aria-label="Close settings"></button>
    <section class="panel sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div class="sheet-head"><h2 id="settings-title">Settings</h2><button type="button" class="chip-btn" data-act="closeSettings">Done</button></div>
      <label class="switch"><input type="checkbox" data-act="loser"${S.loserBack ? ' checked' : ''}>
        <span><b>Losers rejoin the queue</b><span class="mute">When off, the losing team leaves the court and has to sign up again.</span></span></label>
      <div class="admins"><h3>Admins</h3><p class="mute">Confirmed accounts with these emails get the admin tools.</p>
        <ul>${admins.map(m => `<li><span>${esc(m)}</span><button type="button" class="link" data-act="rmAdmin" data-email="${esc(m)}" aria-label="Remove ${esc(m)} as admin">Remove</button></li>`).join('')}</ul>
        <form data-form="allow" class="add"><input type="email" name="email" placeholder="name@ucsc.edu" required aria-label="New admin email"><button class="cta">Add</button></form></div>
    </section></div>`;
}

function mainView() {
  const adm = adminOn(), picking = adm && (sel?.kind === 'player' || sel?.kind === 'pairWith');
  const st = picking ? adminButtons(S, sel) : buttonState(S, sel), dim = sel && !picking;
  const adminBtn = S.me.isAdmin ? `<button type="button" class="signout${adm ? ' on' : ''}" data-act="admin" aria-pressed="${adm}">Admin</button>` : '';
  return `<div class="board${dim ? ' has-sel' : ''}${adm ? ' admin' : ''}${sel?.kind === 'pairWith' ? ' pairing' : ''}"><header class="top">${WORDMARK}<div class="top-actions">${adminBtn}<button type="button" class="signout" data-act="out">Sign out</button></div></header>
    ${adminStrip()}
    <div class="courts">${S.courts.map((court, c) => courtBlock(court, c, st?.preview)).join('')}</div>
    ${dim ? '<button type="button" class="scrim" data-act="clear" aria-label="Close selection"></button>' : ''}
    ${actionBar(st)}${adm ? '<div class="bin" aria-hidden="true">Drop here to remove</div>' : ''}</div>${settingsView()}${upView()}`;
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

let pendingRender = false;
function render() {
  if (!booted) return;
  if (drag?.active) { pendingRender = true; return; }  // never rebuild the board under a drag
  const scrolls = [...$app.querySelectorAll('[data-scroll]')].map(el => [el.dataset.scroll, el.scrollTop]);
  $app.innerHTML = S && S.me ? mainView() : authView();
  for (const [k, top] of scrolls) { const el = $app.querySelector(`[data-scroll="${k}"]`); if (el) el.scrollTop = top; }
  if (sel?.user) $app.querySelectorAll(`[data-user="${CSS.escape(sel.user)}"]`).forEach(el => el.classList.add('picked'));
}

// ---- events ----
/** A tap on the dimmed scrim selects the court or queue row under it, so switching takes one tap. */
/** Admin mode: tapping a player (on court, or a name in line) selects them; while pairing, it picks the partner. */
function adminTap(e) {
  if (e.target.closest('.bar, .admin-strip, .top')) return false;
  let user = e.target.closest('.tag[data-user]:not(.preview), .mem[data-user]')?.dataset.user;
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
  if (adminOn() && !settingsOpen && adminTap(e)) return;
  let b = e.target.closest('[data-act]'); if (!b) return;
  if (b.dataset.act === 'clear') b = underScrim(e) || b;
  const d = b.dataset;
  const map = {
    pickCourt: () => { const c = +d.court; sel = { kind: 'court', court: c, side: resolveSide(S, c, tappedSide(e, b)) }; render(); },
    pickEntry: () => { sel = sel?.kind === 'entry' && sel.id === d.id ? null : { kind: 'entry', id: d.id }; render(); },
    clear: () => { sel = null; render(); },
    do: () => act(d.k, JSON.parse(d.b)),
    closeUp: () => { calledUp = null; render(); },
    out: async () => { await sb.auth.signOut(); S = null; sel = null; place = undefined; calledUp = null; adminMode = settingsOpen = false; render(); },
    mode: () => { mode = mode === 'login' ? 'register' : 'login'; authErr = authMsg = ''; render(); },
    admin: () => { adminMode = !adminMode; settingsOpen = false; sel = null; render(); },
    settings: () => { settingsOpen = true; sel = null; render(); },
    pairStart: () => { if (sel?.user) { sel = { kind: 'pairWith', user: sel.user }; render(); } },
    closeSettings: () => { settingsOpen = false; render(); },
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
  if (!sel && calledUp === null && !settingsOpen) return;
  sel = null; calledUp = null; settingsOpen = false; render();
});

// ---- admin drag and drop: pointer events, so it works with a mouse and (after a press and hold) on touch ----
const HOLD_MS = 300;

function dragSource(el) {
  const tag = el.closest('.tag[data-user]:not(.preview), .mem[data-user]');
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
  if (!adminOn() || settingsOpen || drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
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
sb.auth.onAuthStateChange(() => load(true));
setInterval(() => load(false), 6000);
load(true);
