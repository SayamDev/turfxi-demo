/**
 * Does the live database refuse a player who tries to edit the score?
 *
 * Two real accounts over the public REST API — the same path the app uses,
 * with the same publishable key. Anything that passes here is true for a
 * modified client too, because the enforcement is in Postgres.
 *
 * Needs email confirmation turned OFF (Authentication -> Providers -> Email),
 * otherwise sign-up returns no session and the accounts cannot act. Turn it
 * back on afterwards if you want it.
 *
 *   npm run check-rls
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);

const URL_ = env.EXPO_PUBLIC_SUPABASE_URL,
  KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const mk = () =>
  createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

let pass = 0;
const fails = [];
const ok = (n, c) =>
  c ? (pass++, console.log(`  ok    ${n}`)) : (fails.push(n), console.log(`  FAIL  ${n}`));

const stamp = Date.now();
const boss = mk(),
  sub = mk();

const signUp = async (c, tag) => {
  const email = `turfxi.rls.${tag}.${stamp}@gmail.com`;
  const { data, error } = await c.auth.signUp({ email, password: `Pw-${stamp}-aA1!` });
  if (error) throw new Error(`${tag}: ${error.message}`);
  if (!data.session)
    throw new Error(
      `${tag}: no session — email confirmation is on, so this test cannot run unattended`,
    );
  return { email, id: data.user.id };
};

const A = await signUp(boss, 'boss');
const B = await signUp(sub, 'sub');
console.log(`\n  two accounts created\n`);

/* Admin makes a club; player joins with the code. */
const { data: clubId, error: ccErr } = await boss.rpc('create_club', {
  payload: { name: `RLS ${stamp}` },
});
ok('admin creates a club', !ccErr && !!clubId);

const { data: club } = await boss.from('clubs').select('join_code').eq('id', clubId).single();
const { error: joinErr } = await sub.rpc('join_club_by_code', { code: club.join_code });
ok('player joins with the code', !joinErr);

const { data: players } = await boss.from('players').select('id,user_id').eq('club_id', clubId);
const bossPid = players.find((p) => p.user_id === A.id)?.id;
const subPid = players.find((p) => p.user_id === B.id)?.id;
ok('both have a player row', !!bossPid && !!subPid);

const { data: fx, error: fxErr } = await boss
  .from('fixtures')
  .insert({ club_id: clubId, date: '2026-08-09' })
  .select('id')
  .single();
ok('admin creates a fixture', !fxErr && !!fx?.id);

/* ---- the rule ---- */
console.log('\n  the score:');
const { error: goalOk } = await boss
  .from('match_events')
  .insert({ fixture_id: fx.id, kind: 'goal', team: 'A', player_id: bossPid, minute: 12 });
ok('ADMIN can record a goal', !goalOk);

const { error: goalDenied } = await sub
  .from('match_events')
  .insert({ fixture_id: fx.id, kind: 'goal', team: 'B', player_id: subPid, minute: 20 });
ok('PLAYER cannot record a goal', !!goalDenied);

const { data: delRows } = await sub.from('match_events').delete().eq('fixture_id', fx.id).select();
ok("PLAYER cannot delete the admin's goal", (delRows ?? []).length === 0);

const { data: updRows } = await sub
  .from('fixtures')
  .update({ started: true, finished: true })
  .eq('id', fx.id)
  .select();
ok('PLAYER cannot kick off or end the match', (updRows ?? []).length === 0);

const { data: sees } = await sub.from('match_events').select('id').eq('fixture_id', fx.id);
ok('player CAN see the score', (sees ?? []).length === 1);

/* ---- own answer only ---- */
console.log('\n  own answer only:');
const { error: myRsvp } = await sub
  .from('rsvps')
  .insert({ fixture_id: fx.id, player_id: subPid, answer: 'in' });
ok('player can RSVP for themselves', !myRsvp);
const { error: theirRsvp } = await sub
  .from('rsvps')
  .insert({ fixture_id: fx.id, player_id: bossPid, answer: 'out' });
ok('player cannot RSVP for a team-mate', !!theirRsvp);

const { error: myRating } = await sub
  .from('ratings')
  .insert({ fixture_id: fx.id, voter_id: subPid, rated_id: bossPid, mark: 7 });
ok('player can submit their own ratings', !myRating);
const { error: theirRating } = await sub
  .from('ratings')
  .insert({ fixture_id: fx.id, voter_id: bossPid, rated_id: subPid, mark: 1 });
ok('player cannot submit ratings as someone else', !!theirRating);

const { error: payErr } = await sub
  .from('payments')
  .insert({ fixture_id: fx.id, player_id: subPid, amount: 10, paid: true });
ok('player cannot mark a fee as paid', !!payErr);

const { data: clubUpd } = await sub
  .from('clubs')
  .update({ name: 'Hijacked' })
  .eq('id', clubId)
  .select();
ok('player cannot rename the club', (clubUpd ?? []).length === 0);

/* ---- escalation ---- */
/* The one that mattered. `members_join` used to ask only whether the row was
   about you, and `members_leave` lets anyone walk out, so leaving and coming
   back as an admin was two ordinary calls with an ordinary token. Both halves
   are checked: the plain rejoin must still work, because a member who leaves
   has to be able to come back. */
console.log('\n  escalation:');

const { error: promoteInPlace } = await sub
  .from('club_members')
  .update({ role: 'admin' })
  .eq('club_id', clubId)
  .eq('user_id', B.id);
ok(
  'player cannot promote themselves in place',
  !!promoteInPlace ||
    (
      await sub
        .from('club_members')
        .select('role')
        .eq('club_id', clubId)
        .eq('user_id', B.id)
        .single()
    ).data?.role === 'player',
);

await sub.from('club_members').delete().eq('club_id', clubId).eq('user_id', B.id);

const { error: rejoinAsAdmin } = await sub
  .from('club_members')
  .insert({ club_id: clubId, user_id: B.id, role: 'admin' });
ok('player cannot rejoin as an admin', !!rejoinAsAdmin);

const { error: rejoinAsPlayer } = await sub
  .from('club_members')
  .insert({ club_id: clubId, user_id: B.id, role: 'player' });
ok('player can still rejoin as a player', !rejoinAsPlayer);

const { data: afterRejoin } = await sub
  .from('club_members')
  .select('role')
  .eq('club_id', clubId)
  .eq('user_id', B.id)
  .single();
ok('and comes back as a player', afterRejoin?.role === 'player');

/* ---- outsiders ---- */
console.log('\n  outsiders:');
const stranger = mk();
const C = await signUp(stranger, 'stranger');
ok(
  'stranger cannot see the club',
  ((await stranger.from('clubs').select('id').eq('id', clubId)).data ?? []).length === 0,
);
ok(
  'stranger cannot see the score',
  ((await stranger.from('match_events').select('id').eq('fixture_id', fx.id)).data ?? []).length ===
    0,
);
ok(
  'stranger cannot see the squad',
  ((await stranger.from('players').select('id').eq('club_id', clubId)).data ?? []).length === 0,
);

/* Clean up what we can. RLS means only the admin can remove the club. */
await boss.from('clubs').delete().eq('id', clubId);

console.log(`\n  ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  fails.forEach((f) => console.log('   - ' + f));
  process.exit(1);
}
console.log('  Permission model holds against the live database.\n');
console.log(
  `  Test accounts to delete in Auth -> Users:\n    ${A.email}\n    ${B.email}\n    ${C.email}\n`,
);
