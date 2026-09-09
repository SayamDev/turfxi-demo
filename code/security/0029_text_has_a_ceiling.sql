-- Every text column was unbounded.
--
-- Postgres `text` has no length limit, and nothing above it imposed one. RLS
-- decides *who* may write a row and says nothing about what fits in it, so a
-- member could put fifty megabytes into a banter message, a club name, or the
-- notes on a fixture. That is three problems in one write:
--
--   the row syncs to every phone in the club, on a pull nobody asked for
--   it counts against the project's egress every time it does
--   and a screen built for a sentence gets a novel
--
-- No attack is needed. One person pasting something large by accident does it.
--
-- The ceilings below are generous on purpose — comfortably more than any real
-- name, address or message, so nobody meets one while using the app properly.
-- They exist to stop the shape of a value being unbounded, not to police what
-- people write.
--
-- `not valid` on the constraints for tables that already hold rows: it applies
-- to every write from now on without a full scan of what is already there, and
-- nothing existing is anywhere near these limits. Validate later if you want
-- the guarantee to cover history too:
--
--   alter table public.banter validate constraint banter_text_len;

-- Re-runnable: a constraint that already exists is dropped and re-added,
-- so pasting this twice is not an error.

alter table public.profiles drop constraint if exists profiles_name_len;
alter table public.profiles drop constraint if exists profiles_email_len;
alter table public.players drop constraint if exists players_name_len;
alter table public.players drop constraint if exists players_photo_len;
alter table public.players drop constraint if exists players_crest_len;
alter table public.clubs drop constraint if exists clubs_name_len;
alter table public.clubs drop constraint if exists clubs_venue_len;
alter table public.clubs drop constraint if exists clubs_address_len;
alter table public.clubs drop constraint if exists clubs_bank_len;
alter table public.clubs drop constraint if exists clubs_forfeits_len;
alter table public.fixtures drop constraint if exists fixtures_venue_len;
alter table public.fixtures drop constraint if exists fixtures_address_len;
alter table public.fixtures drop constraint if exists fixtures_notes_len;
alter table public.banter drop constraint if exists banter_text_len;
alter table public.notifications drop constraint if exists notifications_len;

-- People ------------------------------------------------------------------
alter table public.profiles
  add constraint profiles_name_len check (char_length(name) <= 80) not valid,
  add constraint profiles_email_len check (email is null or char_length(email) <= 320) not valid;

alter table public.players
  add constraint players_name_len check (char_length(name) <= 80) not valid,
  -- A photo is a storage path and a crest is a short key, not a data URI. If
  -- either ever needs to be longer than this, something is being inlined that
  -- should be in a bucket.
  add constraint players_photo_len check (photo is null or char_length(photo) <= 500) not valid,
  add constraint players_crest_len check (crest is null or char_length(crest) <= 100) not valid;

-- The club ----------------------------------------------------------------
alter table public.clubs
  add constraint clubs_name_len check (char_length(name) <= 80) not valid,
  add constraint clubs_venue_len check (char_length(venue) <= 200) not valid,
  add constraint clubs_address_len check (char_length(address) <= 300) not valid,
  -- Bank details are short by nature and are the last place a wall of text
  -- belongs, given who reads them and why.
  add constraint clubs_bank_len check (
    char_length(bank_name) <= 100
    and char_length(bank_sort) <= 20
    and char_length(bank_acct) <= 40
  ) not valid,
  -- Twenty forfeits, none longer than a line. The array had no ceiling on
  -- either count or contents.
  add constraint clubs_forfeits_len check (
    forfeits is null
    or (array_length(forfeits, 1) is null or array_length(forfeits, 1) <= 20)
  ) not valid;

-- The match ---------------------------------------------------------------
alter table public.fixtures
  add constraint fixtures_venue_len check (char_length(venue) <= 200) not valid,
  add constraint fixtures_address_len check (char_length(address) <= 300) not valid,
  add constraint fixtures_notes_len check (notes is null or char_length(notes) <= 2000) not valid;

-- What people say ---------------------------------------------------------
-- The one most likely to be met in ordinary use, and still four times longer
-- than a post anybody writes on a phone at a five-a-side pitch.
alter table public.banter
  add constraint banter_text_len check (char_length(text) <= 1000) not valid;

alter table public.notifications
  add constraint notifications_len check (
    char_length(title) <= 200
    and (body is null or char_length(body) <= 1000)
    and (link is null or char_length(link) <= 500)
    and (icon is null or char_length(icon) <= 60)
  ) not valid;
