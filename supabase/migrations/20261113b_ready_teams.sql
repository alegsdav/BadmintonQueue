-- Forming a team and signing that team up are separate actions.
create table ready_teams (
  player_a uuid primary key references profiles(id) on delete cascade,
  player_b uuid unique not null references profiles(id) on delete cascade,
  check (player_a <> player_b)
);
alter table ready_teams enable row level security;
revoke all on ready_teams from public, anon, authenticated;

-- Call under lock_q(). Removing the row and creating the board entry share a transaction.
create function take_ready_teammate(p_user uuid) returns uuid
language sql set search_path = public as $$
  delete from ready_teams where p_user in (player_a, player_b)
  returning case when player_a = p_user then player_b else player_a end
$$;

create function leave_ready_team() returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := need_user();
begin
  perform lock_q();
  perform take_ready_teammate(u);
end $$;

-- An admin seating or swapping one player into an existing spot dissolves their off-board team.
create function clear_ready_team_on_placement() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform take_ready_teammate(new.user_id);
  return null;
end $$;
create trigger clear_ready_team_on_placement after insert or update of user_id on entry_members
for each row execute function clear_ready_team_on_placement();

create or replace function can_invite_player(p_user uuid) returns boolean
language sql stable set search_path = public as $$
  select exists (select 1 from auth.users where id = p_user and email_confirmed_at is not null)
    and not exists (select 1 from ready_teams where p_user in (player_a, player_b))
    and not exists (
      select 1 from entry_members m join entries e on e.id = m.entry_id
      where m.user_id = p_user
        and (e.court is not null or entry_size(e.id) <> 1 or court_cap(e.queue_court) < 2)
    ) $$;

create or replace function respond_invite(p_id uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := need_user(); inv invites;
begin
  perform lock_q();
  select * into inv from invites where id = p_id and to_user = u;
  if inv.id is null then raise exception 'Invite not found.'; end if;
  if p_accept is null then raise exception 'Choose whether to accept the invite.'; end if;
  if not p_accept then delete from invites where id = p_id; return; end if;
  if not can_invite_player(inv.from_user) or not can_invite_player(u) then
    raise exception 'Both players must be off court, unpaired, and outside a singles queue to team up.';
  end if;

  -- Any individual queue places are surrendered when the two form a team.
  delete from entry_members where user_id in (inv.from_user, u);
  insert into ready_teams (player_a, player_b) values (inv.from_user, u);
  delete from invites where from_user in (inv.from_user, u) or to_user in (inv.from_user, u);
  perform settle();
end $$;

create or replace function join_queue(p_court int default null) returns void language plpgsql security definer set search_path = public as $$
declare u uuid := need_user(); eid uuid; n int; teammate uuid;
begin
  perform lock_q();
  if exists (select 1 from entry_members where user_id = u) then raise exception 'You are already signed up.'; end if;
  if p_court is not null then
    select courts_count into n from settings;
    if p_court < 0 or p_court >= n then raise exception 'No such court.'; end if;
  end if;
  teammate := take_ready_teammate(u);
  if teammate is not null and (p_court is null or court_cap(p_court) < 2) then
    raise exception 'Choose a doubles court to queue as a team.';
  end if;
  insert into entries (queue_court) values (p_court) returning id into eid;
  insert into entry_members (user_id, entry_id) values (u, eid);
  if teammate is not null then insert into entry_members (user_id, entry_id) values (teammate, eid); end if;
  perform settle();
end $$;

create or replace function join_court(p_court int, p_side text) returns void language plpgsql security definer set search_path = public as $$
declare u uuid := need_user(); eid uuid; n int; teammate uuid;
begin
  perform lock_q();
  select courts_count into n from settings;
  if p_court is null or p_court < 0 or p_court >= n then raise exception 'No such court.'; end if;
  if exists (select 1 from entry_members where user_id = u) then raise exception 'You are already signed up.'; end if;
  if p_side is null or p_side not in ('a','b') then raise exception 'Choose a side on the court.'; end if;
  teammate := take_ready_teammate(u);
  if teammate is not null and court_cap(p_court) < 2 then raise exception 'Choose a doubles court to join as a team.'; end if;
  if side_count(p_court, p_side) + (case when teammate is null then 1 else 2 end) > court_cap(p_court) then raise exception 'That side is full. Choose the opposing side or another court.'; end if;
  insert into entries (court, side, queue_court) values (p_court, p_side, p_court) returning id into eid;
  insert into entry_members (user_id, entry_id) values (u, eid);
  if teammate is not null then insert into entry_members (user_id, entry_id) values (teammate, eid); end if;
  perform settle();
end $$;

create or replace function get_state() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare u uuid := auth.uid(); adm boolean := is_admin(); st settings;
begin
  select * into st from settings where id = 1;
  return jsonb_build_object(
    'me', (select jsonb_build_object('id', p.id, 'name', p.name, 'email', p.email, 'isAdmin', adm) from profiles p where p.id = u),
    'courts', (select coalesce(jsonb_agg(jsonb_build_object('a', entries_json(c, 'a'), 'b', entries_json(c, 'b')) order by c), '[]'::jsonb) from generate_series(0, st.courts_count - 1) c),
    'courtModes', (select coalesce(jsonb_agg(case when c = any(st.singles_courts) then 'singles' else 'doubles' end order by c), '[]'::jsonb) from generate_series(0, st.courts_count - 1) c),
    'queue', entries_json(null, null),
    'readyTeammate', (select jsonb_build_object('id', p.id, 'name', p.name)
      from ready_teams t join profiles p on p.id = case when t.player_a = u then t.player_b else t.player_a end
      where u in (t.player_a, t.player_b)),
    'names', (select coalesce(jsonb_object_agg(p.id, p.name), '{}'::jsonb) from profiles p
              where p.id in (select user_id from entry_members)
                 or p.id in (select from_user from invites where from_user = u or to_user = u)
                 or p.id in (select to_user from invites where from_user = u or to_user = u)),
    'invites', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'from', i.from_user, 'to', i.to_user, 'court', i.court, 'side', i.side)), '[]'::jsonb) from invites i where i.from_user = u or i.to_user = u),
    'loserBack', st.loser_back,
    'winCap', st.win_cap,
    'admins', case when adm then jsonb_build_object('list', (select coalesce(jsonb_agg(email order by email), '[]'::jsonb) from admin_emails)) end);
end $$;

revoke execute on function take_ready_teammate(uuid), leave_ready_team(), clear_ready_team_on_placement()
  from public, anon, authenticated;
grant execute on function leave_ready_team() to authenticated;
