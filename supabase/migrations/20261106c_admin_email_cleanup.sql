-- An admin email pasted into the dashboard with a trailing newline silently failed the admin check.
-- Store admin emails trimmed and lowercased, whoever adds them, and compare them the same way.

create function admin_emails_tidy() returns trigger language plpgsql set search_path = public as $$
begin
  new.email := lower(btrim(new.email, E' \t\r\n'));
  if new.email = '' then raise exception 'Enter an email.'; end if;
  return new;
end $$;
create trigger admin_emails_tidy before insert or update on admin_emails for each row execute function admin_emails_tidy();
revoke execute on function admin_emails_tidy() from public, anon, authenticated;

-- tidy existing rows, dropping any that would duplicate a clean one
delete from admin_emails a where a.email <> lower(btrim(a.email, E' \t\r\n'))
  and exists (select 1 from admin_emails b where b.email = lower(btrim(a.email, E' \t\r\n')));
update admin_emails set email = email where email <> lower(btrim(email, E' \t\r\n'));  -- the trigger cleans them

create or replace function is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from auth.users u join admin_emails a on lower(btrim(a.email, E' \t\r\n')) = lower(btrim(u.email, E' \t\r\n'))
                 where u.id = auth.uid() and u.email_confirmed_at is not null) $$;
