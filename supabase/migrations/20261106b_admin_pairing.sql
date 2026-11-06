-- Admin pairing: team any two players up wherever they are, and split any team.
-- Admin moves never shuffle anyone else: a player taken out of a team no longer sends their partner to the end.

-- Give one player their own entry at their current place. In line, they wait right behind their old partner.
create or replace function admin_detach(p_user uuid) returns uuid language plpgsql set search_path = public as $$
declare old entries; eid uuid;
begin
  select e.* into old from entries e join entry_members m on m.entry_id = e.id where m.user_id = p_user;
  if old.id is null then raise exception 'That player no longer has a spot.'; end if;
  if entry_size(old.id) = 1 then return old.id; end if;
  if old.court is null then update entries set seq = seq + 1 where court is null and seq > old.seq; end if;
  insert into entries (court, side, seq, queue_court, streak)
    values (old.court, old.side, case when old.court is null then old.seq + 1 else old.seq end, old.queue_court, old.streak)
    returning id into eid;
  -- move the membership instead of deleting it, so entry_member_left does not send the partner to the end
  update entry_members set entry_id = eid, joined = clock_timestamp() where user_id = p_user;
  update entries set spot_owner = null where id = old.id;
  perform setval('entry_seq', greatest((select max(seq) from entries), (select last_value from entry_seq)));
  return eid;
end $$;

-- Team p_user up with p_target: p_user joins p_target where p_target is (on court or in line),
-- leaving their own partner if they had one.
create function admin_pair(p_user uuid, p_target uuid) returns void language plpgsql security definer set search_path = public as $$
declare mine entries; t entries; tname text;
begin
  perform need_admin(); perform lock_q();
  if p_user is null or p_target is null or p_user = p_target then raise exception 'Choose two different players.'; end if;
  select e.* into mine from entries e join entry_members m on m.entry_id = e.id where m.user_id = p_user;
  select e.* into t from entries e join entry_members m on m.entry_id = e.id where m.user_id = p_target;
  if mine.id is null or t.id is null then raise exception 'Both players need a spot.'; end if;
  if mine.id = t.id then return; end if;  -- already teammates
  select name into tname from profiles where id = p_target;
  if entry_size(t.id) > 1 then raise exception '% already has a partner. Split them up first.', tname; end if;
  if court_cap(coalesce(t.court, t.queue_court)) < 2 then raise exception 'Teams cannot play on or wait for a singles court.'; end if;
  if t.court is not null and side_count(t.court, t.side) + 1
       - (case when mine.court = t.court and mine.side = t.side then 1 else 0 end) > court_cap(t.court) then
    raise exception 'No room for a team on that side. Move someone off it first.'; end if;
  update entry_members set entry_id = t.id, joined = clock_timestamp() where user_id = p_user;
  update entries set spot_owner = case when id = t.id then p_target end where id in (t.id, mine.id);
  delete from invites where from_user in (p_user, p_target) or to_user in (p_user, p_target);
  perform settle();
end $$;

-- Split p_user from their partner. Both keep their place: on court they stay on the same side;
-- in line the partner keeps the spot and p_user waits right behind.
create function admin_split(p_user uuid) returns void language plpgsql security definer set search_path = public as $$
declare eid uuid;
begin
  perform need_admin(); perform lock_q();
  select entry_id into eid from entry_members where user_id = p_user;
  if eid is null then raise exception 'That player no longer has a spot.'; end if;
  if entry_size(eid) < 2 then raise exception 'That player is not on a team.'; end if;
  perform admin_detach(p_user);
  perform settle();
end $$;

revoke execute on function admin_pair(uuid, uuid), admin_split(uuid) from public, anon, authenticated;
grant execute on function admin_pair(uuid, uuid), admin_split(uuid) to authenticated;
