-- Badminton queue: run this once in Supabase -> SQL Editor on a fresh project.
-- Clients can only READ via RLS; every change goes through the SECURITY DEFINER functions below.

create table profiles (id uuid primary key references auth.users on delete cascade, email text not null, name text not null);
create table admin_emails (email text primary key);
create table settings (id int primary key default 1 check (id = 1), courts_count int not null default 2, loser_back boolean not null default false);
insert into settings default values;
create sequence entry_seq;
-- An entry is a single player or a pair. court IS NULL means "waiting in the queue" (ordered by seq).
create table entries (
  id uuid primary key default gen_random_uuid(), court int, side text check (side in ('a','b')),
  seq bigint not null default nextval('entry_seq'), check ((court is null) = (side is null)));
create table entry_members (
  user_id uuid primary key references profiles(id) on delete cascade,  -- one place per player
  entry_id uuid not null references entries(id) on delete cascade, joined timestamptz not null default clock_timestamp());
create table invites (
  id uuid primary key default gen_random_uuid(), from_user uuid not null references profiles(id) on delete cascade,
  to_user uuid not null references profiles(id) on delete cascade, unique (from_user, to_user), check (from_user <> to_user));

-- >>> EDIT: your first admin email(s). More can be added later from the Admin tab. <<<
insert into admin_emails (email) values ('you@example.com');

-- New auth user -> profile
create function handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, name) values (new.id, lower(new.email),
    left(coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''), split_part(new.email, '@', 1)), 40));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

-- helpers
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

-- Promote from the queue into open court spots (sides hold 2 players; first entry that fits wins)
create function fill_courts() returns void language plpgsql as $$
declare n int; c int; s text; room int; eid uuid;
begin
  select courts_count into n from settings;
  for c in 0..n-1 loop
    foreach s in array array['a','b'] loop
      loop
        room := 2 - side_count(c, s); exit when room <= 0;
        select e.id into eid from entries e where e.court is null and entry_size(e.id) <= room order by e.seq limit 1;
        exit when eid is null;
        update entries set court = c, side = s where id = eid;
      end loop;
    end loop;
  end loop;
end $$;
create function settle() returns void language plpgsql as $$
begin delete from entries e where not exists (select 1 from entry_members m where m.entry_id = e.id); perform fill_courts(); end $$;

-- player actions
create function join_queue() returns void language plpgsql security definer set search_path = public as $$
declare u uuid := need_user(); eid uuid;
begin
  perform lock_q();
  if exists (select 1 from entry_members where user_id = u) then raise exception 'You are already signed up.'; end if;
  insert into entries default values returning id into eid;
  insert into entry_members (user_id, entry_id) values (u, eid);
  perform settle();
end $$;

create function leave_queue() returns void language plpgsql security definer set search_path = public as $$
declare u uuid := need_user();
begin perform lock_q(); delete from entry_members where user_id = u; perform settle(); end $$;  -- partner stays as a single

create function send_invite(p_email text default null, p_user uuid default null) returns void language plpgsql security definer set search_path = public as $$
declare u uuid := need_user(); o uuid;
begin
  perform lock_q();
  if p_user is not null then o := p_user; else select id into o from profiles where email = lower(trim(p_email)); end if;
  if o is null or not exists (select 1 from profiles where id = o) then raise exception 'No player found with that email. They need to create an account first.'; end if;
  if o = u then raise exception 'You cannot partner with yourself.'; end if;
  if exists (select 1 from entry_members m where m.user_id in (u, o) and entry_size(m.entry_id) > 1) then raise exception 'Both players must be unpaired.'; end if;
  if exists (select 1 from invites where (from_user = u and to_user = o) or (from_user = o and to_user = u)) then raise exception 'An invite already exists between you two.'; end if;
  insert into invites (from_user, to_user) values (u, o);
end $$;

create function pair_up(a uuid, b uuid) returns void language plpgsql as $$
declare minseq bigint; eid uuid;
begin
  if exists (select 1 from entry_members m join entries e on e.id = m.entry_id
             where m.user_id in (a, b) and (e.court is not null or entry_size(e.id) > 1)) then
    raise exception 'Both players must be unpaired and not currently on a court.'; end if;
  select min(e.seq) into minseq from entries e join entry_members m on m.entry_id = e.id where m.user_id in (a, b);
  delete from entries where id in (select entry_id from entry_members where user_id in (a, b));
  insert into entries (seq) values (coalesce(minseq, nextval('entry_seq'))) returning id into eid;
  insert into entry_members (user_id, entry_id) values (a, eid), (b, eid);
  delete from invites where from_user in (a, b) or to_user in (a, b);
end $$;

create function respond_invite(p_id uuid, p_accept boolean) returns void language plpgsql security definer set search_path = public as $$
declare u uuid := need_user(); inv invites;
begin
  perform lock_q();
  select * into inv from invites where id = p_id and to_user = u;
  if inv.id is null then raise exception 'Invite not found.'; end if;
  if not p_accept then delete from invites where id = p_id; return; end if;
  perform pair_up(inv.from_user, u); perform settle();
end $$;

create function cancel_invite(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
begin delete from invites where id = p_id and from_user = need_user(); end $$;

create function report_win(p_court int, p_side text) returns void language plpgsql security definer set search_path = public as $$
declare u uuid := need_user(); loser text;
begin
  perform lock_q();
  if p_side not in ('a','b') then raise exception 'Bad side.'; end if;
  loser := case when p_side = 'a' then 'b' else 'a' end;
  if not is_admin() and not exists (select 1 from entry_members m join entries e on e.id = m.entry_id where m.user_id = u and e.court = p_court) then
    raise exception 'Only players on this court can report a result.'; end if;
  if side_count(p_court, 'a') = 0 or side_count(p_court, 'b') = 0 then raise exception 'Both sides need players.'; end if;
  if (select loser_back from settings) then
    update entries set court = null, side = null, seq = nextval('entry_seq') where court = p_court and side = loser;
  else delete from entries where court = p_court and side = loser; end if;
  perform settle();
end $$;

-- admin actions
create function admin_kick(p_user uuid) returns void language plpgsql security definer set search_path = public as $$
begin perform need_admin(); perform lock_q(); delete from entry_members where user_id = p_user; perform settle(); end $$;

create function admin_move(p_entry uuid, p_dest text) returns void language plpgsql security definer set search_path = public as $$
declare c int; s text; sz int;
begin
  perform need_admin(); perform lock_q();
  if not exists (select 1 from entries where id = p_entry) then raise exception 'Entry not found.'; end if;
  sz := entry_size(p_entry);
  if p_dest = 'q-front' then
    update entries set court = null, side = null, seq = (select coalesce(min(seq), 0) - 1 from entries where court is null) where id = p_entry;
  elsif p_dest = 'q-end' then
    update entries set court = null, side = null, seq = nextval('entry_seq') where id = p_entry;
  elsif p_dest ~ '^c[0-9]+$' then
    c := substr(p_dest, 2)::int;
    if c >= (select courts_count from settings) then raise exception 'No such court.'; end if;
    update entries set court = null, side = null where id = p_entry;
    foreach s in array array['a','b'] loop
      if side_count(c, s) + sz <= 2 then update entries set court = c, side = s where id = p_entry; exit; end if;
    end loop;
    if not exists (select 1 from entries where id = p_entry and court is not null) then raise exception 'That court has no room for this entry.'; end if;
  else raise exception 'Bad destination.'; end if;
  perform settle();  -- an exception anywhere above rolls the whole move back
end $$;

create function admin_set_loser_back(p boolean) returns void language plpgsql security definer set search_path = public as $$
begin perform need_admin(); update settings set loser_back = p; end $$;

create function admin_allow(p_email text, p_add boolean) returns void language plpgsql security definer set search_path = public as $$
declare em text := lower(trim(p_email));
begin
  perform need_admin();
  if em = '' then raise exception 'Enter an email.'; end if;
  if p_add then insert into admin_emails (email) values (em) on conflict do nothing; else delete from admin_emails where email = em; end if;
end $$;

-- read model: one consistent snapshot for the UI
create function entries_json(p_court int, p_side text) returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id,
           'members', (select coalesce(jsonb_agg(m.user_id order by m.joined), '[]'::jsonb) from entry_members m where m.entry_id = e.id)) order by e.seq), '[]'::jsonb)
  from entries e where e.court is not distinct from p_court and e.side is not distinct from p_side $$;

create function get_state() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare u uuid := auth.uid(); n int; adm boolean := is_admin();
begin
  select courts_count into n from settings;
  return jsonb_build_object(
    'me', (select jsonb_build_object('id', p.id, 'name', p.name, 'email', p.email, 'isAdmin', adm) from profiles p where p.id = u),
    'courts', (select coalesce(jsonb_agg(jsonb_build_object('a', entries_json(c, 'a'), 'b', entries_json(c, 'b')) order by c), '[]'::jsonb) from generate_series(0, n - 1) c),
    'queue', entries_json(null, null),
    'names', (select coalesce(jsonb_object_agg(p.id, p.name), '{}'::jsonb) from profiles p
              where p.id in (select user_id from entry_members)
                 or p.id in (select from_user from invites where from_user = u or to_user = u)
                 or p.id in (select to_user from invites where from_user = u or to_user = u)),
    'invites', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'from', i.from_user, 'to', i.to_user)), '[]'::jsonb) from invites i where i.from_user = u or i.to_user = u),
    'loserBack', (select loser_back from settings),
    'admins', case when adm then jsonb_build_object('list', (select coalesce(jsonb_agg(email order by email), '[]'::jsonb) from admin_emails)) end);
end $$;

-- security: RLS on, clients may only read (for realtime); everything else is via the functions above
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
grant execute on function get_state(), join_queue(), leave_queue(), send_invite(text, uuid), respond_invite(uuid, boolean),
  cancel_invite(uuid), report_win(int, text), admin_kick(uuid), admin_move(uuid, text), admin_set_loser_back(boolean),
  admin_allow(text, boolean) to authenticated;
alter publication supabase_realtime add table entries, entry_members, invites;
