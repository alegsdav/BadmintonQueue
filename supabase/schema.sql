-- Slugminton database: snapshot of the live Supabase project (public schema), taken 2026-11-06.
-- Rebuilds a fresh project from scratch: run in Supabase -> SQL Editor, then run supabase/migrations/* in filename order.
-- Clients can only READ via RLS; every change goes through the SECURITY DEFINER functions below.
-- Keep this file in step with the live project: when you change a function in the dashboard, add a migration here too.

-- ---------- tables ----------
create table profiles (
  id uuid primary key references auth.users on delete cascade,
  email text not null,
  name text not null);
create table admin_emails (email text primary key);
create table settings (
  id int primary key default 1 check (id = 1),
  courts_count int not null default 2,
  loser_back boolean not null default false,
  singles_courts int[] not null default '{}',   -- court indexes (0 = Court 1) that play singles
  win_cap int not null default 3);              -- a team comes off after this many straight matches
insert into settings default values;

create sequence entry_seq;
-- An entry is one player or a pair. court IS NULL means waiting in queue_court's queue (ordered by seq);
-- queue_court IS NULL is a legacy entry that waits for any court.
create table entries (
  id uuid primary key default gen_random_uuid(),
  court int,
  side text check (side in ('a','b')),
  seq bigint not null default nextval('entry_seq'),
  queue_court int,
  streak int not null default 0,                -- straight matches played on the current court
  spot_owner uuid,                              -- partner whose place in line the pair kept
  check ((court is null) = (side is null)));
create table entry_members (
  user_id uuid primary key references profiles(id) on delete cascade,  -- one place per player
  entry_id uuid not null references entries(id) on delete cascade,
  joined timestamptz not null default clock_timestamp());
create table invites (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null references profiles(id) on delete cascade,
  to_user uuid not null references profiles(id) on delete cascade,
  court int,
  side text check (side in ('a','b')),
  unique (from_user, to_user),
  check (from_user <> to_user),
  constraint invites_court_side_check check ((court is null) = (side is null)));

-- ---------- helpers ----------
create function is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from auth.users u join admin_emails a on lower(a.email) = lower(u.email)
                 where u.id = auth.uid() and u.email_confirmed_at is not null) $$;
create function need_user() returns uuid language plpgsql stable as $$
begin if auth.uid() is null then raise exception 'Please sign in.'; end if; return auth.uid(); end $$;
create function need_admin() returns void language plpgsql stable security definer set search_path = public as $$
begin if not is_admin() then raise exception 'Admins only.'; end if; end $$;
create function lock_q() returns void language sql as $$ select pg_advisory_xact_lock(727272) $$;
create function entry_size(e uuid) returns int language sql stable as $$ select count(*)::int from entry_members where entry_id = e $$;
create function side_count(c int, s text) returns int language sql stable as $$
  select count(*)::int from entry_members m join entries e on e.id = m.entry_id where e.court = c and e.side = s $$;
create function court_cap(c int) returns int language sql stable set search_path = public as $$
  select case when c is not null and c = any(s.singles_courts) then 1 else 2 end from settings s where s.id = 1 $$;

-- Promote from each court's queue into its open spots (first entry that fits wins)
create function fill_courts() returns void language plpgsql as $$
declare n int; c int; s text; room int; eid uuid;
begin
  select courts_count into n from settings;
  for c in 0..n-1 loop
    foreach s in array array['a','b'] loop
      loop
        room := court_cap(c) - side_count(c, s); exit when room <= 0;
        select e.id into eid from entries e
          where e.court is null and (e.queue_court = c or e.queue_court is null) and entry_size(e.id) <= room
          order by e.seq limit 1;
        exit when eid is null;
        update entries set court = c, side = s, queue_court = c, streak = 0 where id = eid;
      end loop;
    end loop;
  end loop;
end $$;
create function settle() returns void language plpgsql as $$
begin delete from entries e where not exists (select 1 from entry_members m where m.entry_id = e.id); perform fill_courts(); end $$;

-- When one partner leaves a waiting pair: if the partner who owned the spot left, the one who stays goes to the end.
create function entry_member_left() returns trigger language plpgsql security definer set search_path = public as $$
declare e entries; rest uuid;
begin
  select * into e from entries where id = old.entry_id;
  if e.id is null or e.court is not null then return null; end if;
  select user_id into rest from entry_members where entry_id = old.entry_id limit 1;
  if rest is null then return null; end if;
  if e.spot_owner is not null and e.spot_owner <> rest then
    update entries set seq = nextval('entry_seq'), spot_owner = null where id = old.entry_id;
  else
    update entries set spot_owner = null where id = old.entry_id;
  end if;
  return null;
end $$;
create trigger entry_member_left after delete on entry_members for each row execute function entry_member_left();

-- New auth user -> profile
create function handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, name) values (new.id, lower(new.email),
    left(coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''), split_part(new.email, '@', 1)), 40));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

-- ---------- player actions ----------
create function join_queue(p_court int default null) returns void language plpgsql security definer set search_path = public as $$
declare u uuid := need_user(); eid uuid; n int;
begin
  perform lock_q();
  if exists (select 1 from entry_members where user_id = u) then raise exception 'You are already signed up.'; end if;
  if p_court is not null then
    select courts_count into n from settings;
    if p_court < 0 or p_court >= n then raise exception 'No such court.'; end if;
  end if;
  insert into entries (queue_court) values (p_court) returning id into eid;
  insert into entry_members (user_id, entry_id) values (u, eid);
  perform settle();
end $$;

create function join_court(p_court int, p_side text) returns void language plpgsql security definer set search_path = public as $$
declare u uuid := need_user(); eid uuid; n int;
begin
  perform lock_q();
  select courts_count into n from settings;
  if p_court is null or p_court < 0 or p_court >= n then raise exception 'No such court.'; end if;
  if exists (select 1 from entry_members where user_id = u) then raise exception 'You are already signed up.'; end if;
  if p_side is null or p_side not in ('a','b') then raise exception 'Choose a side on the court.'; end if;
  if side_count(p_court, p_side) >= court_cap(p_court) then raise exception 'That side is full. Choose the opposing side or another court.'; end if;
  insert into entries (court, side, queue_court) values (p_court, p_side, p_court) returning id into eid;
  insert into entry_members (user_id, entry_id) values (u, eid);
  perform settle();
end $$;

create function leave_queue() returns void language plpgsql security definer set search_path = public as $$
declare u uuid := need_user();
begin perform lock_q(); delete from entry_members where user_id = u; perform settle(); end $$;  -- partner stays as a single

create function leave_pair() returns void language plpgsql security definer set search_path = public as $$
declare u uuid := need_user(); eid uuid;
begin
  perform lock_q();
  select entry_id into eid from entry_members where user_id = u;
  if eid is null or entry_size(eid) <> 2 then raise exception 'You are not currently in a pair.'; end if;
  delete from entries where id = eid;
  perform settle();
end $$;

create function switch_court(p_court int, p_side text default null) returns void language plpgsql security definer set search_path = public as $$
declare u uuid := need_user(); n int; eid uuid;
begin
  perform lock_q();
  select courts_count into n from settings;
  if p_court is null or p_court < 0 or p_court >= n then raise exception 'No such court.'; end if;
  if p_side is not null and p_side not in ('a','b') then raise exception 'Choose a valid side.'; end if;
  if not exists (select 1 from entry_members where user_id = u) then raise exception 'You are not signed up anywhere.'; end if;
  delete from entry_members where user_id = u;
  perform settle();
  if p_side is not null and side_count(p_court, p_side) < court_cap(p_court) then
    insert into entries (court, side, queue_court) values (p_court, p_side, p_court) returning id into eid;
  else
    insert into entries (queue_court) values (p_court) returning id into eid;
  end if;
  insert into entry_members (user_id, entry_id) values (u, eid);
  perform settle();
end $$;

create function move_queue(p_court int) returns void language plpgsql security definer set search_path = public as $$
declare u uuid := need_user(); eid uuid; qc int; n int;
begin
  perform lock_q();
  select courts_count into n from settings;
  if p_court is null or p_court < 0 or p_court >= n then raise exception 'No such court.'; end if;
  select e.id, e.queue_court into eid, qc from entries e join entry_members m on m.entry_id = e.id where m.user_id = u and e.court is null;
  if eid is null then raise exception 'You are not waiting in a queue.'; end if;
  if qc = p_court then raise exception 'You are already in that queue.'; end if;
  if entry_size(eid) > court_cap(p_court) then raise exception 'Teams cannot queue for a singles court.'; end if;
  update entries set queue_court = p_court, seq = nextval('entry_seq'), spot_owner = null where id = eid;
  perform settle();
end $$;

create function queue_to_court(p_court int, p_side text) returns void language plpgsql security definer set search_path = public as $$
declare u uuid := need_user(); eid uuid; first_entry uuid; n int; sz int;
begin
  perform lock_q();
  select entry_id into eid from entry_members where user_id = u;
  if eid is null or (select court from entries where id = eid) is not null then raise exception 'You are not waiting in the queue.'; end if;
  select courts_count into n from settings;
  if p_court is null or p_court < 0 or p_court >= n then raise exception 'No such court.'; end if;
  select e.id into first_entry from entries e where e.court is null and (e.queue_court = p_court or e.queue_court is null) order by e.seq limit 1;
  if first_entry <> eid then raise exception 'Wait for your turn before choosing a court.'; end if;
  if p_side is null or p_side not in ('a','b') then raise exception 'Choose a valid side.'; end if;
  sz := entry_size(eid);
  if side_count(p_court, p_side) + sz > court_cap(p_court) then raise exception 'That side no longer has room for your entry.'; end if;
  update entries set court = p_court, side = p_side, queue_court = p_court, streak = 0 where id = eid;
  perform settle();
end $$;

create function join_team(p_entry uuid) returns void language plpgsql security definer set search_path = public as $$
declare u uuid := need_user(); mine uuid; my_seq bigint; my_qc int; my_court int;
        target_user uuid; t_seq bigint; t_qc int;
begin
  perform lock_q();
  select e.seq, e.queue_court into t_seq, t_qc from entries e where e.id = p_entry and e.court is null;
  if t_seq is null then raise exception 'That player is no longer waiting.'; end if;
  if entry_size(p_entry) <> 1 then raise exception 'That team is already full.'; end if;
  select user_id into target_user from entry_members where entry_id = p_entry;
  if target_user = u then raise exception 'You cannot team up with yourself.'; end if;
  if court_cap(t_qc) < 2 then raise exception 'Teams cannot queue for a singles court.'; end if;
  select e.id, e.seq, e.queue_court, e.court into mine, my_seq, my_qc, my_court
    from entries e join entry_members m on m.entry_id = e.id where m.user_id = u;
  if mine is not null then
    if my_court is not null then raise exception 'Finish your game before joining a team.'; end if;
    if entry_size(mine) > 1 then raise exception 'You already have a partner.'; end if;
    delete from entries where id = mine;
  end if;
  insert into entry_members (user_id, entry_id) values (u, p_entry);
  -- the pair keeps the spot of whichever partner was further ahead in the same court's queue
  if mine is not null and my_qc is not distinct from t_qc and my_seq < t_seq then
    update entries set seq = my_seq, spot_owner = u where id = p_entry;
  else
    update entries set spot_owner = target_user where id = p_entry;
  end if;
  delete from invites where from_user in (u, target_user) or to_user in (u, target_user);
  perform settle();
end $$;

create function report_win(p_court int, p_side text) returns void language plpgsql security definer set search_path = public as $$
declare u uuid := need_user(); loser text; out_side text; keep_loser boolean; cap int;
begin
  perform lock_q();
  if p_side not in ('a','b') then raise exception 'Bad side.'; end if;
  loser := case when p_side = 'a' then 'b' else 'a' end;
  if not is_admin() and not exists (select 1 from entry_members m join entries e on e.id = m.entry_id where m.user_id = u and e.court = p_court) then
    raise exception 'Only players on this court can report a result.'; end if;
  if side_count(p_court, 'a') = 0 or side_count(p_court, 'b') = 0 then raise exception 'Both sides need players.'; end if;
  update entries set streak = streak + 1 where court = p_court;
  select win_cap, loser_back into cap, keep_loser from settings where id = 1;
  -- winners stay on, unless they just hit the win cap: then they come off and the losers stay
  out_side := case when (select max(streak) from entries where court = p_court and side = p_side) >= cap then p_side else loser end;
  if keep_loser then
    update entries set court = null, side = null, queue_court = p_court, streak = 0, spot_owner = null, seq = nextval('entry_seq')
      where court = p_court and side = out_side;
  else
    delete from entries where court = p_court and side = out_side;
  end if;
  perform settle();
end $$;

-- ---------- invites ----------
create function pair_up(a uuid, b uuid) returns void language plpgsql as $$
declare minseq bigint; qc int; owner uuid; eid uuid;
begin
  if exists (select 1 from entry_members m join entries e on e.id = m.entry_id
             where m.user_id in (a, b) and (e.court is not null or entry_size(e.id) > 1)) then
    raise exception 'Both players must be unpaired and not currently on a court.'; end if;
  select e.seq, e.queue_court, m.user_id into minseq, qc, owner
    from entries e join entry_members m on m.entry_id = e.id where m.user_id in (a, b) order by e.seq limit 1;
  if court_cap(qc) < 2 then raise exception 'Teams cannot queue for a singles court.'; end if;
  delete from entries where id in (select entry_id from entry_members where user_id in (a, b));
  insert into entries (seq, queue_court, spot_owner) values (coalesce(minseq, nextval('entry_seq')), qc, owner) returning id into eid;
  insert into entry_members (user_id, entry_id) values (a, eid), (b, eid);
  delete from invites where from_user in (a, b) or to_user in (a, b);
end $$;

create function send_invite(p_email text default null, p_user uuid default null, p_court int default null, p_side text default null)
returns void language plpgsql security definer set search_path = public as $$
declare u uuid := need_user(); o uuid; n int; matches int;
begin
  perform lock_q();
  if (p_court is null) <> (p_side is null) then raise exception 'Choose both a court and side.'; end if;
  if p_user is not null then o := p_user;
  else
    select id into o from profiles where lower(email) = lower(trim(p_email));
    if o is null then
      select count(*) into matches from profiles where lower(trim(name)) = lower(trim(p_email));
      if matches > 1 then raise exception 'That username matches multiple players. Invite by email instead.'; end if;
      if matches = 1 then select id into o from profiles where lower(trim(name)) = lower(trim(p_email)); end if;
    end if;
  end if;
  if o is null or not exists (select 1 from profiles where id = o) then raise exception 'No player found with that email or username. They need to create an account first.'; end if;
  if o = u then raise exception 'You cannot partner with yourself.'; end if;
  if exists (select 1 from entry_members m where m.user_id in (u, o) and entry_size(m.entry_id) > 1) then raise exception 'Both players must be unpaired.'; end if;
  if p_court is not null then
    select courts_count into n from settings;
    if p_court < 0 or p_court >= n then raise exception 'No such court.'; end if;
    if p_side not in ('a','b') then raise exception 'Choose a valid side.'; end if;
    if court_cap(p_court) < 2 then raise exception 'Pairs cannot play on a singles court.'; end if;
    if side_count(p_court, p_side) > 0 then raise exception 'That side needs two open spots for the pair.'; end if;
    if exists (select 1 from entry_members m join entries e on e.id = m.entry_id where m.user_id in (u, o) and e.court is not null) then
      raise exception 'Both players must be off court to send a court invite.'; end if;
  end if;
  if exists (select 1 from invites where (from_user = u and to_user = o) or (from_user = o and to_user = u)) then raise exception 'An invite already exists between you two.'; end if;
  insert into invites (from_user, to_user, court, side) values (u, o, p_court, p_side);
end $$;

create function respond_invite(p_id uuid, p_accept boolean) returns void language plpgsql security definer set search_path = public as $$
declare u uuid := need_user(); inv invites; n int;
begin
  perform lock_q();
  select * into inv from invites where id = p_id and to_user = u;
  if inv.id is null then raise exception 'Invite not found.'; end if;
  if not p_accept then delete from invites where id = p_id; return; end if;
  if inv.court is not null then
    select courts_count into n from settings;
    if inv.court < 0 or inv.court >= n then raise exception 'No such court.'; end if;
    if court_cap(inv.court) < 2 then raise exception 'Pairs cannot play on a singles court.'; end if;
    if side_count(inv.court, inv.side) > 0 then raise exception 'That side no longer has two open spots. Ask for another invite.'; end if;
    perform pair_up(inv.from_user, u);
    update entries set court = inv.court, side = inv.side, queue_court = inv.court, streak = 0 where id = (select entry_id from entry_members where user_id = u);
  else
    perform pair_up(inv.from_user, u);
  end if;
  perform settle();
end $$;

create function cancel_invite(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
begin delete from invites where id = p_id and from_user = need_user(); end $$;

-- ---------- admin actions ----------
create function admin_kick(p_user uuid) returns void language plpgsql security definer set search_path = public as $$
begin perform need_admin(); perform lock_q(); delete from entry_members where user_id = p_user; perform settle(); end $$;

create function admin_remove_pair(p_entry uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  perform need_admin();
  perform lock_q();
  if not exists (select 1 from entries where id = p_entry and entry_size(id) = 2) then
    raise exception 'Pair not found.';
  end if;
  delete from entries where id = p_entry;
  perform settle();
end $$;

create function admin_move(p_entry uuid, p_dest text) returns void language plpgsql security definer set search_path = public as $$
declare c int; s text; sz int; cur int;
begin
  perform need_admin(); perform lock_q();
  select court into cur from entries where id = p_entry;
  if not found then raise exception 'Entry not found.'; end if;
  sz := entry_size(p_entry);
  if p_dest = 'q-front' then
    update entries set court = null, side = null, queue_court = coalesce(cur, queue_court), streak = 0,
      seq = (select coalesce(min(seq), 0) - 1 from entries where court is null) where id = p_entry;
  elsif p_dest = 'q-end' then
    update entries set court = null, side = null, queue_court = coalesce(cur, queue_court), streak = 0, seq = nextval('entry_seq') where id = p_entry;
  elsif p_dest ~ '^c[0-9]+$' then
    c := substr(p_dest, 2)::int;
    if c >= (select courts_count from settings) then raise exception 'No such court.'; end if;
    update entries set court = null, side = null where id = p_entry;
    foreach s in array array['a','b'] loop
      if side_count(c, s) + sz <= court_cap(c) then update entries set court = c, side = s, queue_court = c, streak = 0 where id = p_entry; exit; end if;
    end loop;
    if not exists (select 1 from entries where id = p_entry and court is not null) then raise exception 'That court has no room for this entry.'; end if;
  else raise exception 'Bad destination.'; end if;
  perform settle();
end $$;

create function admin_pair_move(p_first uuid, p_second uuid, p_dest text) returns void language plpgsql security definer set search_path = public as $$
declare first_entry uuid; second_entry uuid; first_seq bigint; second_seq bigint; eid uuid; c int; s text; n int;
begin
  perform need_admin();
  perform lock_q();
  if p_first is null or p_second is null or p_first = p_second then raise exception 'Choose two different players.'; end if;
  select entry_id into first_entry from entry_members where user_id = p_first;
  select entry_id into second_entry from entry_members where user_id = p_second;
  if first_entry is null or second_entry is null then raise exception 'Both players must have a spot.'; end if;
  if first_entry = second_entry or entry_size(first_entry) <> 1 or entry_size(second_entry) <> 1 then
    raise exception 'Choose two players who are each unpaired.';
  end if;
  select seq into first_seq from entries where id = first_entry;
  select seq into second_seq from entries where id = second_entry;
  delete from entries where id in (first_entry, second_entry);
  if p_dest = 'q-front' then
    insert into entries (seq) values ((select coalesce(min(seq), 0) - 1 from entries where court is null)) returning id into eid;
  elsif p_dest = 'q-end' then
    insert into entries default values returning id into eid;
  elsif p_dest ~ '^c[0-9]+$' then
    c := substr(p_dest, 2)::int;
    select courts_count into n from settings;
    if c < 0 or c >= n then raise exception 'No such court.'; end if;
    if court_cap(c) < 2 then raise exception 'Pairs cannot play on a singles court.'; end if;
    if side_count(c, 'a') = 0 then s := 'a';
    elsif side_count(c, 'b') = 0 then s := 'b';
    else raise exception 'That court has no side with room for a pair.'; end if;
    insert into entries (court, side, seq, queue_court) values (c, s, least(first_seq, second_seq), c) returning id into eid;
  else raise exception 'Bad destination.'; end if;
  insert into entry_members (user_id, entry_id) values (p_first, eid), (p_second, eid);
  perform settle();
end $$;

create function admin_set_loser_back(p_loser_back boolean) returns void language plpgsql security definer set search_path = public as $$
begin perform need_admin(); update settings set loser_back = p_loser_back where id = 1; end $$;

create function admin_allow(p_email text, p_add boolean) returns void language plpgsql security definer set search_path = public as $$
declare em text := lower(trim(p_email));
begin
  perform need_admin();
  if em = '' then raise exception 'Enter an email.'; end if;
  if p_add then insert into admin_emails (email) values (em) on conflict do nothing; else delete from admin_emails where email = em; end if;
end $$;

-- ---------- read model: one consistent snapshot for the UI ----------
create function entries_json(p_court int, p_side text) returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id,
           'members', (select coalesce(jsonb_agg(m.user_id order by m.joined), '[]'::jsonb) from entry_members m where m.entry_id = e.id),
           'queueCourt', e.queue_court, 'streak', e.streak) order by e.seq), '[]'::jsonb)
  from entries e where e.court is not distinct from p_court and e.side is not distinct from p_side $$;

create function get_state() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare u uuid := auth.uid(); adm boolean := is_admin(); st settings;
begin
  select * into st from settings where id = 1;
  return jsonb_build_object(
    'me', (select jsonb_build_object('id', p.id, 'name', p.name, 'email', p.email, 'isAdmin', adm) from profiles p where p.id = u),
    'courts', (select coalesce(jsonb_agg(jsonb_build_object('a', entries_json(c, 'a'), 'b', entries_json(c, 'b')) order by c), '[]'::jsonb) from generate_series(0, st.courts_count - 1) c),
    'courtModes', (select coalesce(jsonb_agg(case when c = any(st.singles_courts) then 'singles' else 'doubles' end order by c), '[]'::jsonb) from generate_series(0, st.courts_count - 1) c),
    'queue', entries_json(null, null),
    'names', (select coalesce(jsonb_object_agg(p.id, p.name), '{}'::jsonb) from profiles p
              where p.id in (select user_id from entry_members)
                 or p.id in (select from_user from invites where from_user = u or to_user = u)
                 or p.id in (select to_user from invites where from_user = u or to_user = u)),
    'invites', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'from', i.from_user, 'to', i.to_user, 'court', i.court, 'side', i.side)), '[]'::jsonb) from invites i where i.from_user = u or i.to_user = u),
    'loserBack', st.loser_back,
    'winCap', st.win_cap,
    'admins', case when adm then jsonb_build_object('list', (select coalesce(jsonb_agg(email order by email), '[]'::jsonb) from admin_emails)) end);
end $$;

-- ---------- security: RLS on, clients may only read (for realtime); every change goes through the functions above ----------
alter table profiles enable row level security;  alter table admin_emails enable row level security;
alter table settings enable row level security;  alter table entries enable row level security;
alter table entry_members enable row level security;  alter table invites enable row level security;
create policy "read entries" on entries for select to authenticated using (true);
create policy "read members" on entry_members for select to authenticated using (true);
create policy "read my invites" on invites for select to authenticated using (from_user = auth.uid() or to_user = auth.uid());
create policy "read own profile" on profiles for select to authenticated using (id = auth.uid());
revoke all on all tables in schema public from anon, authenticated;
grant select on entries, entry_members, invites, profiles to authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function get_state(), join_queue(int), join_court(int, text), leave_queue(), leave_pair(), switch_court(int, text),
  move_queue(int), queue_to_court(int, text), join_team(uuid), report_win(int, text),
  send_invite(text, uuid, int, text), respond_invite(uuid, boolean), cancel_invite(uuid),
  admin_kick(uuid), admin_remove_pair(uuid), admin_move(uuid, text), admin_pair_move(uuid, uuid, text),
  admin_set_loser_back(boolean), admin_allow(text, boolean) to authenticated;
alter publication supabase_realtime add table entries, entry_members, invites;

-- >>> EDIT on a fresh project: your first admin email(s). More can be added later from the admin panel. <<<
insert into admin_emails (email) values ('you@example.com');
