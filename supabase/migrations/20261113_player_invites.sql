-- Player pairing is opt-in. Keep old pending invites readable and actionable.
create function can_invite_player(p_user uuid) returns boolean
language sql stable set search_path = public as $$
  select exists (select 1 from auth.users where id = p_user and email_confirmed_at is not null)
    and not exists (
      select 1 from entry_members m join entries e on e.id = m.entry_id
      where m.user_id = p_user
        and (e.court is not null or entry_size(e.id) <> 1 or court_cap(e.queue_court) < 2)
    ) $$;

create function invite_candidates() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare u uuid := need_user();
begin
  if not can_invite_player(u) then return '[]'::jsonb; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name)
      order by lower(p.name), p.id), '[]'::jsonb)
    from profiles p
    where p.id <> u and can_invite_player(p.id)
      and not exists (
        select 1 from invites i
        where (i.from_user = u and i.to_user = p.id) or (i.from_user = p.id and i.to_user = u)
      )
  );
end $$;

create function invite_player(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := need_user();
begin
  perform lock_q();
  if not can_invite_player(u) then raise exception 'You must be off court, unpaired, and outside a singles queue to invite a teammate.'; end if;
  if p_user is null or p_user = u or not can_invite_player(p_user) then
    raise exception 'That player is no longer available to invite.';
  end if;
  perform send_invite(p_user => p_user);
end $$;

create or replace function respond_invite(p_id uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := need_user(); inv invites; n int;
begin
  perform lock_q();
  select * into inv from invites where id = p_id and to_user = u;
  if inv.id is null then raise exception 'Invite not found.'; end if;
  if p_accept is null then raise exception 'Choose whether to accept the invite.'; end if;
  if not p_accept then delete from invites where id = p_id; return; end if;
  if inv.court is not null then
    select courts_count into n from settings;
    if inv.court < 0 or inv.court >= n then raise exception 'No such court.'; end if;
    if court_cap(inv.court) < 2 then raise exception 'Pairs cannot play on a singles court.'; end if;
    if side_count(inv.court, inv.side) > 0 then raise exception 'That side no longer has two open spots.'; end if;
    perform pair_up(inv.from_user, u);
    update entries set court = inv.court, side = inv.side, queue_court = inv.court, streak = 0
      where id = (select entry_id from entry_members where user_id = u);
  else
    if not can_invite_player(inv.from_user) or not can_invite_player(u) then
      raise exception 'Both players must be off court, unpaired, and outside a singles queue to team up.';
    end if;
    perform pair_up(inv.from_user, u);
  end if;
  perform settle();
end $$;

-- Serialize cancellation with acceptance, so only one transition can win.
create or replace function cancel_invite(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := need_user();
begin
  perform lock_q();
  delete from invites where id = p_id and from_user = u;
  if not found then raise exception 'Invite not found.'; end if;
end $$;

revoke execute on function can_invite_player(uuid), invite_candidates(), invite_player(uuid),
  send_invite(text, uuid, int, text), join_team(uuid) from public, anon, authenticated;
grant execute on function invite_candidates(), invite_player(uuid) to authenticated;
