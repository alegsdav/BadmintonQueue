-- Court tools: a part-filled side is never filled automatically, admins can seat anyone from the player list,
-- swap whole teams, and clear every court and queue for a practice reset.

-- An empty side takes the next team or player in line. A side that already has someone on it waits:
-- a solo player in that court's queue joins it by hand (switch_court), or an admin seats someone.
create or replace function fill_courts() returns void language plpgsql as $$
declare n int; c int; s text; eid uuid;
begin
  select courts_count into n from settings;
  for c in 0..n-1 loop
    foreach s in array array['a','b'] loop
      continue when side_count(c, s) > 0;
      select e.id into eid from entries e
        where e.court is null and (e.queue_court = c or e.queue_court is null) and entry_size(e.id) <= court_cap(c)
        order by e.seq limit 1;
      if eid is not null then update entries set court = c, side = s, queue_court = c, streak = 0 where id = eid; end if;
    end loop;
  end loop;
end $$;

-- Every player with an account, for the admin's "add a player" list.
create function admin_players() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform need_admin();
  return (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'email', email) order by lower(name), email), '[]'::jsonb) from profiles);
end $$;

-- Seat one player on a court side, wherever they are now: not signed up, on another court, alone in line,
-- or in line with a teammate (they split, and the teammate keeps the spot).
create function admin_seat(p_court int, p_side text, p_user uuid) returns void language plpgsql security definer set search_path = public as $$
declare n int; cur entries; t uuid;
begin
  perform need_admin(); perform lock_q();
  select courts_count into n from settings;
  if p_court is null or p_court < 0 or p_court >= n then raise exception 'No such court.'; end if;
  if p_side is null or p_side not in ('a','b') then raise exception 'Choose a side.'; end if;
  if not exists (select 1 from profiles where id = p_user) then raise exception 'No such player.'; end if;
  select e.* into cur from entries e join entry_members m on m.entry_id = e.id where m.user_id = p_user;
  if cur.court = p_court and cur.side = p_side then return; end if;  -- already there
  if side_count(p_court, p_side) + 1 > court_cap(p_court) then raise exception 'That side is full.'; end if;
  if cur.id is null then
    insert into entries (court, side, queue_court) values (p_court, p_side, p_court) returning id into t;
    insert into entry_members (user_id, entry_id) values (p_user, t);
  else
    t := admin_detach(p_user);
    update entries set court = p_court, side = p_side, queue_court = p_court, spot_owner = null,
      streak = case when court = p_court then streak else 0 end where id = t;
  end if;
  perform settle();
end $$;

-- Swap the places of two entries (teams or single players): court side <-> court side, or court <-> line.
create function admin_swap_entries(p_a uuid, p_b uuid) returns void language plpgsql security definer set search_path = public as $$
declare a entries; b entries; sa int; sb int;
begin
  perform need_admin(); perform lock_q();
  select * into a from entries where id = p_a;
  select * into b from entries where id = p_b;
  if a.id is null or b.id is null then raise exception 'That spot just changed. Try again.'; end if;
  if a.id = b.id or (a.court = b.court and a.side = b.side) then return; end if;  -- nothing would change
  sa := entry_size(a.id); sb := entry_size(b.id);
  if b.court is not null and side_count(b.court, b.side) - sb + sa > court_cap(b.court) then
    raise exception 'Not enough room on that side of Court %.', b.court + 1; end if;
  if a.court is not null and side_count(a.court, a.side) - sa + sb > court_cap(a.court) then
    raise exception 'Not enough room on that side of Court %.', a.court + 1; end if;
  if b.court is null and sa > court_cap(b.queue_court) or a.court is null and sb > court_cap(a.queue_court) then
    raise exception 'Teams cannot wait for a singles court.'; end if;
  update entries set court = b.court, side = b.side, queue_court = b.queue_court, seq = b.seq, spot_owner = null,
    streak = case when b.court is not null and b.court = a.court then streak else 0 end where id = a.id;
  update entries set court = a.court, side = a.side, queue_court = a.queue_court, seq = a.seq, spot_owner = null,
    streak = case when a.court is not null and a.court = b.court then streak else 0 end where id = b.id;
  perform settle();
end $$;

-- Practice reset: everyone off every court and out of every queue. The caller must pass 'CLEAR'.
create function admin_reset(p_confirm text) returns void language plpgsql security definer set search_path = public as $$
begin
  perform need_admin();
  if p_confirm is distinct from 'CLEAR' then raise exception 'Type CLEAR to confirm.'; end if;
  perform lock_q();
  delete from entries where true;  -- entry_members go with them ("where true": Supabase refuses a bare DELETE over the API)
end $$;

revoke execute on function admin_players(), admin_seat(int, text, uuid), admin_swap_entries(uuid, uuid), admin_reset(text)
  from public, anon, authenticated;
grant execute on function admin_players(), admin_seat(int, text, uuid), admin_swap_entries(uuid, uuid), admin_reset(text) to authenticated;
