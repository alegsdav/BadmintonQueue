import { createClient } from '@supabase/supabase-js';
import './style.css';

const URL = import.meta.env.VITE_SUPABASE_URL, KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const $app = document.getElementById('app');
if (!URL || !KEY) {
  $app.innerHTML = '<div class="wrap"><div class="card"><h2>Almost there</h2><p>Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to <code>.env.local</code> (or Vercel’s environment variables), then restart.</p></div></div>';
  throw new Error('Missing Supabase env vars');
}
const sb = createClient(URL, KEY);

// ---- data layer: every change is a Postgres function (see supabase/schema.sql) ----
const RPC = {
  state: ['get_state', () => ({})], join: ['join_queue', () => ({})], joinCourt: ['join_court', b => ({ p_court: b.court, p_side: b.side })],
  queueToCourt: ['queue_to_court', b => ({ p_court: b.court, p_side: b.side })], leave: ['leave_queue', () => ({})],
  leavePair: ['leave_pair', () => ({})], removePair: ['admin_remove_pair', b => ({ p_entry: b.entryId })],
  invite: ['send_invite', b => ({ p_email: b.email ?? null, p_user: b.userId ?? null, p_court: b.court ?? null, p_side: b.side ?? null })],
  respond: ['respond_invite', b => ({ p_id: b.id, p_accept: b.accept })], cancel: ['cancel_invite', b => ({ p_id: b.id })],
  win: ['report_win', b => ({ p_court: b.court, p_side: b.side })], kick: ['admin_kick', b => ({ p_user: b.userId })],
  move: ['admin_move', b => ({ p_entry: b.entryId, p_dest: b.dest })], allow: ['admin_allow', b => ({ p_email: b.email, p_add: b.add })],
  loser: ['admin_set_loser_back', b => ({ p_loser_back: b.loserBack })],
};
const api = async (k, b = {}) => { const [fn, m] = RPC[k]; const { data, error } = await sb.rpc(fn, m(b)); if (error) throw new Error(error.message); return data; };

let S = null, tab = 'play', mode = 'login', authErr = '', authMsg = '', adm = false, booted = false;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const N = id => S.names[id] || 'Player';
const ini = n => n.trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
const hue = id => ([...id].reduce((a, c) => a + c.charCodeAt(0), 0) * 47) % 360;
const isMine = e => e.members.includes(S.me.id);
let toastT; const toast = m => { const t = document.getElementById('toast'); t.textContent = m; t.className = 'show'; clearTimeout(toastT); toastT = setTimeout(() => t.className = '', 3500); };

async function load(force) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) S = null; else { try { S = await api('state'); } catch (e) { toast(e.message); } }
  booted = true;
  if (force || !/INPUT|SELECT/.test(document.activeElement?.tagName || '')) render();
}
async function act(k, b) { let ok = true; try { await api(k, b); } catch (e) { ok = false; toast(e.message); } await load(true); return ok; }

// ---- views ----
const SHUTTLE = '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="16" cy="25.5" r="4.5" fill="currentColor"/><path d="M11.5 22 7 6M16 21V4M20.5 22 25 6M7 6q9-4 18 0"/></svg>';
const COURT = '<svg class="lines" viewBox="0 0 134 61" preserveAspectRatio="none" aria-hidden="true"><g fill="none" stroke="currentColor"><rect x=".5" y=".5" width="133" height="60"/><path d="M47.2 0V61M86.8 0V61M7.6 0V61M126.4 0V61M0 4.6H134M0 56.4H134M0 30.5H47.2M86.8 30.5H134"/></g><path class="net" d="M67 0V61" stroke="currentColor"/></svg>';

function authView() {
  const reg = mode === 'register';
  return `<main class="auth"><div class="court">${COURT}</div><div class="panel">
    <div class="brand">${SHUTTLE}Courtside</div>
    <h1>${reg ? 'Join the club' : 'Next up on court'}</h1>
    <p class="mute" style="margin:0">${reg ? 'Create an account to claim a spot in the queue.' : 'Sign in to see the courts and your place in line.'}</p>
    <form data-form="auth">${reg ? '<input type="text" name="name" placeholder="Your name" autocomplete="name" required maxlength="40">' : ''}
      <input type="email" name="email" placeholder="Email" autocomplete="email" required>
      <input type="password" name="password" placeholder="Password (8+ characters)" autocomplete="${reg ? 'new-password' : 'current-password'}" required minlength="8">
      <button class="btn primary">${reg ? 'Create account' : 'Sign in'}</button></form>
    <div class="err">${esc(authErr)}</div><div class="mute">${esc(authMsg)}</div>
    <a data-act="mode">${reg ? 'Already have an account? Sign in' : 'New here? Create an account'}</a></div></main>`;
}

const chip = id => `<span class="chip${id === S.me.id ? ' me' : ''}"><i class="av" style="--h:${hue(id)}">${esc(ini(N(id)))}</i><b>${esc(N(id))}</b>${adm ? `<button class="x" data-act="kick" data-id="${id}" data-name="${esc(N(id))}" aria-label="Remove ${esc(N(id))}">×</button>` : ''}</span>`;
function moveSel(e, cur) {
  const o = S.courts.map((_, i) => i !== cur ? `<option value="c${i}">Court ${i + 1}</option>` : '').join('');
  return `<select data-move="${e.id}" aria-label="Move"><option value="">Move to…</option>${o}<option value="q-front">Front of queue</option>${cur >= 0 ? '<option value="q-end">End of queue</option>' : ''}</select>`;
}
function entry(e, cur) {
  const removePair = adm && e.members.length > 1
    ? `<button class="btn sm danger" data-act="removePair" data-id="${e.id}">Remove pair</button>` : '';
  return `<div class="entry${e.members.length > 1 ? ' pair' : ''}">${e.members.map(chip).join('')}${adm ? moveSel(e, cur) : ''}${removePair}</div>`;
}
const half = (list, i) => list.map(e => entry(e, i)).join('') +
  (list.reduce((n, e) => n + e.members.length, 0) < 2 ? '<span class="ghost">Open spot</span>' : '');

function courtCard(c, i) {
  const live = c.a.length && c.b.length, on = [...c.a, ...c.b].some(isMine);
  return `<article class="card court-card"><header><h3>Court ${i + 1}</h3><span class="state${live ? ' live' : ''}">${live ? 'Game on' : (c.a.length || c.b.length) ? 'Waiting for opponents' : 'Open'}</span></header>
  <div class="court">${COURT}<div class="half">${half(c.a, i)}</div><div class="half">${half(c.b, i)}</div></div>
  ${live && (on || adm) ? `<div class="win"><button class="btn" data-act="win" data-court="${i}" data-side="a">Left side won</button><button class="btn" data-act="win" data-court="${i}" data-side="b">Right side won</button></div>` : ''}</article>`;
}

function invitePlacement() {
  return `<select name="court" aria-label="Choose a court" required><option value="">Choose court…</option>${S.courts.map((_, i) => `<option value="${i}">Court ${i + 1}</option>`).join('')}</select>
    <select name="side" aria-label="Choose a side" required><option value="">Choose side…</option><option value="a">Left side</option><option value="b">Right side</option></select>`;
}

function openCourtSides(entry) {
  if (!entry || S.queue[0]?.id !== entry.id) return [];
  const size = entry.members.length;
  return S.courts.flatMap((court, i) => ['a', 'b'].flatMap(side => {
    const players = court[side].reduce((count, item) => count + item.members.length, 0);
    const room = 2 - players;
    return room >= size ? [{ value: `${i}:${side}`, label: `Court ${i + 1} · ${side === 'a' ? 'Left' : 'Right'} side (${room} open)` }] : [];
  }));
}

function statusCard(me, loc) {
  const inc = S.invites.filter(i => i.to === S.me.id), out = S.invites.filter(i => i.from === S.me.id);
  const waitingPlayers = S.queue.filter(e => e.members.length === 1 && e.members[0] !== S.me.id);
  const paired = me && me.members.length > 1, mate = paired ? me.members.filter(m => m !== S.me.id).map(N).join(', ') : '';
  const pos = S.queue.findIndex(isMine) + 1;
  const openSides = loc === 'queue' ? openCourtSides(me) : [];
  const head = !loc ? ['Ready to play?', 'Join the queue on your own, or invite a partner by email.']
    : loc === 'court' ? ['You’re on court ' + (S.courts.findIndex(c => [...c.a, ...c.b].some(isMine)) + 1), paired ? `Playing with ${mate}.` : 'Good luck out there.']
    : [pos === 1 ? 'You’re next up' : `You’re number ${pos} in line`, paired ? `Queued with ${mate}.` : openSides.length ? 'Choose an open court side to rejoin, or stay in line.' : 'You’ll be moved onto a court as soon as one opens.'];
  const inviteFields = invitePlacement();
  return `<section class="card status"><div><h2>${esc(head[0])}</h2><p class="mute" style="margin:4px 0 0">${esc(head[1])}</p></div>
    <div class="row">${!loc ? `<form data-form="join"><select name="court" aria-label="Choose a court"><option value="">Any available court</option>${S.courts.map((_, i) => `<option value="${i}">Court ${i + 1}</option>`).join('')}</select><select name="side" aria-label="Choose a side"><option value="">Choose side…</option><option value="a">Left side</option><option value="b">Right side</option></select><button class="btn primary">Join court</button></form>` : `<button class="btn danger" data-act="leave">${loc === 'court' ? 'Leave court' : 'Leave queue'}</button>`}
    ${paired ? '<button class="btn danger" data-act="leavePair">Leave with partner</button>' : ''}
    ${openSides.length ? `<form data-form="queue-to-court"><label class="sr-only" for="rejoin-spot">Choose an open court side</label><select id="rejoin-spot" name="spot" required><option value="">Choose open court…</option>${openSides.map(o => `<option value="${o.value}">${esc(o.label)}</option>`).join('')}</select><button class="btn primary">Join open court${paired ? ' with partner' : ''}</button></form>` : ''}
    ${loc !== 'court' && !paired && waitingPlayers.length ? `<form data-form="player-invite"><select name="userId" aria-label="Choose a player to pair with" required><option value="">Choose a waiting player…</option>${waitingPlayers.map(e => `<option value="${esc(e.members[0])}">${esc(N(e.members[0]))}</option>`).join('')}</select>${inviteFields}<button class="btn">Invite to court</button></form>` : ''}
    ${loc !== 'court' && !paired ? `<form data-form="invite"><input type="email" name="email" placeholder="Partner’s account email" required>${inviteFields}<button class="btn">Invite to court</button></form>` : ''}</div>
    ${inc.map(i => `<div class="invite"><span><b>${esc(N(i.from))}</b> invites you to join ${i.court === null ? 'as a pair in the queue' : `Court ${Number(i.court) + 1}, ${i.side === 'a' ? 'left' : 'right'} side`}.</span><span class="row"><button class="btn primary sm" data-act="accept" data-id="${i.id}">Accept</button><button class="btn sm" data-act="decline" data-id="${i.id}">Decline</button></span></div>`).join('')}
    ${out.map(i => `<div class="invite"><span class="mute">Waiting for ${esc(N(i.to))} to accept${i.court === null ? '' : ` your Court ${Number(i.court) + 1}, ${i.side === 'a' ? 'left' : 'right'} side invite`}</span><button class="btn sm" data-act="cancel" data-id="${i.id}">Cancel</button></div>`).join('')}</section>`;
}

function adminCards() {
  return `<section class="card"><label class="switch"><input type="checkbox" id="lb" ${S.loserBack ? 'checked' : ''}><span><b>Losers rejoin the queue</b><br><span class="mute">When off, the losing side leaves the court and must sign up again.</span></span></label></section>
  <section class="card"><h3>Admin emails</h3><p class="mute" style="margin:4px 0 12px">Only confirmed accounts with these emails get admin access.</p>
    <div class="tags">${S.admins.list.map(m => `<span class="tag">${esc(m)}<button class="x" data-act="rmadmin" data-email="${esc(m)}" aria-label="Remove ${esc(m)}">×</button></span>`).join('')}</div>
    <form data-form="allow" class="row" style="margin-top:12px"><input type="email" name="email" placeholder="admin@example.com" required><button class="btn">Add admin</button></form></section>`;
}

function mainView() {
  adm = S.me.isAdmin && tab === 'admin';
  const all = [...S.queue, ...S.courts.flatMap(c => [...c.a, ...c.b])], me = all.find(isMine);
  const loc = !me ? null : S.queue.includes(me) ? 'queue' : 'court';
  const waiting = S.queue.reduce((n, e) => n + e.members.length, 0);
  return `<div class="wrap"><header class="top"><div class="brand">${SHUTTLE}Courtside</div><div class="who">
    ${S.me.isAdmin ? `<div class="tabs"><button data-act="tab" data-tab="play" aria-pressed="${tab === 'play'}">Play</button><button data-act="tab" data-tab="admin" aria-pressed="${tab === 'admin'}">Admin</button></div>` : ''}
    <span class="chip"><i class="av" style="--h:${hue(S.me.id)}">${esc(ini(S.me.name))}</i><b>${esc(S.me.name)}</b></span><button class="btn sm" data-act="out">Sign out</button></div></header>
    ${adm ? '' : statusCard(me, loc)}
    <div class="courts">${S.courts.map((c, i) => courtCard(c, i)).join('')}</div>
    <section class="card"><h2>Waiting queue</h2><p class="mute" style="margin:4px 0 0">${waiting} ${waiting === 1 ? 'player' : 'players'} waiting. Pairs move up together; singles are matched in order.</p>
      ${S.queue.length ? `<ol class="queue">${S.queue.map((e, i) => `<li><span class="pos">${i + 1}</span>${entry(e, -1)}</li>`).join('')}</ol>` : '<div class="empty">Nobody’s waiting. Join to get on court.</div>'}</section>
    ${adm ? adminCards() : ''}</div>`;
}

function render() { if (!booted) return; $app.innerHTML = S && S.me ? mainView() : authView(); }

// ---- events ----
$app.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return; const d = b.dataset;
  const map = { join: () => act('join'), leave: () => act('leave'), leavePair: () => confirm('Leave your spot with your partner?') && act('leavePair'),
    removePair: () => confirm('Remove both players in this pair from their spot?') && act('removePair', { entryId: d.id }),
    accept: () => act('respond', { id: d.id, accept: true }),
    decline: () => act('respond', { id: d.id, accept: false }), cancel: () => act('cancel', { id: d.id }), win: () => act('win', { court: +d.court, side: d.side }),
    kick: () => confirm(`Remove ${d.name} from their spot?`) && act('kick', { userId: d.id }), rmadmin: () => act('allow', { email: d.email, add: false }),
    tab: () => { tab = d.tab; render(); }, mode: () => { mode = mode === 'login' ? 'register' : 'login'; authErr = authMsg = ''; render(); },
    out: async () => { await sb.auth.signOut(); S = null; render(); } };
  map[d.act]?.();
});
$app.addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.move && t.value) act('move', { entryId: t.dataset.move, dest: t.value });
  if (t.id === 'lb') {
    const value = t.checked;
    t.disabled = true;
    if (await act('loser', { loserBack: value })) toast('Setting saved');
    else if (t.isConnected) t.checked = !value;
    if (t.isConnected) t.disabled = false;
  }
});
$app.addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target, v = Object.fromEntries(new FormData(f));
  if (f.dataset.form === 'join') {
    if (v.court === '') await act('join');
    else if (v.side) await act('joinCourt', { court: Number(v.court), side: v.side });
    else toast('Choose a side on the selected court.');
  }
  if (f.dataset.form === 'queue-to-court') {
    const [court, side] = v.spot.split(':');
    if (court !== undefined && side) await act('queueToCourt', { court: Number(court), side });
  }
  if (f.dataset.form === 'player-invite') {
    if (v.court !== '' && v.side && await act('invite', { userId: v.userId, court: Number(v.court), side: v.side })) toast('Invite sent');
    else if (v.court === '' || !v.side) toast('Choose a court and side for the invite.');
  }
  if (f.dataset.form === 'invite') {
    if (v.court !== '' && v.side && await act('invite', { email: v.email, court: Number(v.court), side: v.side })) toast('Invite sent');
    else if (v.court === '' || !v.side) toast('Choose a court and side for the invite.');
  }
  if (f.dataset.form === 'allow') act('allow', { email: v.email, add: true });
  if (f.dataset.form === 'auth') {
    authErr = authMsg = '';
    try {
      const email = String(v.email).trim().toLowerCase();
      if (mode === 'login') {
        const { error } = await sb.auth.signInWithPassword({ email, password: v.password });
        if (error) throw error;
      }
      else {
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
  }
});

// ---- live updates: Supabase Realtime, plus a slow poll as a safety net ----
let t; const poke = () => { clearTimeout(t); t = setTimeout(() => load(false), 150); };
const ch = sb.channel('queue'); ['entries', 'entry_members', 'invites'].forEach(tb => ch.on('postgres_changes', { event: '*', schema: 'public', table: tb }, poke)); ch.subscribe();
sb.auth.onAuthStateChange(() => load(true));
setInterval(() => load(false), 6000);
load(true);
