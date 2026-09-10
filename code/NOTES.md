# Notes on the selected source

Each file here was picked because it shows a decision, not just working code.

## `domain/workflow.ts`
The state machine behind a matchday: what the club is being asked to do next,
who may do it, what unlocks when. Screens render it; they do not decide it.

## `sync/freshness.ts`
Incremental sync. The original pull asked for the club's whole history every
time. Ratings are one row per rater per rated player, so a ten-a-side match
writes ~90 and a season reaches ~3,600 — and a goal in a live match had ten
phones each downloading the season. Child rows are now fetched only for
matches that could have changed. The remaining trade-off is written down in
the file rather than left to be discovered.

## `sync/outbox.ts`
Queued writes and how they reconcile. At-least-once delivery is assumed;
nothing relies on a queue promising exactly-once, because no queue can promise
that across a consumer crash.

## `sync/client.ts`
Session storage. The refresh token belongs in the keychain, but iOS SecureStore
caps a value at 2048 bytes and a Supabase session carrying a Google identity
can exceed it. The original code fell back to unencrypted AsyncStorage above
the cap — silently, so nobody could know which store held their token. It now
splits the value across numbered keychain entries and migrates whatever the old
path left behind.

## `errors.ts`
Crash reporting without an SDK, and an explicit statement of what that buys and
what it costs: JavaScript errors yes, native crashes no. The reasoning is in
the file because the next person needs the reasoning, not the conclusion.

## `tests/rules.ts`
283 of the 950 assertions. The useful ones are the plausible-but-wrong: an own
goal counting as a goal, a match still in play setting a record, a fastest goal
resolved as a maximum, a tie broken by whatever order an array happened to be
in.

## `match-report-edge-function.ts`
Server-side by necessity — an API key inside a React Native bundle is a key
given away. It reads with the caller's own JWT so row-level security applies
exactly as it does in the app, and uses the service role only for the write the
caller is not permitted to make.

## `security/` — a real vulnerability and its fix

**`0027_membership_role_guard.sql`** closes a privilege escalation. The insert
policy on club memberships checked *who* a row was about and never looked at
the `role` column, while a separate policy let anyone delete their own
membership. Two ordinary REST calls with an ordinary member's token — leave,
rejoin as `admin` — took over the club, its payment records, and its ability to
delete itself.

**`0028`** fixes a spend limit that counted finished rows *before* calling a
paid API, so concurrent callers all passed the same check and the ceiling was
the caller's concurrency rather than the limit. It now claims a row first and
lets a partial unique index pick the winner: the constraint is the mechanism,
because a `select` the caller hopes nobody raced is not a guard.

**`check-rls.mjs`** is the part that matters most. It drives two real accounts
over the public REST API with the shipped key, so anything it passes is true
for a modified client too. It also found its own bug — it had been reading
`.env` from the wrong directory since the day it was written, and had therefore
never run at all. Every claim resting on it had been resting on nothing.

## Testing and CI

Five gates on every push, in parallel, about 90 seconds: lint, type check, 950
assertions, a web export that proves the whole graph still bundles, and
`npm audit`.

The audit gate is deliberately split — critical fails the build, high reports
only. Every outstanding high-severity advisory is in the Expo build toolchain
and unfixable without an SDK major, and a gate that cannot go green is a gate
everyone learns to scroll past.
