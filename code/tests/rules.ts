/**
 * The rules the club is entitled to rely on.
 *
 * Not "does this function return a number" — these are the promises the app
 * makes to a group of people who will use it every week and fall out about the
 * result. A vote that can be changed after seeing the tally, a score that
 * disagrees with the timeline, a waitlist that quietly reorders itself: each of
 * those is a Sunday-morning argument, and none of them would crash anything.
 *
 * Pure data in, pure assertions out, so it runs under plain Node: npm test
 */
import {
  score,
  matchPhase,
  teamOf,
  lastUndoable,
  cardCount,
  bookings,
  sendingsOff,
  isSecondYellow,
  isSuspended,
  suspendedNow,
  canRunFixture,
} from '../src/core/domain/match';
import { rsvpLists, detectPromotion } from '../src/core/domain/waitlist';
import { motmStatus } from '../src/core/domain/motm';
import { matchState } from '../src/core/domain/participation';
import {
  ratingWindow,
  REMINDERS,
  RATING_WINDOW_MS,
  consensusRows,
  consensusReady,
  trustedProgress,
  eligibleTrusted,
} from '../src/core/domain/consensus';
import { tierOf, tierProgress, SEASON_START } from '../src/core/domain/rating';
import {
  RECORDS,
  clubRecords,
  matchBests,
  matchLines,
  recordValue,
  type RecordId,
} from '../src/core/domain/records';
import {
  DUEL_CATEGORIES,
  categoriesFor,
  duelBetween,
  formPoints,
  headToHead,
  topDuel,
} from '../src/core/domain/duel';
import { ACHIEVEMENTS, achievementCtx, achievementsFor } from '../src/core/domain/achievements';
import type { AppState, Fixture, Player, Position } from '../src/core/types';

let pass = 0;
const fails: string[] = [];
const ok = (n: string, c: boolean) => (c ? pass++ : fails.push(n));
const eq = (n: string, a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b)
    ? pass++
    : fails.push(`${n}\n     got ${JSON.stringify(a)}\n     want ${JSON.stringify(b)}`);

const player = (id: string, over: Partial<Player> = {}): Player => ({
  id,
  name: id,
  pos: 'MID',
  shirt: 9,
  admin: false,
  captain: false,
  color: '#fff',
  joinedAt: 0,
  pending: false,
  rating: SEASON_START,
  ratingHist: [],
  formDelta: 0,
  bestRating: SEASON_START,
  totwCount: 0,
  starCount: 0,
  totsCount: 0,
  ...over,
});

const P = ['a', 'b', 'c', 'd', 'e'].map((x) => player('p' + x));

const baseFixture = (over: Partial<Fixture> = {}): Fixture => ({
  id: 'f1',
  date: '2026-08-02',
  time: '19:00',
  venue: 'Hyde',
  address: '',
  durationMin: 50,
  halfMin: 25,
  maxPlayers: 4,
  fee: 40,
  repeat: false,
  notes: '',
  rsvps: {},
  flow: { confirmed: false, revealed: false },
  teams: null,
  predictions: {},
  match: { events: [], periods: [], started: false, finished: false },
  motm: { open: false, closesAt: 0, votes: {}, winner: null },
  ratings: { open: false, ratedBy: {}, results: null },
  honours: null,
  pay: {},
  wheel: { spun: false, result: null },
  banter: [],
  ...over,
});

const st = (fx: Fixture, players: Player[] = P): AppState =>
  ({ players, fixtures: [fx] }) as unknown as AppState;

/* ================================================================= score */
{
  const fx = baseFixture({
    teams: {
      A: { ids: ['pa', 'pb'], cap: 'pa', name: 'A', color: '#f00', formation: '', pos: {} },
      B: { ids: ['pc', 'pd'], cap: 'pc', name: 'B', color: '#00f', formation: '', pos: {} },
    },
    match: {
      started: true,
      finished: false,
      periods: [{ start: 0, end: null }],
      events: [
        { id: '1', t: 'goal', team: 'A', pid: 'pa', min: 1, at: 1 },
        { id: '2', t: 'pen', team: 'B', pid: 'pc', min: 2, at: 2 },
        /* `team` on an own goal is the *scorer's* side, and the goal counts
           for the opposition. Getting this backwards would put a goal on the
           wrong end of the scoreboard, which is the single most expensive
           thing this file can fail to notice. */
        { id: '3', t: 'own', team: 'A', pid: 'pa', min: 3, at: 3 },
        { id: '4', t: 'yellow', team: 'A', pid: 'pb', min: 4, at: 4 },
        { id: '5', t: 'red', team: 'B', pid: 'pd', min: 5, at: 5 },
        { id: '6', t: 'sub', team: 'A', pid: 'pe', off: 'pb', min: 6, at: 6 },
      ],
    },
  });

  eq('the score is derived only from goals', score(fx), [1, 2]);
  ok('cards never touch the score', score(fx)[0] + score(fx)[1] === 3);
  ok('an own goal is credited to the other side', score(fx)[1] === 2);

  const cc = cardCount(fx);
  eq('yellow cards are counted per side', [cc.A.y, cc.B.y], [1, 0]);
  eq('and so are reds', [cc.A.r, cc.B.r], [0, 1]);
  /* Newest first — the home card shows the most recent bookings. */
  eq(
    'bookings list both, newest first',
    bookings(fx).map((b) => b.pid),
    ['pd', 'pb'],
  );

  /* -------------------------------------------------- two yellows is a red */

  const disc = baseFixture({
    match: {
      started: true,
      finished: false,
      periods: [{ start: 0, end: null }],
      events: [
        { id: 'y1', t: 'yellow', team: 'A', pid: 'pa', min: 10, at: 10 },
        { id: 'y2', t: 'yellow', team: 'A', pid: 'pb', min: 12, at: 12 },
        /* pa's second. This is the one that sends him off. */
        { id: 'y3', t: 'yellow', team: 'A', pid: 'pa', min: 20, at: 20 },
        { id: 'r1', t: 'red', team: 'B', pid: 'pd', min: 30, at: 30 },
      ],
    },
  });

  const off = sendingsOff(disc);
  eq('two yellows send a player off', off.map((o) => o.pid).sort(), ['pa', 'pd']);
  eq(
    'and it is recorded as a second yellow, not a straight red',
    off.find((o) => o.pid === 'pa')?.reason,
    'second-yellow',
  );
  /* The minute of the *second* card, not the first — a sin bin counts from
     when the player actually walks. */
  eq('sent off at the minute of the second booking', off.find((o) => o.pid === 'pa')?.min, 20);
  ok('one yellow is not a sending-off', !off.some((o) => o.pid === 'pb'));

  /* Asked before the card is recorded, so the match centre can announce a red
     rather than announcing a yellow and correcting itself. */
  ok('a booked player is one yellow from a red', isSecondYellow(disc, 'pb'));
  ok('an unbooked player is not', !isSecondYellow(disc, 'pc'));
  ok('an already-sent-off player does not re-trigger', !isSecondYellow(disc, 'pa'));

  /* No sin bin configured: a sending-off is the rest of the match. */
  ok('without a sin bin, off means off', isSuspended(disc, 'pa', 90, 0));
  ok('a straight red is off for the rest of it too', isSuspended(disc, 'pd', 90, 0));
  ok('nobody else is suspended', !isSuspended(disc, 'pb', 90, 0));

  /* Ten-minute sin bin: out from minute 20, back at 30. */
  ok('in the bin during the punishment', isSuspended(disc, 'pa', 25, 10));
  ok('back on once it has run', !isSuspended(disc, 'pa', 30, 10));
  ok('and not a minute early', isSuspended(disc, 'pa', 29, 10));
  /* A straight red is never binned — the sin bin softens the two-yellow case,
     and applying it to a deliberate red would make the worst offence carry the
     lighter punishment. */
  ok('a straight red ignores the sin bin', isSuspended(disc, 'pd', 90, 10));
  eq('suspended list at minute 25', suspendedNow(disc, 25, 10).sort(), ['pa', 'pd']);
  eq('and at minute 35, only the red', suspendedNow(disc, 35, 10), ['pd']);

  /* ------------------------------------------------------- the stand-in */

  /* The admin cannot always be there, so the role can be lent for one match.
     What must never happen is it widening into anything else. */
  const lent = baseFixture({ standIn: 'pb' });
  ok('the club admin can always run the match', canRunFixture(lent, 'pa', true));
  ok('so can the named stand-in', canRunFixture(lent, 'pb', false));
  ok('nobody else can', !canRunFixture(lent, 'pc', false));

  const unlent = baseFixture({});
  ok('with nobody named, only the admin runs it', canRunFixture(unlent, 'pa', true));
  ok('and a non-admin does not', !canRunFixture(unlent, 'pb', false));
  /* The stand-in is per fixture. Being named on one match grants nothing on
     the next, which is the whole point of putting it on the fixture row. */
  ok('a stand-in on one fixture is not one on another', !canRunFixture(unlent, 'pb', false));
  /* A signed-out or unlinked person has no player id; they are not a
     stand-in by accident of both being null. */
  ok(
    'a missing player id is never a stand-in',
    !canRunFixture(baseFixture({ standIn: null }), null, false),
  );

  /* Undo removes the last thing a human entered — never a whistle, which is
     what phase is derived from. */
  const last = lastUndoable(fx);
  ok('undo offers the most recent recorded event', last?.id === '6');

  const whistlesOnly = baseFixture({
    match: {
      started: true,
      finished: false,
      periods: [{ start: 0, end: null }],
      events: [{ id: 'k', t: 'ko', min: 0, at: 0 }],
    },
  });
  ok('a kick-off whistle is not undoable', lastUndoable(whistlesOnly) === null);

  eq('team lookup finds a player', teamOf(fx, 'pc'), 'B');
  eq('and reports nothing for a spectator', teamOf(fx, 'pz'), null);
}

/* ============================================================ match phase */
{
  const at = (
    periods: { start: number; end: number | null }[],
    started: boolean,
    finished: boolean,
  ) => baseFixture({ match: { events: [], periods, started, finished } });

  eq('not started', matchPhase(at([], false, false)), 'pre');
  eq('first half', matchPhase(at([{ start: 0, end: null }], true, false)), 'h1');
  eq('half time', matchPhase(at([{ start: 0, end: 1 }], true, false)), 'ht');
  eq(
    'second half',
    matchPhase(
      at(
        [
          { start: 0, end: 1 },
          { start: 2, end: null },
        ],
        true,
        false,
      ),
    ),
    'h2',
  );
  eq(
    'full time wins over any period shape',
    matchPhase(at([{ start: 0, end: null }], true, true)),
    'ft',
  );
}

/* ============================================================== waitlist */
{
  /* Four spots. Five people say yes, in a known order. */
  const fx = baseFixture({
    maxPlayers: 4,
    rsvps: {
      pa: { r: 'in', at: 100 },
      pb: { r: 'in', at: 200 },
      pc: { r: 'in', at: 300 },
      pd: { r: 'in', at: 400 },
      pe: { r: 'in', at: 500 },
    },
  });
  const l = rsvpLists(st(fx), fx);
  eq('the first four in are playing', l.playing, ['pa', 'pb', 'pc', 'pd']);
  eq('the fifth waits', l.waitlist, ['pe']);
  ok('order is by when they answered, not by id', l.ins[0] === 'pa' && l.ins[4] === 'pe');

  /* Somebody drops out; the next in line comes in. */
  const after = baseFixture({
    maxPlayers: 4,
    rsvps: { ...fx.rsvps, pb: { r: 'out', at: 600 } },
  });
  const l2 = rsvpLists(st(after), after);
  eq('a withdrawal promotes the next player', l2.playing, ['pa', 'pc', 'pd', 'pe']);
  eq('and the promotion is detectable', detectPromotion(l, l2), 'pe');
  ok('nobody is promoted when nothing changed', detectPromotion(l, l) === null);

  /* Nobody who never answered is counted as anything but silent. */
  const quiet = baseFixture({ rsvps: { pa: { r: 'in', at: 1 } } });
  const l3 = rsvpLists(st(quiet), quiet);
  eq('the silent are listed as such', l3.none.sort(), ['pb', 'pc', 'pd', 'pe']);
  ok('maybes are not playing', l3.playing.length === 1);

  /* A pending member has not joined properly and must not appear as silent —
     this is what once hid new joiners from the whole squad screen. */
  const withPending = st(quiet, [...P, player('pz', { pending: true })]);
  ok(
    'a pending player is not chased for an answer',
    !rsvpLists(withPending, quiet).none.includes('pz'),
  );
}

/* ================================================================== motm */
{
  const teams = {
    A: { ids: ['pa', 'pb'], cap: 'pa', name: 'A', color: '#f00', formation: '', pos: {} },
    B: { ids: ['pc', 'pd'], cap: 'pc', name: 'B', color: '#00f', formation: '', pos: {} },
  };
  const soon = Date.now() + 60_000;

  const open = baseFixture({
    teams,
    match: { events: [], periods: [], started: true, finished: true },
    motm: { open: true, closesAt: soon, votes: { pa: 'pc' }, winner: null },
  });
  const m = motmStatus(st(open), open);
  ok('only players who played are eligible', m.eligible.length === 4);
  eq('outstanding excludes whoever voted', m.outstanding.sort(), ['pb', 'pc', 'pd']);
  ok('the vote is open', m.open);
  ok('one vote is enough to be closeable', m.canClose);

  /* A spectator's vote must never count towards "everyone has voted" — that
     is how a vote used to settle with players still to be asked. */
  const stray = baseFixture({
    ...open,
    motm: { open: true, closesAt: soon, votes: { px: 'pa' }, winner: null },
  });
  const ms = motmStatus(st(stray), stray);
  ok('a vote from someone who did not play is not counted', ms.voted.length === 0);
  ok('so the round is not mistaken for finished', !ms.everyoneVoted);

  const everyone = baseFixture({
    ...open,
    motm: {
      open: true,
      closesAt: soon,
      votes: { pa: 'pc', pb: 'pc', pc: 'pa', pd: 'pa' },
      winner: null,
    },
  });
  const me2 = motmStatus(st(everyone), everyone);
  ok('everyone voted', me2.everyoneVoted);
  ok('a full vote closes itself rather than idling', !me2.open);

  const settled = baseFixture({ ...open, motm: { ...open.motm, winner: 'pc' } });
  const m3 = motmStatus(st(settled), settled);
  ok('a settled vote is shut', !m3.open && m3.settled);
  ok('and cannot be closed twice', !m3.canClose);

  const expired = baseFixture({
    ...open,
    motm: { open: true, closesAt: Date.now() - 1000, votes: {}, winner: null },
  });
  const m4 = motmStatus(st(expired), expired);
  ok('an expired window is shut even with the open flag set', !m4.open);
  ok('and can be closed with no votes at all, on contribution', m4.canClose);

  const noVotesYet = baseFixture({
    ...open,
    motm: { open: true, closesAt: soon, votes: {}, winner: null },
  });
  ok(
    'but not before the window is up — there is nothing to confirm',
    !motmStatus(st(noVotesYet), noVotesYet).canClose,
  );

  /* The admin closing an unvoted fixture.

     The vote not closing itself and the admin not being able to close it are
     different things. Only players who took part may vote, so an admin who did
     not play cannot break the tie by voting — and if nobody votes, that fixture
     stops the week for everybody until the window lapses. */
  const m5 = motmStatus(st(noVotesYet), noVotesYet);
  ok('the admin can close a vote nobody has cast', m5.adminCanClose);
  ok('and is told what that costs rather than refused', !!m5.closeNote && !m5.closeBlockedReason);
  ok('while the vote still does not close itself', !m5.canClose);

  /* `closesAt: 0` means no deadline was ever set. `expired` has always treated
     it as "not expired" — the trap is that a bare `Date.now() >= closesAt` reads
     it as long past, which would auto-close the fixture the moment anyone
     opened the screen. */
  const noDeadline = baseFixture({
    ...open,
    motm: { open: true, closesAt: 0, votes: {}, winner: null },
  });
  const m6 = motmStatus(st(noDeadline), noDeadline);
  ok('a vote with no deadline set has not expired', !m6.expired);
  ok('so nothing closes it automatically', !m6.canClose);
  ok('but the admin can still finish it by hand', m6.adminCanClose);

  ok('a settled vote refuses the admin too', !motmStatus(st(settled), settled).adminCanClose);
  ok(
    'and says why',
    motmStatus(st(settled), settled).closeBlockedReason === 'This vote is already settled.',
  );
}

/* ========================================================= rating window */
{
  const teams = {
    A: { ids: ['pa', 'pb'], cap: 'pa', name: 'A', color: '#f00', formation: '', pos: {} },
    B: { ids: ['pc', 'pd'], cap: 'pc', name: 'B', color: '#00f', formation: '', pos: {} },
  };
  const openWindow = (over: Partial<Fixture['ratings']> = {}, closesIn = 3600_000) =>
    baseFixture({
      teams,
      match: { events: [], periods: [], started: true, finished: true },
      motm: { open: false, closesAt: 0, votes: {}, winner: 'pa' },
      ratings: {
        open: true,
        ratedBy: {},
        results: null,
        /* A real window is always RATING_WINDOW_MS long; `closesIn` only moves
           where we are inside it. Deriving `openedAt` from that keeps the
           reminder maths honest — a 30-minute-long window genuinely should not
           fire a "one hour left" reminder, and hard-coding one here would have
           tested the wrong thing. */
        openedAt: Date.now() + closesIn - RATING_WINDOW_MS,
        closesAt: Date.now() + closesIn,
        ...over,
      },
    });

  /* Before the deadline nobody is *missing* — they are late. Conflating the
     two is what left an admin with three people who had not rated and no way
     to chase them. */
  const early = openWindow({ ratedBy: { pa: { pb: 7 } } });
  const w = ratingWindow(st(early), early);
  eq('nobody is missing before the deadline', w.missing, []);
  eq('but three are outstanding', w.outstanding.sort(), ['pb', 'pc', 'pd']);
  ok('so no intervention is needed yet', !w.needsIntervention);
  ok('and the window is not expired', !w.expired);

  const late = openWindow({ ratedBy: { pa: { pb: 7 } } }, -1000);
  const w2 = ratingWindow(st(late), late);
  eq('after the deadline they are missing', w2.missing.sort(), ['pb', 'pc', 'pd']);
  eq('and nothing is merely outstanding', w2.outstanding, []);
  ok('now the admin must step in', w2.needsIntervention);

  /* Recovery marks count exactly like real ones and end the intervention. */
  const covered = openWindow(
    {
      ratedBy: { pa: { pb: 7 } },
      consensus: {
        missing: ['pb', 'pc', 'pd'],
        trusted: ['pa'],
        submissions: {},
        approved: { pb: { pa: 6 }, pc: { pa: 6 }, pd: { pa: 6 } },
        audit: [],
      },
    },
    -1000,
  );
  const w3 = ratingWindow(st(covered), covered);
  ok('covered players are not missing', w3.missing.length === 0);
  ok('and the intervention is over', !w3.needsIntervention);

  /* Force-closing ends it even with gaps, by design. */
  const forced = openWindow(
    {
      ratedBy: {},
      consensus: {
        missing: [],
        trusted: [],
        submissions: {},
        approved: {},
        forceClosed: true,
        audit: [],
      },
    },
    -1000,
  );
  ok(
    'a force-closed round needs no further intervention',
    !ratingWindow(st(forced), forced).needsIntervention,
  );

  /* A player is only "submitted" once every team-mate has a mark. Partial
     submissions would skew whoever happened to get rated. */
  const partial = openWindow({ ratedBy: { pa: { pb: 7 } } });
  const sPa = ratingWindow(st(partial), partial).statuses.find((x) => x.pid === 'pa')!;
  eq('progress is reported as a count', [sPa.done, sPa.total], [1, 3]);

  /**
   * Reminders longer than the window are dropped rather than fired instantly.
   *
   * With a 15-hour window a "24 hours left" reminder is true from the first
   * second, so it would go out with the final whistle and say something
   * absurd.
   */
  const fresh = openWindow({ ratedBy: {} }, RATING_WINDOW_MS - 1000);
  const due = ratingWindow(st(fresh), fresh).dueReminders;
  ok('a fresh 15-hour window fires no reminder immediately', due.length === 0);
  ok(
    'the reminder list still contains one longer than the window',
    REMINDERS.some((r) => r.msLeft >= RATING_WINDOW_MS),
  );

  const nearlyUp = openWindow({ ratedBy: {} }, 30 * 60 * 1000);
  const due2 = ratingWindow(st(nearlyUp), nearlyUp).dueReminders;
  ok('with half an hour left, the one-hour reminder is due', due2.includes('1h'));
  ok('and the 24-hour one still is not', !due2.includes('24h'));

  const sent = openWindow({ ratedBy: {}, remindersSent: ['1h', '6h', '12h'] }, 30 * 60 * 1000);
  ok(
    'a reminder already sent is never sent twice',
    !ratingWindow(st(sent), sent).dueReminders.includes('1h'),
  );
}

/* ============================================================= consensus */
{
  const teams = {
    A: { ids: ['pa', 'pb'], cap: 'pa', name: 'A', color: '#f00', formation: '', pos: {} },
    B: { ids: ['pc', 'pd'], cap: 'pc', name: 'B', color: '#00f', formation: '', pos: {} },
  };
  const fx = baseFixture({
    teams,
    match: { events: [], periods: [], started: true, finished: true },
    motm: { open: false, closesAt: 0, votes: {}, winner: 'pa' },
    ratings: {
      open: true,
      ratedBy: { pa: { pb: 8, pc: 8, pd: 8 }, pb: { pa: 7, pc: 7, pd: 7 } },
      results: null,
      openedAt: Date.now() - 2000,
      closesAt: Date.now() - 1000,
      consensus: {
        missing: ['pc'],
        trusted: ['pa', 'pb'],
        submissions: {
          pa: { pc: { pa: 8, pb: 7, pd: 9 } },
          pb: { pc: { pa: 8, pb: 7, pd: 6 } },
        },
        approved: {},
        audit: [],
      },
    },
  });

  const rows = consensusRows(fx, 'pc');
  ok('one comparison row per player the stand-ins rated', rows.length === 3);

  const agreed = rows.find((r) => r.pid === 'pa')!;
  ok('where the stand-ins agree, the row is unanimous', agreed.unanimous);
  eq('and the majority is that mark', agreed.majority, 8);
  eq('with no spread', agreed.spread, 0);

  const disputed = rows.find((r) => r.pid === 'pd')!;
  ok('where they disagree, it is not unanimous', !disputed.unanimous);
  eq('and the spread is surfaced for the admin to look at', disputed.spread, 3);

  ok('both stand-ins have finished', consensusReady(fx));
  eq('progress is per stand-in', trustedProgress(fx, 'pa'), { done: 1, total: 1, complete: true });

  /* A stand-in must have played, and must not be the person being covered. */
  const eligible = eligibleTrusted(st(fx), fx)
    .map((p) => p.id)
    .sort();
  eq('only players who rated and are not missing may stand in', eligible, ['pa', 'pb']);

  const halfDone: Fixture = {
    ...fx,
    ratings: {
      ...fx.ratings,
      consensus: { ...fx.ratings.consensus!, submissions: { pa: { pc: { pa: 8 } } } },
    },
  };
  ok('one stand-in short is not ready', !consensusReady(halfDone));
}

/* ========================================================== participation */
{
  const teams = {
    A: { ids: ['pa', 'pb'], cap: 'pa', name: 'A', color: '#f00', formation: '', pos: {} },
    B: { ids: ['pc', 'pd'], cap: 'pc', name: 'B', color: '#00f', formation: '', pos: {} },
  };
  const fx = baseFixture({
    teams,
    match: { events: [], periods: [], started: true, finished: true },
    ratings: { open: true, ratedBy: { pa: { pb: 7 }, pb: { pa: 7 } }, results: null },
  });
  const m = matchState(st(fx), fx);
  ok('participants are the people named in a team', m.participants.length === 4);
  ok('a spectator did not play', !m.played('pe'));
  ok('a named player did', m.played('pa'));
  eq('who has rated is tracked', m.ratedBy.sort(), ['pa', 'pb']);
  ok('and everyone has not', !m.everyoneRated);

  /* The XI is not "out" on two people's opinions. */
  ok('team of the week is not out before every rating is in', !m.totwOut);
}

/* =============================================================== tiers */
{
  eq('the season starts in bronze', tierOf(SEASON_START).key, 'bronze');
  eq('silver begins at 69', tierOf(69).key, 'silver');
  eq('68 is still bronze', tierOf(68).key, 'bronze');
  eq('gold begins at 78', tierOf(78).key, 'gold');
  eq('elite begins at 90', tierOf(90).key, 'elite');

  const p = player('px', { rating: SEASON_START });
  const prog = tierProgress(p)!;
  eq('a fresh player is nine off silver', prog.gap, 9);
  eq('and silver is what is next', prog.next.key, 'silver');
  ok('the very top has nothing next', tierProgress(player('py', { rating: 99 })) === null);
}

/* ====================================================== draws and fees */
{
  const { buildWorkflow } = require('../src/core/domain/workflow');
  const teams = {
    A: { ids: ['pa', 'pb'], cap: 'pa', name: 'A', color: '#f00', formation: '', pos: {} },
    B: { ids: ['pc', 'pd'], cap: 'pc', name: 'B', color: '#00f', formation: '', pos: {} },
  };
  const finished = (
    events: AppState['fixtures'][0]['match']['events'],
    over: Partial<Fixture> = {},
  ) =>
    baseFixture({
      teams,
      flow: { confirmed: true, revealed: true },
      match: { events, periods: [{ start: 0, end: 1 }], started: true, finished: true },
      motm: { open: false, closesAt: 0, votes: {}, winner: 'pa' },
      pay: { pa: { amount: 7, paid: false, at: null } },
      ...over,
    });

  /* A draw has no losing side, so the wheel has nothing to spin for. It used
     to sit outstanding for ever on a 2-2. */
  const drawn = finished([
    { id: '1', t: 'goal', team: 'A', pid: 'pa', min: 1, at: 1 },
    { id: '2', t: 'goal', team: 'B', pid: 'pc', min: 2, at: 2 },
  ]);
  const dw = buildWorkflow(st(drawn), drawn, P[0], true);
  eq(
    'a draw auto-completes the forfeit wheel',
    dw.tasks.find((t: any) => t.id === 'wheel').state,
    'completed',
  );

  const won = finished([{ id: '1', t: 'goal', team: 'A', pid: 'pa', min: 1, at: 1 }]);
  const ww = buildWorkflow(st(won), won, P[0], true);
  ok('a win still owes a spin', ww.tasks.find((t: any) => t.id === 'wheel').state !== 'completed');

  /* An unpaid fee stays on the list. It was optional, so the list quietly
     stopped mentioning it and somebody could owe money and see a finished
     matchday. */
  const owing = buildWorkflow(st(won), won, P[0], false);
  const fee = owing.tasks.find((t: any) => t.id === 'pay');
  ok('an outstanding fee is not optional', !fee.optional);
  ok('and stays outstanding', fee.state !== 'completed');

  /* Booking the next match is the admin drawing a line under this one. */
  const closed = finished([{ id: '1', t: 'goal', team: 'A', pid: 'pa', min: 1, at: 1 }], {
    wrappedUp: true,
  });
  const after = buildWorkflow(st(closed), closed, P[0], false);
  eq(
    'until the admin books the next match',
    after.tasks.find((t: any) => t.id === 'pay').state,
    'expired',
  );

  /* The XI existing is not the same as the club being shown it. */
  const rated = finished([{ id: '1', t: 'goal', team: 'A', pid: 'pa', min: 1, at: 1 }], {
    honours: { totw: [{ id: 'pa', slot: 'MID', pts: 9 }], star: 'pa', stamp: 'W1' },
  });
  const before = buildWorkflow(st(rated), rated, P[0], true);
  ok(
    'revealing the XI is not ticked just because it was computed',
    before.tasks.find((t: any) => t.id === 'totw').state !== 'completed',
  );
  const shown = { ...rated, honoursRevealed: true };
  const outNow = buildWorkflow(st(shown), shown, P[0], true);
  eq(
    'it ticks once the admin publishes it',
    outNow.tasks.find((t: any) => t.id === 'totw').state,
    'completed',
  );

  /* --- reading is personal ------------------------------------------------
   *
   * `reportSeen` is one boolean on the fixture meaning somebody, somewhere,
   * opened it. Using it as a task's `done` ticked the job off for the other ten
   * the moment the first person looked. */
  {
    const clubRead = { ...shown, reportSeen: true };
    const w = buildWorkflow(st(clubRead), clubRead, P[1], false);
    ok(
      'somebody else reading the report does not read it for you',
      w.tasks.find((t: any) => t.id === 'report').state !== 'completed',
    );

    const mine = { ...st(clubRead), viewed: { ['report:' + clubRead.id]: true } };
    const w2 = buildWorkflow(mine, clubRead, P[1], false);
    eq(
      'it ticks when you open it yourself',
      w2.tasks.find((t: any) => t.id === 'report').state,
      'completed',
    );
  }

  /* --- the ratings room is worth a row ------------------------------------
   *
   * You gave ten marks and then never heard about it. The results existed only
   * inside a screen nothing pointed at. */
  {
    const noResults = buildWorkflow(st(shown), shown, P[0], false);
    eq(
      'nothing to see until every mark is in',
      noResults.tasks.find((t: any) => t.id === 'ratingsroom').state,
      'locked',
    );

    const withResults = {
      ...shown,
      ratings: {
        ...shown.ratings,
        closed: true,
        ratedBy: { pa: { pb: 7 } },
        results: { rows: [{ pid: 'pa', avg: 7, n: 1 }], n: 1 },
      },
    } as unknown as Fixture;
    const open = buildWorkflow(st(withResults), withResults, P[0], false);
    const room = open.tasks.find((t: any) => t.id === 'ratingsroom');
    ok('it opens once the room has spoken', room.state !== 'locked');
    ok('and never blocks the matchday', room.optional);

    const seen = { ...st(withResults), viewed: { ['ratings:' + withResults.id]: true } };
    eq(
      'and ticks when you go and look',
      buildWorkflow(seen, withResults, P[0], false).tasks.find((t: any) => t.id === 'ratingsroom')
        .state,
      'completed',
    );
  }

  /* --- you cannot book your way out of an unfinished match ----------------
   *
   * Booking the next fixture is how a matchday ends, so doing it early carried
   * the old one's unfinished business away with it. */
  {
    const { adminOutstanding } = require('../src/core/domain/workflow');
    const midMatch = baseFixture({
      teams,
      flow: { confirmed: true, revealed: true },
      match: { events: [], periods: [{ start: 0, end: null }], started: true, finished: false },
    });
    const blockers = adminOutstanding(buildWorkflow(st(midMatch), midMatch, P[0], true));
    ok('a match still being played blocks the next booking', blockers.length > 0);
    ok(
      'and never names the booking itself as its own blocker',
      blockers.every((t: any) => t.id !== 'next'),
    );
    ok(
      'nor anything optional — chasing is meant to be skippable',
      blockers.every((t: any) => !t.optional),
    );
    ok(
      "nor anything that is not the admin's",
      blockers.every((t: any) => t.role === 'admin'),
    );

    /* Everything the admin owes is done, so the next date can go up. */
    const wrapped = { ...shown, wrappedUp: true };
    eq(
      'a finished matchday blocks nothing',
      adminOutstanding(buildWorkflow(st(wrapped), wrapped, P[0], true)).length,
      0,
    );
  }
}

/* ============================================ how long an honour lasts */
{
  const { honoursActive } = require('../src/core/domain/honours');
  const honours = { totw: [{ id: 'pa', slot: 'MID' as const, pts: 9 }], star: 'pa', stamp: 'W1' };
  const played = (over: Partial<Fixture> = {}) =>
    baseFixture({
      match: { events: [], periods: [{ start: 0, end: 1 }], started: true, finished: true },
      ...over,
    });
  const world = (fixtures: Fixture[]): AppState =>
    ({ players: P, fixtures }) as unknown as AppState;

  const week1 = played({ id: 'w1', date: '2026-08-02', honours, honoursRevealed: true });

  ok('a revealed XI is in force', !!honoursActive(world([week1])));

  /* Computed is not published. The XI is worked out the moment the last mark
     lands, and the gold card art used to go on there and then — so half the
     squad were in Team of the Week colours while the reveal was still an
     outstanding task, giving it away before the admin had shown anybody. */
  const unshown = { ...week1, honoursRevealed: false };
  ok('an unrevealed one is not', honoursActive(world([unshown])) === null);

  /* The next whistle ends it. */
  const week2 = baseFixture({
    id: 'w2',
    date: '2026-08-09',
    match: { events: [], periods: [{ start: 5, end: null }], started: true, finished: false },
  });
  ok('the next kick-off retires it', honoursActive(world([week1, week2])) === null);

  /* `>` missed this: two matches on the same date compared equal, so last
     week's honours survived the new kick-off and the cards stayed gold through
     a match nobody had rated yet. */
  const sameDay = { ...week2, id: 'w1b', date: '2026-08-02' };
  ok('including one on the same day', honoursActive(world([week1, sameDay])) === null);

  /* A fixture that has been booked but not started changes nothing — the
     honours belong to the club until somebody actually plays again. */
  const booked = { ...week2, match: { events: [], periods: [], started: false, finished: false } };
  ok('a booked-but-unplayed fixture does not', !!honoursActive(world([week1, booked])));

  /* --- the star keeps its own diary ---------------------------------------
   *
   * The Man of the Match is public the second the vote closes; the XI is public
   * when the admin says so. They were read off the same record, so holding the
   * XI back held the star card back too — hours after the award had been
   * announced to the whole club. */
  {
    const { starActive } = require('../src/core/domain/honours');
    const { cardModOf } = require('../src/core/domain/rating');

    const voted = played({
      id: 'w1',
      date: '2026-08-02',
      motm: { open: false, closesAt: 0, votes: {}, winner: 'pa' },
      honours,
      honoursRevealed: false,
    });
    const w = world([voted]);
    eq('the star card is on as soon as MOTM is decided', starActive(w)?.pid, 'pa');
    eq('and shows on the card', cardModOf(w, 'pa'), 'star');
    ok(
      'while the rest of the XI waits for the reveal',
      honoursActive(w) === null && cardModOf(w, 'pb') !== 'totw',
    );

    const revealed = { ...voted, honoursRevealed: true };
    const w2 = world([revealed]);
    eq('once revealed the XI wears its colours', cardModOf(w2, 'pa'), 'star');
    ok('and so does everyone in it', !!honoursActive(w2));

    /* Both expire together at the next whistle. */
    const w3 = world([revealed, week2]);
    ok('the next kick-off ends the star too', starActive(w3) === null);
    eq("and the card goes back to the player's own form", cardModOf(w3, 'pa'), '');

    /* An undecided vote is not a star. */
    const unvoted = { ...voted, motm: { open: true, closesAt: 0, votes: {}, winner: null } };
    ok('nobody wears it before the vote closes', starActive(world([unvoted])) === null);
  }

  /* ------------------------------------------------- the trophy cabinet

     Honours expire; the record of having won them does not. `ownedCards` is
     the second reading of the same fixtures, so the ways it could disagree
     with the first are what matter here. */
  {
    const { ownedCards } = require('../src/core/domain/honours');
    const totsOf = (o: Partial<AppState['tots']>) =>
      ({ open: false, size: 5, votes: {}, ...o }) as AppState['tots'];
    const cab = (fixtures: Fixture[], extra: Partial<AppState> = {}) =>
      ownedCards(
        { players: P, fixtures, totsHistory: [], tots: null, ...extra } as unknown as AppState,
        'pa',
      );

    const w1 = played({
      id: 'c1',
      date: '2026-08-02',
      motm: { open: false, closesAt: 0, votes: {}, winner: 'pa' },
      honours: { ...honours, stamp: 'Blacks 3–2 Whites' },
      honoursRevealed: true,
      ratings: {
        open: false,
        ratedBy: {},
        results: {
          n: 1,
          rows: [
            {
              pid: 'pa',
              a: 8.4,
              own: 8.4,
              opp: 8.4,
              spread: 0,
              tens: 0,
              minV: 8,
              ratingBefore: 78,
              ratingAfter: 81,
            },
          ],
        },
      },
    });
    const got = cab([w1]);
    eq('a match won gives one card, not two', got.length, 1);
    /* The overall the card carried, off the record rather than off the player —
       `Player.rating` is today's, and a card drawn with today's number is not
       the card that was won. */
    eq('the overall is the one from that night', got[0].ovr, 81);
    eq('and what it moved from', got[0].ovrBefore, 78);
    eq('and the rarer of the two is the one kept', got[0].kind, 'star');
    eq('with the scoreline attached', got[0].stamp, 'Blacks 3–2 Whites');

    /* The XI on its own is a Team of the Week card. */
    const teamOnly = { ...w1, motm: { open: false, closesAt: 0, votes: {}, winner: 'pb' } };
    eq('being in the XI without the star', cab([teamOnly])[0].kind, 'totw');

    /* Same leak `honoursActive` was once caught making: an XI the admin has
       not published is not a card anybody holds, and listing it here would
       give the reveal away on the profile screen. */
    eq(
      'an unrevealed XI is not in the cabinet yet',
      cab([{ ...teamOnly, honoursRevealed: false }]).length,
      0,
    );

    /* A Man of the Match on a week nobody rated. There are no `honours` at all
       on that fixture — read it off `motm.winner` or it vanishes. */
    const unrated = played({
      id: 'c2',
      date: '2026-08-09',
      motm: { open: false, closesAt: 0, votes: {}, winner: 'pa' },
    });
    eq('a star still counts with no ratings behind it', cab([unrated]).length, 1);

    /* Newest first — a cabinet reads back from the most recent. */
    const order = cab([w1, unrated]);
    eq('newest first', order[0].date, '2026-08-09');
    /* Two fixtures on one date is a real thing — a rearranged game, a
       double-header — and without a tiebreak the shelf's order depends on
       fixture order, so it can rearrange itself between renders. */
    const sameDay = played({
      id: 'c4',
      date: '2026-08-02',
      motm: { open: false, closesAt: 0, votes: {}, winner: 'pb' },
      honours,
      honoursRevealed: true,
    });
    eq(
      'a tie on date puts the rarer card first',
      cab([sameDay, w1]).map((c: any) => c.kind),
      ['star', 'totw'],
    );
    eq(
      'and does not depend on fixture order',
      cab([w1, sameDay]).map((c: any) => c.kind),
      ['star', 'totw'],
    );

    /* Honours expiring must not empty the cabinet: `honoursActive` returns
       null once a newer match kicks off, and this reads the same fixtures. */
    const later = baseFixture({
      id: 'c3',
      date: '2026-08-16',
      match: { events: [], periods: [{ start: 0, end: null }], started: true, finished: false },
    });
    ok('an expired honour is still a card you won', cab([w1, later]).length === 1);

    /* Team of the Season comes from the history, and from the live record
       until the season is filed — otherwise the newest card is the one
       missing. */
    const withTots = cab([], {
      tots: totsOf({
        revealed: true,
        winners: ['pa'],
        season: '25/26',
        closedAt: Date.parse('2026-06-01'),
      }),
    });
    eq('the season XI counts once revealed', withTots.length, 1);
    eq('and is labelled by season', withTots[0].stamp, 'Season 25/26');
    eq(
      'an unrevealed season XI does not',
      cab([], {
        tots: totsOf({ revealed: false, winners: ['pa'], season: '25/26', closedAt: null }),
      }).length,
      0,
    );
    eq(
      'and it is never listed twice when history and live agree',
      cab([], {
        tots: totsOf({
          revealed: true,
          winners: ['pa'],
          season: '25/26',
          closedAt: Date.parse('2026-06-01'),
        }),
        totsHistory: [{ season: '25/26', winners: ['pa'], at: Date.parse('2026-06-01') }],
      }).length,
      1,
    );

    eq(
      'somebody who has won nothing has an empty cabinet',
      cab([w1]).length &&
        ownedCards(
          { players: P, fixtures: [w1], totsHistory: [], tots: null } as unknown as AppState,
          'pe',
        ).length,
      0,
    );
  }
}

/* ============================================ reading what does not exist */
{
  const { buildWorkflow } = require('../src/core/domain/workflow');
  const teams = {
    A: { ids: ['pa', 'pb'], cap: 'pa', name: 'A', color: '#f00', formation: '', pos: {} },
    B: { ids: ['pc', 'pd'], cap: 'pc', name: 'B', color: '#00f', formation: '', pos: {} },
  };
  const wrapped = baseFixture({
    teams,
    flow: { confirmed: true, revealed: true },
    match: { events: [], periods: [{ start: 0, end: 1 }], started: true, finished: true },
    motm: { open: false, closesAt: 0, votes: {}, winner: 'pa' },
    honours: { totw: [{ id: 'pa', slot: 'MID' as const, pts: 9 }], star: 'pa', stamp: 'W1' },
    honoursRevealed: true,
  });

  /* Telling ten people to go and read a report nobody has written is how a
     task list stops being believed. */
  eq(
    'no report, no row',
    buildWorkflow(st(wrapped), wrapped, P[1], false).tasks.find((t: any) => t.id === 'report')
      .state,
    'locked',
  );

  const written = { ...wrapped, reportReady: true };
  ok(
    'once the admin has written it up, everybody gets the row',
    buildWorkflow(st(written), written, P[1], false).tasks.find((t: any) => t.id === 'report')
      .state !== 'locked',
  );

  /* ------------------------------------------- a week nobody rated

     If no marks are given there is no table, no XI, and nothing the admin can
     press. The task has to be skipped rather than left pending, because
     `report` and `next` wait on it — otherwise a match nobody rated stays on
     the home screen for good. */
  const unrated = baseFixture({
    ...wrapped,
    ratings: { ...wrapped.ratings, ratedBy: {}, closed: true },
    honours: undefined,
    honoursRevealed: false,
  });
  const uw = buildWorkflow(st(unrated), unrated, P[0], true);
  const totwTask = uw.tasks.find((t: any) => t.id === 'totw');
  eq('nobody rated, so the Team of the Week is skipped', totwTask.state, 'skipped');
  ok('and it says why', /nobody rated/i.test(totwTask.hint ?? ''));

  /* `report` depends on `totw` and nothing else, so it is the clean test of
     whether a skipped XI satisfies the dependency. */
  const unratedReport = { ...unrated, reportReady: true };
  ok(
    'the report is not held behind an XI that will never exist',
    buildWorkflow(st(unratedReport), unratedReport, P[1], false).tasks.find(
      (t: any) => t.id === 'report',
    ).state !== 'locked',
  );

  /* End to end, as it actually happens: the only route to a closed round with
     no marks is the admin force-closing it, which settles `consensus` too. If
     either dependency were still pending the matchday could never be left. */
  const forceClosed = baseFixture({
    ...unrated,
    ratings: {
      ...unrated.ratings,
      consensus: {
        missing: [],
        trusted: [],
        submissions: {},
        approved: {},
        audit: [],
        forceClosed: true,
      },
    },
  });
  ok(
    'and the admin can book the next match',
    buildWorkflow(st(forceClosed), forceClosed, P[0], true).tasks.find((t: any) => t.id === 'next')
      .state !== 'locked',
  );

  /* The round being closed is not on its own enough — a force-close with marks
     already in still names an XI, and that one must not read as skipped. */
  const closedWithXI = baseFixture({ ...wrapped, ratings: { ...wrapped.ratings, closed: true } });
  eq(
    'a closed round that did name an XI is not skipped',
    buildWorkflow(st(closedWithXI), closedWithXI, P[0], true).tasks.find(
      (t: any) => t.id === 'totw',
    ).state,
    'completed',
  );

  /* And before anything is closed it is still a live job, not a skipped one. */
  const stillOpen = baseFixture({
    ...wrapped,
    ratings: { ...wrapped.ratings, ratedBy: {}, closed: false },
    honours: undefined,
    honoursRevealed: false,
  });
  ok(
    'an open round is never skipped',
    buildWorkflow(st(stillOpen), stillOpen, P[0], true).tasks.find((t: any) => t.id === 'totw')
      .state !== 'skipped',
  );
}

/* ======================================= role points, per line of the pitch */
{
  const {
    roleBuckets,
    rolePointsFor,
    roleInFixture,
    ROLE_WEIGHTS,
  } = require('../src/core/domain/roles');
  const { seasonPoints } = require('../src/core/domain/honours');

  /* pa is a defender by trade. The shapes below move him about. */
  const squad = [
    player('pa', { pos: 'DEF' }),
    player('pb', { pos: 'ATT' }),
    player('pc'),
    player('pd'),
  ];
  const teamsAt = (paY: number) => ({
    A: {
      ids: ['pa', 'pb'],
      cap: 'pa',
      name: 'A',
      color: '#f00',
      formation: '',
      pos: { pa: { x: 50, y: paY }, pb: { x: 50, y: 20 } },
    },
    B: { ids: ['pc', 'pd'], cap: 'pc', name: 'B', color: '#00f', formation: '', pos: {} },
  });
  const match = (over: Partial<Fixture> = {}, paY = 70) =>
    baseFixture({
      teams: teamsAt(paY) as any,
      match: { events: [], periods: [{ start: 0, end: 1 }], started: true, finished: true },
      ratings: {
        open: false,
        ratedBy: {},
        results: { n: 1, rows: [{ pid: 'pa', a: 8, own: 8, opp: 8, spread: 0, tens: 0, minV: 8 }] },
      },
      ...over,
    });
  const world = (fixtures: Fixture[]): AppState =>
    ({ players: squad, fixtures, club: null }) as unknown as AppState;

  /* --- where a match is banked --- */
  const atBack = match({ id: 'r1' }, 70);
  const upFront = match({ id: 'r2', date: '2026-08-09' }, 20);
  eq('a match is banked in the line actually played', roleInFixture(atBack, 'pa', 'DEF'), 'DEF');
  eq('and follows the pitch, not the profile', roleInFixture(upFront, 'pa', 'DEF'), 'ATT');

  const b = roleBuckets(world([atBack, upFront]), 'pa');
  eq('each match lands in exactly one bucket', b.apps.DEF + b.apps.ATT + b.apps.MID + b.apps.GK, 2);
  eq('one at the back', b.apps.DEF, 1);
  eq('one up front', b.apps.ATT, 1);

  /* A fixture with no recorded shape falls back to the profile position —
     older fixtures predate shapes being kept, and dropping them would lose
     real matches. */
  const noShape = baseFixture({
    id: 'r3',
    date: '2026-08-16',
    teams: {
      A: { ids: ['pa'], cap: 'pa', name: 'A', color: '#f00', formation: '', pos: {} },
      B: { ids: ['pc'], cap: 'pc', name: 'B', color: '#00f', formation: '', pos: {} },
    } as any,
    match: { events: [], periods: [{ start: 0, end: 1 }], started: true, finished: true },
  });
  eq('no shape recorded falls back to the profile', roleInFixture(noShape, 'pa', 'DEF'), 'DEF');

  /* --- the clean sheet, which used to score nothing --- */
  const cs = match({ id: 'r4' }, 70);
  const conceded = match(
    {
      id: 'r5',
      match: {
        events: [{ id: 'g', t: 'goal', team: 'B', pid: 'pc', min: 5, at: 5 }],
        periods: [{ start: 0, end: 1 }],
        started: true,
        finished: true,
      },
    },
    70,
  );
  ok(
    'a clean sheet is worth more than conceding',
    rolePointsFor(world([cs]), cs, 'pa', 'DEF') >
      rolePointsFor(world([conceded]), conceded, 'pa', 'DEF'),
  );
  eq(
    'and it is worth exactly the line s weight',
    +(
      rolePointsFor(world([cs]), cs, 'pa', 'DEF') -
      rolePointsFor(world([conceded]), conceded, 'pa', 'DEF')
    ).toFixed(1),
    ROLE_WEIGHTS.DEF.clean,
  );

  /* --- scarcity: the same goal is worth more from further back --- */
  const scored = (y: number) =>
    match(
      {
        id: 'r6',
        match: {
          events: [{ id: 'g', t: 'goal', team: 'A', pid: 'pa', min: 5, at: 5 }],
          periods: [{ start: 0, end: 1 }],
          started: true,
          finished: true,
        },
      },
      y,
    );
  const asKeeper = rolePointsFor(world([]), scored(90), 'pa', 'GK');
  const asDef = rolePointsFor(world([]), scored(70), 'pa', 'DEF');
  const asAtt = rolePointsFor(world([]), scored(20), 'pa', 'ATT');
  ok('a goal from the back beats a goal from the front', asDef > asAtt);
  ok('and a keeper scoring beats both', asKeeper > asDef);

  /* --- the structural fix: a keeper can now out-earn a two-goal striker --- */
  {
    const gk = player('gk', { pos: 'GK' });
    const st = player('st', { pos: 'ATT' });
    const fx = baseFixture({
      id: 'r7',
      teams: {
        A: {
          ids: ['gk'],
          cap: 'gk',
          name: 'A',
          color: '#f00',
          formation: '',
          pos: { gk: { x: 50, y: 92 } },
        },
        B: {
          ids: ['st'],
          cap: 'st',
          name: 'B',
          color: '#00f',
          formation: '',
          pos: { st: { x: 50, y: 15 } },
        },
      } as any,
      match: {
        events: [
          { id: 'g1', t: 'goal', team: 'B', pid: 'st', min: 5, at: 5 },
          { id: 'g2', t: 'goal', team: 'B', pid: 'st', min: 6, at: 6 },
        ],
        periods: [{ start: 0, end: 1 }],
        started: true,
        finished: true,
      },
      /* The keeper is rated a ten and still conceded twice, so no clean sheet
         — this is the case the old formula made unwinnable at any rating. */
      ratings: {
        open: false,
        ratedBy: {},
        results: {
          n: 2,
          rows: [
            { pid: 'gk', a: 10, own: 10, opp: 10, spread: 0, tens: 1, minV: 10 },
            { pid: 'st', a: 7, own: 7, opp: 7, spread: 0, tens: 0, minV: 7 },
          ],
        },
      },
    });
    const w = { players: [gk, st], fixtures: [fx], club: null } as unknown as AppState;
    /* Conceding two, the keeper still loses — which is right. The point is
       that a *clean sheet* now changes the answer, where before nothing could. */
    ok(
      'conceding twice, a perfect keeper still trails a two-goal striker',
      seasonPoints(w, 'gk') < seasonPoints(w, 'st'),
    );

    const shutout = baseFixture({
      ...fx,
      id: 'r8',
      match: { events: [], periods: [{ start: 0, end: 1 }], started: true, finished: true },
    });
    const w2 = { players: [gk, st], fixtures: [shutout], club: null } as unknown as AppState;
    ok(
      'but a clean sheet puts the keeper ahead of a goalless striker',
      seasonPoints(w2, 'gk') > seasonPoints(w2, 'st'),
    );
  }

  /* --- season scope: the number must not grow for ever --- */
  {
    const old = match({ id: 'r9', date: '2025-05-01' }, 70);
    const now = match({ id: 'r10', date: '2026-08-02' }, 70);
    const unscoped = { players: squad, fixtures: [old, now], club: null } as unknown as AppState;
    const scoped = {
      players: squad,
      fixtures: [old, now],
      club: { seasonStart: '2026-07-01' },
    } as unknown as AppState;
    ok('with no season set, everything counts', roleBuckets(unscoped, 'pa').apps.DEF === 2);
    eq('a season start drops last season', roleBuckets(scoped, 'pa').apps.DEF, 1);
    ok(
      'and so does the club-wide total',
      seasonPoints(scoped, 'pa') < seasonPoints(unscoped, 'pa'),
    );
  }
}

/* ------------------------------------------------ big numbers on a card */
{
  const { compact } = require('../src/core/utils');
  eq('an ordinary season prints in full', compact(253), '253');
  eq('and rounds rather than showing decimals', compact(212.6), '213');
  eq('four figures go compact so they fit the slot', compact(1247), '1.2k');
  eq('five figures drop the decimal', compact(12470), '12k');
  eq('zero is zero', compact(0), '0');
}

/* ------------------------------------------ every face the source names */
/* Twice now the app has shipped a `fontFamily` that was never registered in
   App.tsx. Nothing throws: React Native Web resolves an unknown family to
   Times, so the screen renders in a serif and looks like a deliberate — and
   badly judged — design change rather than a missing import. The first time it
   was ten faces and every heading; the second it was `Barlow_500Medium` and
   only the newest screens, which is far harder to spot because the rest of the
   app still looked right.

   So: read what the source asks for, read what App.tsx loads, and refuse any
   name that appears in the first list and not the second. */
{
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');

  const root = path.join(__dirname, '..', '..');
  const srcDir = path.join(root, 'src');

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  walk(srcDir);

  /* The families are always written as string literals at the usage site, so
     the name is readable without parsing. A template literal would defeat this
     — which is itself a reason to keep writing them plainly. */
  const named = new Set<string>();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/fontFamily:\s*[^,\n]*?'([A-Za-z]+_[A-Za-z0-9]+)'/g)) {
      named.add(m[1]);
    }
    /* `isCurrent ? 'A' : 'B'` puts the second face after the colon, past the
       first match — catch those too or half the conditionals go unchecked. */
    for (const m of text.matchAll(
      /'((?:Barlow|BarlowCondensed|BarlowSemiCondensed|BebasNeue|JetBrainsMono|SpaceGrotesk|SpaceMono|PermanentMarker)_[A-Za-z0-9]+)'/g,
    )) {
      named.add(m[1]);
    }
  }

  const app = fs.readFileSync(path.join(root, 'App.tsx'), 'utf8');
  const mapBody = app.slice(
    app.indexOf('useFonts({'),
    app.indexOf('});', app.indexOf('useFonts({')),
  );
  const loaded = new Set([...mapBody.matchAll(/([A-Za-z]+_[A-Za-z0-9]+)/g)].map((m) => m[1]));

  ok('the source names at least the ten design-system faces', named.size >= 10);
  ok(
    'App.tsx registers every face the source names',
    [...named].every((f) => loaded.has(f)),
  );
  eq('and none is left unregistered', [...named].filter((f) => !loaded.has(f)).sort(), []);
}

/* ------------------------------------------- one writer per line-up side */
/* An admin and a captain could both write the same side's shape. Nothing
   errored — last-one-wins meant the captain's work vanished under the admin's
   next sync with no message. These pin the single-holder rule the triggers in
   `0024`/`0026` enforce; the client must agree with it. */
{
  const {
    holdsFormation,
    canTakeFormation,
    isDelegated,
    formationAskPending,
  } = require('../src/core/domain/match');
  const side = (over: Record<string, unknown> = {}) => ({
    cap: 'cap1',
    ids: ['cap1', 'p2'],
    ...over,
  });

  ok('by default the captain holds their own shape', holdsFormation(side(), 'cap1'));
  ok('and nobody else does', !holdsFormation(side(), 'other'));
  ok('a signed-out viewer never holds it', !holdsFormation(side(), null));

  /* Taking a side over names the taker. Being admin is not itself a claim on a
     shape somebody is still arranging — that was the original bug. */
  const taken = side({ holder: 'admin1', holderAccepted: true });
  ok('once taken, the holder is whoever took it', holdsFormation(taken, 'admin1'));
  ok('and the captain no longer does', !holdsFormation(taken, 'cap1'));

  /* Asking is not appointing. An unanswered invitation grants nothing, and —
     the part that matters — it does not strand the side either: the captain
     still holds their own shape while they wait for an answer. */
  const asked = side({ holder: 'p2' });
  ok('an unanswered ask grants nothing', !holdsFormation(asked, 'p2'));
  ok('and the captain keeps it meanwhile', holdsFormation(asked, 'cap1'));
  ok('the ask is visible as pending', formationAskPending(asked));
  ok('and is not yet a delegation', !isDelegated(asked));

  const accepted = side({ holder: 'p2', holderAccepted: true });
  ok('accepting hands it over', holdsFormation(accepted, 'p2'));
  ok('and takes it off the captain', !holdsFormation(accepted, 'cap1'));
  ok('which is a delegation', isDelegated(accepted));

  const declined = side({ holder: 'p2', holderAccepted: false });
  ok('a declined ask grants nothing', !holdsFormation(declined, 'p2'));
  ok('and the captain still holds it', holdsFormation(declined, 'cap1'));

  ok('takeover is offered while a side is outstanding', canTakeFormation(side(), 'admin1', true));
  ok(
    'but not once that side has confirmed',
    !canTakeFormation(side({ ready: true }), 'admin1', true),
  );
  ok('nor when they already hold it', !canTakeFormation(taken, 'admin1', true));
  ok('and never to a non-admin', !canTakeFormation(side(), 'p2', false));
}

/* ============================================ records and achievements */
/**
 * The promise both features make: **nothing is stored.**
 *
 * A record is a `max()` over the match log and an achievement is a predicate
 * over it, so the only way either can be wrong is for the reduction to be
 * wrong. These pin the reductions — and in particular the four that would be
 * silently, plausibly wrong: an own goal counting as a goal, a match still in
 * progress counting at all, the fastest goal being resolved as a maximum, and
 * a tie being settled by whatever order `players` happens to be in.
 */
{
  const teamOfIds = (ids: string[], cap: string | null = null) => ({
    ids,
    cap,
    name: 'Side',
    color: '#ffffff',
    formation: '',
    pos: {},
  });

  const world = (fixtures: Fixture[], players: Player[] = P): AppState =>
    ({
      players,
      fixtures,
      totsHistory: [],
      tots: {
        open: false,
        revealed: false,
        size: 0,
        votes: {},
        winners: [],
        season: null,
        closedAt: null,
      },
      viewed: {},
    }) as unknown as AppState;

  const f1 = baseFixture({
    id: 'r1',
    date: '2026-08-02',
    teams: { A: teamOfIds(['pa', 'pb'], 'pa'), B: teamOfIds(['pc', 'pd']) },
    match: {
      started: true,
      finished: true,
      periods: [{ start: 0, end: 1 }],
      events: [
        { id: 'e1', t: 'goal', team: 'B', pid: 'pc', min: 5, at: 5 },
        { id: 'e2', t: 'goal', team: 'A', pid: 'pb', assist: 'pa', min: 10, at: 10 },
        { id: 'e3', t: 'goal', team: 'A', pid: 'pa', min: 30, at: 30 },
        { id: 'e4', t: 'pen', team: 'A', pid: 'pa', min: 40, at: 40 },
        /* The one that would quietly make a striker's worst afternoon their
           best: an own goal is logged against the scorer and counts for the
           other side. */
        { id: 'e5', t: 'own', team: 'A', pid: 'pa', min: 44, at: 44 },
      ],
    },
    ratings: {
      open: false,
      ratedBy: {},
      results: {
        n: 4,
        rows: [
          {
            pid: 'pa',
            a: 8.5,
            own: 8.5,
            opp: 8.5,
            spread: 0,
            tens: 0,
            minV: 8,
            ratingBefore: 60,
            ratingAfter: 65,
          },
          {
            pid: 'pc',
            a: 9.2,
            own: 9.2,
            opp: 9.2,
            spread: 0,
            tens: 1,
            minV: 9,
            ratingBefore: 60,
            ratingAfter: 62,
          },
        ],
      },
    },
  });

  const f2 = baseFixture({
    id: 'r2',
    date: '2026-08-09',
    teams: { A: teamOfIds(['pa', 'pb']), B: teamOfIds(['pc', 'pd']) },
    match: {
      started: true,
      finished: true,
      periods: [{ start: 0, end: 1 }],
      events: [
        { id: 'g1', t: 'goal', team: 'A', pid: 'pa', assist: 'pb', min: 20, at: 20 },
        { id: 'g2', t: 'goal', team: 'A', pid: 'pa', assist: 'pb', min: 25, at: 25 },
        { id: 'g3', t: 'goal', team: 'B', pid: 'pc', assist: 'pd', min: 30, at: 30 },
      ],
    },
  });

  /* Still being played. Nothing in it is a record yet — a hat-trick undone at
     half time was never one. */
  const live = baseFixture({
    id: 'r3',
    date: '2026-08-16',
    teams: { A: teamOfIds(['pa', 'pb']), B: teamOfIds(['pc', 'pd']) },
    match: {
      started: true,
      finished: false,
      periods: [{ start: 0, end: null }],
      events: [
        { id: 'l1', t: 'goal', team: 'A', pid: 'pb', min: 1, at: 1 },
        { id: 'l2', t: 'goal', team: 'A', pid: 'pb', min: 2, at: 2 },
        { id: 'l3', t: 'goal', team: 'A', pid: 'pb', min: 3, at: 3 },
      ],
    },
  });

  const S = world([f1, f2, live]);
  const rec = (id: RecordId) => clubRecords(S, 'pa').find((r) => r.def.id === id)!;

  /* ---------------------------------------------------------- the log */
  const lines = matchLines(S);
  ok('a match still in play sets no records', !lines.some((l) => l.fid === 'r3'));

  const paBest = matchBests(S, 'pa');
  eq('an own goal is not a goal', paBest.goals, 2);
  eq('assists are credited to the assister', matchBests(S, 'pb').assists, 2);
  eq('involvements are goals and assists together', paBest.contributions, 3);
  eq('the best match rating is the mark out of ten', paBest.rating, 8.5);
  eq('a rating jump is what the match moved it by', paBest.gain, 5);
  /* Across two matches — 30' in one, 20' in the other. */
  eq('the fastest goal is the earliest minute', paBest.fastestGoal, 20);

  const nobody = matchBests(S, 'pe');
  eq(
    'a player who has never played has no bests',
    [nobody.goals, nobody.rating, nobody.fastestGoal],
    [0, null, null],
  );

  /* -------------------------------------------------------- the board */
  eq('most goals in a match is the club best', rec('matchGoals').best?.value, 2);
  eq('and it is dated to the match it happened in', rec('matchGoals').best?.fid, 'r1');
  eq('most assists in a match', rec('matchAssists').best?.pid, 'pb');
  eq('most involvements in a match', rec('matchContributions').best?.value, 3);
  eq('the highest mark the club has given', rec('matchRating').best?.pid, 'pc');
  eq('the biggest rating jump', rec('matchGain').best?.value, 5);

  /* The one record where more is worse. A `max()` here would crown the
     slowest goal in the club's history and look entirely plausible. */
  eq('the fastest goal is a minimum, not a maximum', rec('fastestGoal').best?.pid, 'pc');
  eq('and it is the smallest minute', rec('fastestGoal').best?.value, 5);

  eq('the leading scorer is a career total', rec('careerGoals').best?.value, 4);
  eq('a career record belongs to no single match', rec('careerGoals').best?.fid, null);
  eq('most assists over the club', rec('careerAssists').best?.pid, 'pb');

  /* Four players, two matches each. Settling that on player order would move
     the record every time somebody joined. */
  eq('a level record is shared, not awarded', rec('careerApps').shared.length, 4);
  ok('and everybody level with it holds it', rec('careerApps').held);

  ok('holding a record is knowing you are on it', rec('careerGoals').held);
  ok('and not holding one is knowing you are not', !rec('matchRating').held);
  eq('your own claim is carried beside the record', rec('matchRating').mine?.value, 8.5);

  /* ------------------------------------------------------ empty club */
  const empty = world([]);
  ok(
    'a club with no matches holds no records',
    clubRecords(empty).every((r) => r.best === null && r.shared.length === 0),
  );

  /* ------------------------------------------------------- pending */
  const pz = player('pz', { pending: true });
  const invited = baseFixture({
    id: 'r4',
    date: '2026-08-02',
    teams: { A: teamOfIds(['pz']), B: teamOfIds(['pc']) },
    match: {
      started: true,
      finished: true,
      periods: [{ start: 0, end: 1 }],
      events: [
        { id: 'z1', t: 'goal', team: 'A', pid: 'pz', min: 1, at: 1 },
        { id: 'z2', t: 'goal', team: 'A', pid: 'pz', min: 2, at: 2 },
        { id: 'z3', t: 'goal', team: 'A', pid: 'pz', min: 3, at: 3 },
      ],
    },
  });
  const withPending = world([invited], [...P, pz]);
  ok(
    'an unaccepted invitation is not on the record board',
    clubRecords(withPending).every((r) => !r.shared.includes('pz')),
  );

  /* ------------------------------------------------------ formatting */
  const def = (id: RecordId) => RECORDS.find((d) => d.id === id)!;
  eq('a match rating reads out of ten', recordValue(def('matchRating'), 8.5), '8.5');
  eq('a rating jump keeps its sign', recordValue(def('matchGain'), 5), '+5');
  eq('a fast goal reads as a minute', recordValue(def('fastestGoal'), 5), "5'");
  eq('everything else is a plain count', recordValue(def('careerGoals'), 4), '4');

  /* --------------------------------------------------- achievements */
  const A = achievementsFor(S, 'pa');
  const got = (id: string) => A.find((x) => x.def.id === id)!;

  ok(
    'every achievement id is unique',
    new Set(ACHIEVEMENTS.map((d) => d.id)).size === ACHIEVEMENTS.length,
  );
  ok(
    'earned means the count reached the threshold, and nothing else',
    A.every((x) => x.earned === x.have >= x.need),
  );
  ok(
    'nothing is earned by a threshold of zero',
    ACHIEVEMENTS.every((d) => d.progress(achievementCtx(S, 'pa')).need > 0),
  );

  ok('a first goal is a first goal', got('firstGoal').earned);
  ok('two in a match is a brace', got('brace').earned);
  ok('two in a match is not a hat-trick', !got('hatTrick').earned);
  eq('and the bar says how far off it is', [got('hatTrick').have, got('hatTrick').need], [2, 3]);
  ok('three involvements in a match counts', got('involved3').earned);
  ok('one assist is not two', !got('doubleAssist').earned);
  ok(
    'two assists in a match is',
    achievementsFor(S, 'pb').find((x) => x.def.id === 'doubleAssist')!.earned,
  );
  ok('captaining a side earns the armband', got('firstCaptain').earned);
  ok('nobody has ten goals yet', !got('goals10').earned);

  /* The unfinished hat-trick again, from the other side: pb has three in the
     live match and the badge does not move until the whistle. */
  ok(
    'a hat-trick in a match still in play is not a hat-trick',
    !achievementsFor(S, 'pb').find((x) => x.def.id === 'hatTrick')!.earned,
  );

  eq('every record id is unique', new Set(RECORDS.map((d) => d.id)).size, RECORDS.length);

  /* Team of the Week counts selections, not cards — a player who was also Man
     of the Match that night gets one card and two honours, and `ownedCards`
     deliberately drops the second card. */
  const revealed = baseFixture({
    id: 'r5',
    date: '2026-08-02',
    teams: { A: teamOfIds(['pa', 'pb']), B: teamOfIds(['pc', 'pd']) },
    match: { started: true, finished: true, periods: [{ start: 0, end: 1 }], events: [] },
    motm: { open: false, closesAt: 0, votes: {}, winner: 'pa' },
    honours: { totw: [{ id: 'pa', slot: 'MID', pts: 10 }], star: 'pa', stamp: '' },
    honoursRevealed: true,
  });
  const hidden = { ...revealed, id: 'r6', honoursRevealed: false };
  ok(
    'a revealed Team of the Week is an honour',
    achievementsFor(world([revealed]), 'pa').find((x) => x.def.id === 'firstTotw')!.earned,
  );
  ok(
    'an XI the club has not been shown is not one yet',
    !achievementsFor(world([hidden]), 'pa').find((x) => x.def.id === 'firstTotw')!.earned,
  );
  ok(
    'and being man of the match does not cost you the XI badge',
    achievementsFor(world([revealed]), 'pa').find((x) => x.def.id === 'firstMotm')!.earned,
  );

  /* Nothing is stored, so nothing survives its history. */
  ok(
    'an empty club has earned nothing',
    achievementsFor(empty, 'pa').every((x) => !x.earned),
  );
}

/* ================================================================= duels */
/**
 * A duel is several arguments, and the one worth pinning is the head-to-head.
 *
 * In a club that splits into two sides every Sunday, two players are teammates
 * about as often as they are opponents — so "matches they both played" is not
 * a head-to-head, and counting it that way would record a match they won
 * together as a draw between them.
 */
{
  const side = (ids: string[], cap: string | null = null) => ({
    ids,
    cap,
    name: 'Side',
    color: '#fff',
    formation: '',
    pos: {},
  });
  const world = (fixtures: Fixture[], players: Player[] = P): AppState =>
    ({
      players,
      fixtures,
      totsHistory: [],
      tots: {
        open: false,
        revealed: false,
        size: 0,
        votes: {},
        winners: [],
        season: null,
        closedAt: null,
      },
      viewed: {},
    }) as unknown as AppState;

  const played = (
    id: string,
    date: string,
    a: string[],
    b: string[],
    events: Fixture['match']['events'],
  ) =>
    baseFixture({
      id,
      date,
      teams: { A: side(a), B: side(b) },
      match: { started: true, finished: true, periods: [{ start: 0, end: 1 }], events },
    });

  /* Opponents: pa's side wins 2-1. */
  const opp = played(
    'd1',
    '2026-09-06',
    ['pa', 'pb'],
    ['pc', 'pd'],
    [
      { id: '1', t: 'goal', team: 'A', pid: 'pa', min: 5, at: 5 },
      { id: '2', t: 'goal', team: 'A', pid: 'pb', min: 8, at: 8 },
      { id: '3', t: 'goal', team: 'B', pid: 'pc', min: 20, at: 20 },
    ],
  );
  /* Teammates: they win it together, which settles nothing between them. */
  const mates = played(
    'd2',
    '2026-09-13',
    ['pa', 'pc'],
    ['pb', 'pd'],
    [{ id: '4', t: 'goal', team: 'A', pid: 'pa', min: 9, at: 9 }],
  );

  const h = headToHead(world([opp, mates]), 'pa', 'pc');
  eq('only the weeks they were opponents count', h.met, 1);
  eq('and the winner is whoever their side beat', [h.aWins, h.bWins, h.draws], [1, 0, 0]);
  eq('the last meeting is the most recent one', h.last?.fid, 'd1');
  eq('with the score from each of their points of view', [h.last?.a, h.last?.b], [2, 1]);

  ok(
    'a match they won together is not a draw between them',
    headToHead(world([mates]), 'pa', 'pc').met === 0,
  );

  const level = played(
    'd3',
    '2026-09-20',
    ['pa'],
    ['pc'],
    [
      { id: '5', t: 'goal', team: 'A', pid: 'pa', min: 3, at: 3 },
      { id: '6', t: 'goal', team: 'B', pid: 'pc', min: 4, at: 4 },
    ],
  );
  eq('a drawn meeting is a draw, not a win', headToHead(world([level]), 'pa', 'pc').draws, 1);

  /* ------------------------------------------------------------ scoring */
  const d = duelBetween(world([opp, mates]), 'pa', 'pc')!;
  /* Not every category — the ones this *pairing* allows. Both are midfielders
     here, so clean sheets are not among them. */
  eq(
    'a duel scores the categories its pairing allows',
    d.rows.length,
    categoriesFor(d.a.pos, d.b.pos).length,
  );
  ok('and never more than the catalogue holds', d.rows.length <= DUEL_CATEGORIES.length);
  ok(
    'the score is how many categories each side leads',
    d.scoreA === d.rows.filter((r) => r.winner === 'a').length &&
      d.scoreB === d.rows.filter((r) => r.winner === 'b').length,
  );
  ok(
    'a level category is won by nobody',
    d.rows.every((r) => (r.a === r.b ? r.winner === null : r.winner !== null)),
  );
  ok(
    'and a drawn category is counted for neither side',
    d.scoreA + d.scoreB + d.rows.filter((r) => r.winner === null).length === d.rows.length,
  );
  eq(
    'the leader is whoever leads on categories',
    d.leader,
    d.scoreA > d.scoreB ? 'a' : d.scoreB > d.scoreA ? 'b' : null,
  );

  /* Three for a win, one for a draw — the same arithmetic the form card uses. */
  eq('form is read as points', formPoints(['W', 'W', 'D', 'L', 'W']), 10);
  eq('and an empty run is worth nothing', formPoints([]), 0);

  /* ------------------------------------------- position-aware categories */
  /**
   * The rule this exists to enforce, in the user's own words: nobody should
   * lose a duel to a goalkeeper on clean sheets, and no goalkeeper should lose
   * one on goals.
   */
  const idsFor = (x: Position, y: Position) => categoriesFor(x, y).map((c) => c.id);

  ok('two keepers are judged on clean sheets', idsFor('GK', 'GK').includes('cleans'));
  ok('and never on goals', !idsFor('GK', 'GK').includes('goals'));

  ok(
    'a keeper against an outfielder is not judged on clean sheets',
    !idsFor('GK', 'MID').includes('cleans'),
  );
  ok(
    'nor on goals, in either order',
    !idsFor('MID', 'GK').includes('goals') && !idsFor('GK', 'ATT').includes('goals'),
  );
  eq('that pairing runs on what applies to anybody', idsFor('GK', 'MID'), [
    'rating',
    'form',
    'motm',
    'wins',
    'apps',
  ]);

  ok(
    'two defenders get clean sheets, because the caveat is symmetrical',
    idsFor('DEF', 'DEF').includes('cleans'),
  );
  ok(
    'an outfield pairing is never judged on clean sheets',
    !idsFor('MID', 'DEF').includes('cleans'),
  );

  eq('an attacking duel opens on goals', idsFor('ATT', 'MID')[0], 'goals');
  eq('a midfield duel opens on assists', idsFor('MID', 'MID')[0], 'assists');
  eq('a defensive duel opens on clean sheets', idsFor('DEF', 'DEF')[0], 'cleans');

  ok(
    'the pairing is symmetrical — the same two players, whichever way round',
    JSON.stringify(idsFor('ATT', 'DEF').slice().sort()) ===
      JSON.stringify(idsFor('DEF', 'ATT').slice().sort()),
  );
  ok(
    'and every pairing is offered at least five categories',
    (['GK', 'DEF', 'MID', 'ATT'] as Position[]).every((x) =>
      (['GK', 'DEF', 'MID', 'ATT'] as Position[]).every((y) => categoriesFor(x, y).length >= 5),
    ),
  );

  const gkDuel = duelBetween(
    world([opp], [player('pk', { pos: 'GK' }), player('pk2', { pos: 'GK' }), ...P]),
    'pk',
    'pk2',
  )!;
  eq(
    'a duel scores exactly the categories its pairing allows',
    gkDuel.rows.length,
    categoriesFor('GK', 'GK').length,
  );
  eq('and says which pairing it is', gkDuel.pairing, 'GK vs GK');

  ok('a duel needs two real players', duelBetween(world([opp]), 'pa', 'nobody') === null);
  ok('and a club with no goals has no duel', topDuel(world([])) === null);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log('\nFAILURES:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
