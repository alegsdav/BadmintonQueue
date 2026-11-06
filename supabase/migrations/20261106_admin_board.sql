-- Admin board: put a player or team on a chosen court side, swap any two players,
-- and drop anyone at an exact spot in a court's queue. Adds functions only; nothing existing changes.

-- Give one player their own entry at their current place, so they can move without their partner.
create function admin_detach(p_user uuid) returns uuid language plpgsql set search_path = public as $$
declare old entries; eid uuid;
begin
  select e.* into old from entries e join entry_members m on m.entry_id = e.id where m.user_id = p_user;
  if old.id is null then raise exception 'That player no longer has a spot.'; end if;
  if entry_size(old.id) = 1 then return old.id; end if;
  delete from entry_members where user_id = p_user;  -- entry_member_left fixes the partner's place in line
  insert into entries (court, side, seq, queue_court, streak) values (old.court, old.side, old.seq, old.queue_court, old.streak) returning id into eid;
  insert into entry_members (user_id, entry_id) values (p_user, eid);
  return eid;
end $$;

-- The entry an admin action moves: a whole team (p_entry) or one player (p_user).
create function admin_target(p_entry uuid, p_user uuid) returns uuid language plpgsql set search_path = public as $$
begin
  if (p_entry is null) = (p_user is null) then raise exception 'Choose a player or a team.'; end if;
  if p_user is not null then return admin_detach(p_user); end if;
  if not exists (select 1 from entries where id = p_entry) then raise exception 'That spot just changed. Try again.'; end if;
  return p_entry;
end $$;

-- Put a team or player on one side of a court.
create function admin_place(p_court int, p_side text, p_entry uuid default null, p_user uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare t uuid; n int; cur_c int; cur_s text;
begin
  perform need_admin(); perform lock_q();
  select courts_count into n from settings;
  if p_court is null or p_court < 0 or p_court >= n then raise exception 'No such court.'; end if;
  if p_side is null or p_side not in ('a','b') then raise exception 'Choose a side.'; end if;
  select e.court, e.side into cur_c, cur_s from entries e
    where e.id = coalesce(p_entry, (select entry_id from entry_members where user_id = p_user));
  if cur_c = p_court and cur_s = p_side then return; end if;  -- already there
  t := admin_target(p_entry, p_user);
  if side_count(p_court, p_side) + entry_size(t) > court_cap(p_court) then
    raise exception 'That side is full. Drop onto a player to swap instead.'; end if;
  -- switching sides on the same court keeps the win streak; arriving from elsewhere starts at 0
  update entries set court = p_court, side = p_side, queue_court = p_court, spot_owner = null,
    streak = case when court = p_court then streak else 0 end where id = t;
  perform settle();
end $$;

-- Move a team or player into court p_queue_court's queue, just ahead of entry p_before (null = the end).
create function admin_queue(p_queue_court int, p_before uuid default null, p_entry uuid default null, p_user uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare t uuid; n int; b entries;
begin
  perform need_admin(); perform lock_q();
  select courts_count into n from settings;
  if p_queue_court is null or p_queue_court < 0 or p_queue_court >= n then raise exception 'No such court.'; end if;
  t := admin_target(p_entry, p_user);
  if p_before = t then return; end if;  -- dropped on itself
  if entry_size(t) > court_cap(p_queue_court) then raise exception 'Teams cannot queue for a singles court.'; end if;
  if p_before is null then
    update entries set court = null, side = null, queue_court = p_queue_court, streak = 0, spot_owner = null,
      seq = nextval('entry_seq') where id = t;
  else
    select * into b from entries where id = p_before and court is null;
    if b.id is null or b.queue_court is distinct from p_queue_court and b.queue_court is not null then
      raise exception 'That spot in line just changed. Try again.'; end if;
    -- open a gap at b's place: everyone waiting from b onward moves back one
    update entries set seq = seq + 1 where court is null and seq >= b.seq and id <> t;
    update entries set court = null, side = null, queue_court = p_queue_court, streak = 0, spot_owner = null,
      seq = b.seq where id = t;
    perform setval('entry_seq', greatest((select max(seq) from entries), (select last_value from entry_seq)));
  end if;
  perform settle();
end $$;

-- Swap two players' places: on court, between sides or courts, or between a court and the queue.
-- Each player takes over the other's spot, partner included.
create function admin_swap(p_a uuid, p_b uuid) returns void language plpgsql security definer set search_path = public as $$
declare ea entries; eb entries;
begin
  perform need_admin(); perform lock_q();
  if p_a is null or p_b is null or p_a = p_b then raise exception 'Choose two different players.'; end if;
  select e.* into ea from entries e join entry_members m on m.entry_id = e.id where m.user_id = p_a;
  select e.* into eb from entries e join entry_members m on m.entry_id = e.id where m.user_id = p_b;
  if ea.id is null or eb.id is null then raise exception 'Both players need a spot.'; end if;
  if ea.id = eb.id then return; end if;  -- same team: nothing to swap
  update entry_members set entry_id = case when user_id = p_a then eb.id else ea.id end where user_id in (p_a, p_b);
  update entries set spot_owner = null,
    streak = case when ea.court is not distinct from eb.court then streak else 0 end where id in (ea.id, eb.id);
  perform settle();
end $$;

revoke execute on function admin_detach(uuid), admin_target(uuid, uuid), admin_place(int, text, uuid, uuid),
  admin_queue(int, uuid, uuid, uuid), admin_swap(uuid, uuid) from public, anon, authenticated;
grant execute on function admin_place(int, text, uuid, uuid), admin_queue(int, uuid, uuid, uuid), admin_swap(uuid, uuid) to authenticated;
