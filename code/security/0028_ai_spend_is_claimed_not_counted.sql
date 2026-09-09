-- Counting what has finished cannot limit what is starting.
--
-- The spend guard read `ai_generations`, compared against 20 per club and 6
-- per person per hour, and only then called the model. The row it counted was
-- written afterwards. So the limit bounded sequential use and nothing else:
-- three hundred requests fired at once all read the same count, all passed,
-- and all reached the model. The ceiling was the attacker's concurrency.
--
-- Worse, a call that timed out, errored, or whose insert failed — the code
-- logged and carried on — cost money and was never counted at all. Every call
-- has three outcomes, and 'unknown' was being filed under 'never happened'.
--
-- So the row is now written *before* the model is called, and the count
-- includes rows still in flight. An attempt is recorded the moment it is an
-- attempt, which is the only point at which recording it prevents anything.
--
--   pending    claimed, model not yet answered
--   succeeded  written and stored
--   failed     refused, malformed, over limit, or abandoned
--
-- `succeeded` is the default so every existing row keeps its meaning without
-- a backfill.

alter table public.ai_generations
  add column if not exists state text not null default 'succeeded'
    check (state in ('pending', 'succeeded', 'failed'));

-- `body` is `not null` and a pending row has nothing to say yet, so it is
-- claimed with an empty string rather than relaxing the column. The read
-- policy below is what stops that emptiness ever reaching a screen.
--
-- One report per fixture may be in flight at a time. This is the part that
-- actually holds under a burst: a unique index is evaluated by Postgres, not
-- by a `select` the caller hopes nobody raced. The second concurrent request
-- for the same match loses the insert and is told to come back, rather than
-- buying a second copy of a report the first one is already paying for.
create unique index if not exists ai_generations_one_in_flight
  on public.ai_generations (fixture_id, kind)
  where state = 'pending';

-- Counting the last hour, per club and per person, including what is still in
-- flight. Partial so it stays small — old rows are not part of any limit.
create index if not exists ai_generations_recent
  on public.ai_generations (club_id, created_by, created_at desc)
  where state in ('pending', 'succeeded');

-- Readers see finished reports only. A pending row is an empty body and a
-- failed one is a row that exists to be counted, not read; neither is a match
-- report, and the app should not have to know the difference.
drop policy if exists ai_read on public.ai_generations;

create policy ai_read on public.ai_generations
  for select using (public.is_club_member(club_id) and state = 'succeeded');
