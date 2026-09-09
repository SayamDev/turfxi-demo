# TurfXI — engineering case study

A Sunday-league football club app: fixtures, RSVPs, live match events, player
ratings, team-of-the-week, payments and an AI-written match report. React
Native (Expo) on iOS and Android, Postgres on Supabase.

**▶ Live demo** — *(link added once Pages is live)* — runs entirely in your
browser, no sign-up.

This repository is a **portfolio extract**, not the product. It holds a built
demo, a selection of source files chosen to show how the system is put
together, and the notes below. The application itself is private.

<p align="center"><img src="screenshots/login-ios.png" width="270" alt="TurfXI sign-in screen running on iOS"></p>

---

## The shape of the problem

A club app is mostly a synchronisation problem wearing a football shirt.
Eleven people stand on a pitch with bad signal and all of them are writing:
RSVPs, goals, ratings, banter. Any of those writes can happen offline, twice,
or from a phone whose copy of the match is ten minutes stale.

Three decisions follow from that, and most of the code is downstream of them.

**The device owns a full copy.** Screens read local state and never wait on a
network call — which is why there is not a single loading spinner in the app.
Writes queue in an outbox and reconcile later.

**The database is the security boundary, not the app.** The anon key ships
inside the bundle by design and can be read out of any installed copy, so
every rule that matters is a row-level-security policy in Postgres. A modified
client is assumed, not defended against.

**Domain logic is pure and separate.** Who may set a lineup, when ratings
close, how a record is beaten — plain functions over plain data, no React, no
network. That is what makes them testable, and they carry 950 assertions.

---

## Selected source

Each file was picked because it shows a decision, not just working code.

**`code/domain/workflow.ts`** — the state machine behind a matchday: what the
club is being asked to do next, who may do it, what unlocks when. Screens
render it; they do not decide it.

**`code/sync/freshness.ts`** — incremental sync. The original pull asked for
the club's whole history every time. Ratings are one row per rater per rated
player, so a ten-a-side match writes ~90 and a season reaches ~3,600 — and a
goal in a live match had ten phones each downloading the season. Child rows
are now fetched only for matches that could have changed. The remaining
trade-off is written down in the file rather than left to be discovered.

**`code/sync/outbox.ts`** — queued writes and how they reconcile.
At-least-once delivery is assumed; nothing relies on a queue promising
exactly-once, because no queue can promise that across a consumer crash.

**`code/sync/client.ts`** — session storage. The refresh token belongs in the
keychain, but iOS SecureStore caps a value at 2048 bytes and a Supabase
session carrying a Google identity can exceed it. The original code fell back
to unencrypted AsyncStorage above the cap, silently, so nobody could know
which store held their token. It now splits the value across numbered keychain
entries and migrates whatever the old path left behind.

**`code/errors.ts`** — crash reporting without an SDK, and an unusually
explicit statement of what that buys and what it costs: JavaScript errors yes,
native crashes no. The reasoning is in the file because the next person needs
the reasoning, not the conclusion.

**`code/tests/rules.ts`** — 283 of the 950 assertions. The useful ones are the
plausible-but-wrong: an own goal counting as a goal, a match still in play
setting a record, a fastest goal resolved as a maximum, a tie broken by
whatever order an array happened to be in.

**`code/match-report-edge-function.ts`** — server-side by necessity, since an
API key inside a React Native bundle is a key given away. It reads with the
caller's own JWT so row-level security applies exactly as it does in the app,
and uses the service role only for the write the caller is not permitted to
make.

### `code/security/` — a real vulnerability and its fix

**`0027_membership_role_guard.sql`** closes a privilege escalation. The insert
policy on club memberships checked *who* a row was about and never looked at
the `role` column, while a separate policy let anyone delete their own
membership. Two ordinary REST calls with an ordinary member's token — leave,
rejoin as `admin` — took over the club, its payment records, and its ability
to delete itself.

**`0028`** fixes a spend limit that counted finished rows *before* calling a
paid API, so concurrent callers all passed the same check and the ceiling was
the attacker's concurrency. It now claims a row first and lets a partial
unique index pick the winner: the constraint is the mechanism, because a
`select` the caller hopes nobody raced is not a guard.

**`check-rls.mjs`** is the part that matters most. It drives two real accounts
over the public REST API with the shipped key, so anything it passes is true
for a modified client too. It also found its own bug — it had been reading
`.env` from the wrong directory since the day it was written, and had
therefore never run at all. Every claim resting on it had been resting on
nothing.

---

## Testing and CI

Five gates on every push, in parallel, about 90 seconds:

| Gate | What it runs |
|---|---|
| Lint | ESLint, errors blocking |
| Type check | `tsc --noEmit`, strict |
| Tests | 950 assertions across four suites |
| Build | web export — proves the whole graph still bundles |
| Audit | `npm audit`, critical blocking |

The audit gate is deliberately split: critical fails the build, high reports
only. Every outstanding high-severity advisory is in the Expo build toolchain
and unfixable without an SDK major, and a gate that cannot go green is a gate
everyone learns to scroll past.

---

## The demo

`demo/` is a static export built with no backend configured. The app detects
that and runs in local demo mode against seeded data — real screens, real
navigation, real rules, no server. It contains no keys, no project
identifiers and no source maps.

---

## Not included

The application source, the design system and artwork, the migration history,
and anything identifying the live project. Happy to walk through any of it in
conversation.
