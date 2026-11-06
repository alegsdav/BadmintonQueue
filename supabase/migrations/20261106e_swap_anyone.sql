-- Admin "Swap with…" picks from every account: swapping with someone who isn't signed up hands them the spot.

create or replace function admin_swap(p_a uuid, p_b uuid) returns void language plpgsql security definer set search_path = public as $$
declare ea entries; eb entries; spot uuid;
begin
  perform need_admin(); perform lock_q();
  if p_a is null or p_b is null or p_a = p_b then raise exception 'Choose two different players.'; end if;
  if (select count(*) from profiles where id in (p_a, p_b)) < 2 then raise exception 'No such player.'; end if;
  select e.* into ea from entries e join entry_members m on m.entry_id = e.id where m.user_id = p_a;
  select e.* into eb from entries e join entry_members m on m.entry_id = e.id where m.user_id = p_b;
  if ea.id is null and eb.id is null then raise exception 'Neither player has a spot.'; end if;
  if ea.id = eb.id then return; end if;  -- same team: nothing to swap
  if ea.id is not null and eb.id is not null then
    -- both have a spot: each takes over the other's, partner included
    update entry_members set entry_id = case when user_id = p_a then eb.id else ea.id end where user_id in (p_a, p_b);
    update entries set spot_owner = null,
      streak = case when ea.court is not distinct from eb.court then streak else 0 end where id in (ea.id, eb.id);
  else
    -- one is not signed up: they take the other's spot (and partner), and the other leaves
    spot := coalesce(ea.id, eb.id);
    update entry_members set user_id = case when user_id = p_a then p_b else p_a end, joined = clock_timestamp()
      where user_id in (p_a, p_b);
    update entries set spot_owner = null, streak = 0 where id = spot;
    delete from invites where from_user in (p_a, p_b) or to_user in (p_a, p_b);
  end if;
  perform settle();
end $$;
