-- A club is a boundary, not a suggestion.
--
-- `members_join` asked one question — is this row about you? — and never
-- looked at `role`. The column is plain text with `check (role in
-- ('admin','player'))`, so 'admin' was always a legal value that no policy
-- inspected. The primary key stops a second row, but `members_leave` lets
-- anyone delete their own, so the whole escalation was two ordinary REST
-- calls with an ordinary member's token:
--
--   delete from club_members where club_id = X and user_id = me
--   insert into club_members (club_id, user_id, role) values (X, me, 'admin')
--
-- `is_club_admin()` gates the squad, the payments, the fixtures, the ratings
-- settlement, the invitations, removing other members, and deleting the club
-- itself. So that second call was the whole club.
--
-- The RPCs were never the problem. `join_club`, the invitation accepts and
-- `create_club` are all `security definer` and all write the right role. They
-- are a front door on a table whose side door was open, and the side door is
-- what RLS is for: the anon key ships inside the app by design, every phone
-- can reach PostgREST directly, and so a policy is the only thing standing
-- between a member and the table.
--
-- Self-service insert is now pinned to 'player'. Becoming an admin is
-- something an existing admin does to you, or something `create_club` does
-- for the person who made the club. There is no third way.

drop policy if exists members_join on public.club_members;

create policy members_join on public.club_members
  for insert with check (
    (user_id = auth.uid() and role = 'player')
    or public.is_club_admin(club_id)
  );

-- The update policy had `using` but no `with check`. Postgres falls back to
-- `using` for the new row, so this was not exploitable — but it was implicit,
-- and a policy whose safety depends on a default is one edit away from not
-- being safe. Said out loud instead.
drop policy if exists members_admin_manage on public.club_members;

create policy members_admin_manage on public.club_members
  for update using (public.is_club_admin(club_id))
  with check (public.is_club_admin(club_id));

-- Leaving stays open to everybody: a member must be able to walk away from a
-- club without asking permission. What changed is that walking back in no
-- longer lets you choose what you come back as.
