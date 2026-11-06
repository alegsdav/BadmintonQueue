import { createClient } from '@supabase/supabase-js';
import './style.css';
import { buttonState, courtSlots, isLive, justCalledUp, myPlace, nameOf, queueRows, resolveSide, spotsLabel, validSelection, waitingLabel } from './logic.js';
import { courtArt, esc, racket } from './pixel.js';

const URL = import.meta.env.VITE_SUPABASE_URL, KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const $app = document.getElementById('app');
if (!URL || !KEY) {
  $app.innerHTML = '<main class="auth"><div class="panel"><h1>Almost there</h1><p class="mute">Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to <code>.env.local</code> (or Vercel’s environment variables), then restart.</p></div></main>';
  throw new Error('Missing Supabase env vars');
}
const sb = createClient(URL, KEY);

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
};
const api = async (k, b = {}) => { const [fn, m] = RPC[k]; const { data, error } = await sb.rpc(fn, m(b)); if (error) throw new Error(error.message); return data; };

let S = null, mode = 'login', authErr = '', authMsg = '', booted = false, busy = false;
let sel = null;          // {kind:'court', court, side} | {kind:'entry', id} | null
let place;               // where I was at the last load (undefined until the first load)
let calledUp = null;     // court number for the "you're up" screen, or null
let movedMyself = false; // set after my own action, so stepping onto a court myself is not announced as "you're up"

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
async function act(k, b) {
  if (busy) return; busy = true;
  try { await api(k, b); sel = null; movedMyself = true; } catch (e) { toast(e.message); } finally { busy = false; }
  await load(true);
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
    return `<button type="button" class="row${on ? ' sel' : ''}" data-act="pickEntry" data-id="${esc(r.id)}" aria-pressed="${on}"><span class="n">${r.n}</span><span>${esc(r.names)}</span></button>`;
  }).join('')}</div>` : '';
  return `<section class="court-col">
    <button type="button" class="court${picked ? ' sel' : ''}" data-act="pickCourt" data-court="${c}" aria-pressed="${picked}" aria-label="${esc(courtLabel(c, slots))}">
      <span class="court-head"><span class="title">Court ${c + 1}${S.courtModes?.[c] === 'singles' ? ' <small>Singles</small>' : ''}</span>${spots ? `<span class="spots">${spots}</span>` : ''}</span>
      ${courtArt(slots, id => nameOf(S, id), isLive(court), S.me.id, previewSide)}
    </button>
    <div class="next"><div class="next-head"><span>Up next</span><span class="mute">${waitingLabel(S, c)}</span></div>${list}</div>
  </section>`;
}

function actionBar(st) {
  if (!st) return '';
  const button = btn => {
    const a = btn.action ? ` data-act="do" data-k="${btn.action.k}" data-b="${esc(JSON.stringify(btn.action.b))}"` : '';
    return `<button type="button" class="cta${btn.secondary ? ' alt' : ''}"${a} aria-disabled="${btn.disabled}">${esc(btn.label)}</button>`;
  };
  return `<div class="bar${st.buttons.length > 1 ? ' stack' : ''}">${st.buttons.map(button).join('')}</div>`;
}

function upView() {
  if (calledUp === null) return '';
  return `<button type="button" class="up" data-act="closeUp" aria-label="You're up on Court ${calledUp + 1}. Tap to close.">
    <span class="up-title">You’re up,<br>baddie!</span><span class="up-court">Court ${calledUp + 1}</span></button>`;
}

function mainView() {
  const st = buttonState(S, sel);
  return `<div class="board${sel ? ' has-sel' : ''}"><header class="top">${WORDMARK}<button type="button" class="signout" data-act="out">Sign out</button></header>
    <div class="courts">${S.courts.map((court, c) => courtBlock(court, c, st?.preview)).join('')}</div>
    ${sel ? '<button type="button" class="scrim" data-act="clear" aria-label="Close selection"></button>' : ''}
    ${actionBar(st)}</div>${upView()}`;
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
  const scrolls = [...$app.querySelectorAll('[data-scroll]')].map(el => [el.dataset.scroll, el.scrollTop]);
  $app.innerHTML = S && S.me ? mainView() : authView();
  for (const [k, top] of scrolls) { const el = $app.querySelector(`[data-scroll="${k}"]`); if (el) el.scrollTop = top; }
}

// ---- events ----
/** A tap on the dimmed scrim selects the court or queue row under it, so switching takes one tap. */
function underScrim(e) {
  return document.elementsFromPoint(e.clientX, e.clientY).map(el => el.closest('[data-act="pickCourt"],[data-act="pickEntry"]')).find(Boolean) || null;
}

$app.addEventListener('click', e => {
  let b = e.target.closest('[data-act]'); if (!b) return;
  if (b.dataset.act === 'clear') b = underScrim(e) || b;
  const d = b.dataset;
  const map = {
    pickCourt: () => { const c = +d.court; sel = { kind: 'court', court: c, side: resolveSide(S, c, tappedSide(e, b)) }; render(); },
    pickEntry: () => { sel = sel?.kind === 'entry' && sel.id === d.id ? null : { kind: 'entry', id: d.id }; render(); },
    clear: () => { sel = null; render(); },
    do: () => act(d.k, JSON.parse(d.b)),
    closeUp: () => { calledUp = null; render(); },
    out: async () => { await sb.auth.signOut(); S = null; sel = null; place = undefined; calledUp = null; render(); },
    mode: () => { mode = mode === 'login' ? 'register' : 'login'; authErr = authMsg = ''; render(); },
  };
  map[d.act]?.();
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || (!sel && calledUp === null)) return;
  sel = null; calledUp = null; render();
});
$app.addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target, v = Object.fromEntries(new FormData(f));
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
