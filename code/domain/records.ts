import type { AppState, Player } from '../types';
import type { IconName } from '../../shared/components/Icon';
import { playerStats } from './stats';

/**
 * The club's records, derived from the match log.
 *
 * `playerStats` opens with the sentence this file is built on: *career stats
 * derive from the immutable match history — never stored, never stale.* A
 * record is the same kind of fact, one `max()` further on, so it gets the same
 * treatment: **no column, no migration, no sync path.**
 *
 * That is not the cheap option, it is the correct one. A stored record goes
 * wrong the moment the history it summarises changes — undo a goal that was
 * logged against the wrong player and a saved "most goals in a match" stays
 * wrong until something remembers to recalculate it. A derived one is already
 * right, because there was never a second copy to disagree.
 *
 * Two scopes, and they answer different questions:
 *
 *   - **match** — the best single afternoon anybody has had. Computed from one
 *     pass over the events, in `matchLines`.
 *   - **career** — the best totals anybody has accumulated, straight off
 *     `playerStats`, which already counts every one of them.
 *
 * What is deliberately **not** here: clean sheets, tackles, saves, anything
 * defensive. Nothing per-player defensive is recorded anywhere in this app, and
 * a tile is not a reason to start inventing a metric — the same call this repo
 * already made about PHYSICAL on the squad-builder radar and the `7.8` average
 * on Stats.
 *
 * Scope is **per club**, not per person across clubs. Everything else in the
 * app is scoped to a club, `playerStats` takes an `AppState` and nothing else,
 * and a career spanning clubs would need a player identity that spans them —
 * which is not how `players` works today.
 */

export type RecordScope = 'match' | 'career';

export type RecordId =
  | 'matchGoals'
  | 'matchAssists'
  | 'matchContributions'
  | 'matchRating'
  | 'matchGain'
  | 'fastestGoal'
  | 'careerGoals'
  | 'careerAssists'
  | 'careerApps'
  | 'careerWins'
  | 'careerMotm'
  | 'careerStreak';

export interface RecordDef {
  id: RecordId;
  /** What the record is, as a club would say it out loud. */
  name: string;
  /** The unit, for the line under the figure. */
  unit: string;
  icon: IconName;
  scope: RecordScope;
  /**
   * Lower wins.
   *
   * Only the fastest goal. Kept as a flag rather than two comparison functions
   * because every other part of the reduction — ties, the earliest holder, the
   * empty case — is identical, and a second code path is a second place for
   * "which way round is better" to be wrong.
   */
  lower?: boolean;
  blurb: string;
}

/**
 * The twelve.
 *
 * Every one is a `max()` (or a `min()`) over something the app already counts.
 * Nothing here needs a number that is not already in the match log, which is
 * the test any thirteenth has to pass.
 */
export const RECORDS: RecordDef[] = [
  {
    id: 'matchGoals',
    name: 'Most goals in a match',
    unit: 'goals',
    icon: 'marksman',
    scope: 'match',
    blurb: 'One afternoon, one player, the most that has gone in.',
  },
  {
    id: 'matchAssists',
    name: 'Most assists in a match',
    unit: 'assists',
    icon: 'assist',
    scope: 'match',
    blurb: 'The best supporting performance the club has recorded.',
  },
  {
    id: 'matchContributions',
    name: 'Most involvements in a match',
    unit: 'G+A',
    icon: 'ball',
    scope: 'match',
    blurb: 'Goals and assists together — everything they had a hand in.',
  },
  {
    id: 'matchRating',
    name: 'Highest match rating',
    unit: 'out of 10',
    icon: 'star',
    scope: 'match',
    blurb: 'The best mark the club has ever given anybody after a match.',
  },
  {
    id: 'matchGain',
    name: 'Biggest rating jump',
    unit: 'points',
    icon: 'climb',
    scope: 'match',
    blurb: 'What one performance did to a season rating.',
  },
  {
    id: 'fastestGoal',
    name: 'Fastest goal',
    unit: 'minutes',
    icon: 'timer',
    scope: 'match',
    lower: true,
    blurb: 'The earliest minute anybody has scored in.',
  },
  {
    id: 'careerGoals',
    name: 'Most goals',
    unit: 'goals',
    icon: 'goal',
    scope: 'career',
    blurb: "The club's all-time leading scorer.",
  },
  {
    id: 'careerAssists',
    name: 'Most assists',
    unit: 'assists',
    icon: 'eye',
    scope: 'career',
    blurb: 'Who has set up the most.',
  },
  {
    id: 'careerApps',
    name: 'Most appearances',
    unit: 'matches',
    icon: 'evergreen',
    scope: 'career',
    blurb: 'The one who keeps turning up.',
  },
  {
    id: 'careerWins',
    name: 'Most wins',
    unit: 'wins',
    icon: 'trophy',
    scope: 'career',
    blurb: 'Whichever side they are put on, it tends to win.',
  },
  {
    id: 'careerMotm',
    name: 'Most man of the match awards',
    unit: 'awards',
    icon: 'medal',
    scope: 'career',
    blurb: 'Voted the best on the pitch, most often.',
  },
  {
    id: 'careerStreak',
    name: 'Longest win streak',
    unit: 'wins in a row',
    icon: 'streak',
    scope: 'career',
    blurb: 'The longest anybody has gone without losing or drawing.',
  },
];

/**
 * One player's afternoon, reduced from the events of one finished match.
 *
 * The single source both halves of this feature read: records take a `max()`
 * over these, and `achievements.ts` asks the same rows whether anybody has ever
 * had three in a game. Counting twice, in two files, is how the badge and the
 * record end up disagreeing about the same Sunday.
 */
export interface MatchLine {
  pid: string;
  fid: string;
  date: string;
  goals: number;
  assists: number;
  /** Goals and assists together. */
  contributions: number;
  /** The mark out of 10 the club gave, once the ratings settled. */
  rating: number | null;
  /** What the match did to their season rating, out of 100. */
  gain: number | null;
  /** The earliest minute they scored in, if they scored at all. */
  firstGoalMin: number | null;
}

/**
 * Every player-match in the club's history that has something to record.
 *
 * Only finished matches — a game in progress is not a record until it is over,
 * and a hat-trick that gets undone at half time was never one. A player with a
 * quiet, unrated match produces no line at all: nothing they did can be the
 * best of anything, and an empty row would only have to be filtered out again
 * at every call site.
 */
export function matchLines(state: AppState): MatchLine[] {
  const out: MatchLine[] = [];

  for (const fx of state.fixtures) {
    if (!fx.match.finished) continue;
    const per = new Map<string, MatchLine>();
    const line = (pid: string): MatchLine => {
      let l = per.get(pid);
      if (!l) {
        l = {
          pid,
          fid: fx.id,
          date: fx.date,
          goals: 0,
          assists: 0,
          contributions: 0,
          rating: null,
          gain: null,
          firstGoalMin: null,
        };
        per.set(pid, l);
      }
      return l;
    };

    for (const e of fx.match.events) {
      /* Goals and penalties only. An own goal is on the event log under the
         scorer's id and counts for the *other* side — crediting it here would
         put "most goals in a match" on the worst afternoon of somebody's life. */
      if (e.t !== 'goal' && e.t !== 'pen') continue;
      if (e.pid) {
        const l = line(e.pid);
        l.goals++;
        l.firstGoalMin = l.firstGoalMin === null ? e.min : Math.min(l.firstGoalMin, e.min);
      }
      if (e.assist) line(e.assist).assists++;
    }

    for (const r of fx.ratings.results?.rows ?? []) {
      const l = line(r.pid);
      l.rating = r.a;
      if (r.ratingBefore != null && r.ratingAfter != null) {
        l.gain = r.ratingAfter - r.ratingBefore;
      }
    }

    for (const l of per.values()) {
      l.contributions = l.goals + l.assists;
      out.push(l);
    }
  }

  return out;
}

/** The best single match a player has had, in each of the match-scope measures. */
export interface MatchBests {
  goals: number;
  assists: number;
  contributions: number;
  rating: number | null;
  gain: number | null;
  fastestGoal: number | null;
}

export function matchBests(state: AppState, pid: string): MatchBests {
  return bestsFrom(matchLines(state).filter((l) => l.pid === pid));
}

function bestsFrom(lines: MatchLine[]): MatchBests {
  const best: MatchBests = {
    goals: 0,
    assists: 0,
    contributions: 0,
    rating: null,
    gain: null,
    fastestGoal: null,
  };
  for (const l of lines) {
    best.goals = Math.max(best.goals, l.goals);
    best.assists = Math.max(best.assists, l.assists);
    best.contributions = Math.max(best.contributions, l.contributions);
    if (l.rating != null)
      best.rating = best.rating == null ? l.rating : Math.max(best.rating, l.rating);
    if (l.gain != null) best.gain = best.gain == null ? l.gain : Math.max(best.gain, l.gain);
    if (l.firstGoalMin != null) {
      best.fastestGoal =
        best.fastestGoal == null ? l.firstGoalMin : Math.min(best.fastestGoal, l.firstGoalMin);
    }
  }
  return best;
}

/** One player's claim on one record. */
export interface RecordEntry {
  pid: string;
  value: number;
  /** The match it happened in. Null for a career total, which has no one match. */
  fid: string | null;
  date: string | null;
}

export interface RecordStanding {
  def: RecordDef;
  /** The club record. Null until somebody has one. */
  best: RecordEntry | null;
  /**
   * Everybody level with it, the holder included.
   *
   * A record can be shared, and two players on four goals each is the normal
   * case in a small club rather than an edge one. Picking a single holder out
   * of a tie would settle it on whichever order `players` happens to be in.
   */
  shared: string[];
  /** The player asked about, if one was. */
  mine: RecordEntry | null;
  /** They are on it — alone or level with somebody else. */
  held: boolean;
  /** Every claim, best first. The full board behind the headline. */
  entries: RecordEntry[];
}

type CareerStats = ReturnType<typeof playerStats>;

const CAREER_VALUE: Record<string, (st: CareerStats) => number> = {
  careerGoals: (st) => st.goals,
  careerAssists: (st) => st.assists,
  careerApps: (st) => st.apps,
  careerWins: (st) => st.wins,
  careerMotm: (st) => st.motm,
  careerStreak: (st) => st.longestStreak,
};

/**
 * Every player's best claim on one record.
 *
 * A player appears at most once: their own best afternoon for a match record,
 * their total for a career one. Zero never counts — "most goals in a match: 0"
 * is not a record, it is an empty club.
 *
 * The career totals arrive already computed. `playerStats` walks the whole
 * fixture list every call, so working them out inside here meant six records ×
 * every player scans of the same history to answer one question about it.
 */
function entriesFor(
  def: RecordDef,
  lines: MatchLine[],
  roster: Player[],
  career: Map<string, CareerStats>,
): RecordEntry[] {
  const byPlayer = new Map<string, RecordEntry>();

  if (def.scope === 'career') {
    const read = CAREER_VALUE[def.id];
    if (!read) return [];
    for (const p of roster) {
      const st = career.get(p.id);
      const value = st ? read(st) : 0;
      if (value <= 0) continue;
      byPlayer.set(p.id, { pid: p.id, value, fid: null, date: null });
    }
  } else {
    const named = new Set(roster.map((p) => p.id));
    for (const l of lines) {
      /* A departed player's events stay in the log; their record does not
         belong on a board of the current squad. */
      if (!named.has(l.pid)) continue;
      const value = matchValue(def, l);
      if (value == null) continue;
      const held = byPlayer.get(l.pid);
      if (!held || better(def, value, held.value)) {
        byPlayer.set(l.pid, { pid: l.pid, value, fid: l.fid, date: l.date });
      }
    }
  }

  return [...byPlayer.values()].sort((a, b) => {
    if (a.value !== b.value) return better(def, a.value, b.value) ? -1 : 1;
    /* Level on the number: whoever did it first holds it. Any other tiebreak
       would let a record change hands without anybody doing anything. */
    return (a.date ?? '') < (b.date ?? '') ? -1 : (a.date ?? '') > (b.date ?? '') ? 1 : 0;
  });
}

function matchValue(def: RecordDef, l: MatchLine): number | null {
  switch (def.id) {
    case 'matchGoals':
      return l.goals > 0 ? l.goals : null;
    case 'matchAssists':
      return l.assists > 0 ? l.assists : null;
    case 'matchContributions':
      return l.contributions > 0 ? l.contributions : null;
    case 'matchRating':
      return l.rating;
    /* A rating that went nowhere, or backwards, is not a jump. */
    case 'matchGain':
      return l.gain != null && l.gain > 0 ? l.gain : null;
    case 'fastestGoal':
      return l.firstGoalMin;
    default:
      return null;
  }
}

const better = (def: RecordDef, a: number, b: number): boolean => (def.lower ? a < b : a > b);

/**
 * Where the club stands on every record, and where one player stands in it.
 *
 * Pending players are left out throughout: an invitation that has not been
 * accepted has no matches behind it, and listing it would put an empty name on
 * a board of achievements.
 */
export function clubRecords(state: AppState, pid?: string): RecordStanding[] {
  const lines = matchLines(state);
  const roster = state.players.filter((p) => !p.pending);
  const career = new Map(roster.map((p) => [p.id, playerStats(state, p.id)] as const));

  return RECORDS.map((def) => {
    const entries = entriesFor(def, lines, roster, career);
    const best = entries[0] ?? null;
    const shared = best ? entries.filter((e) => e.value === best.value).map((e) => e.pid) : [];
    const mine = pid ? (entries.find((e) => e.pid === pid) ?? null) : null;
    return {
      def,
      best,
      shared,
      mine,
      held: !!pid && shared.includes(pid),
      entries,
    };
  });
}

/**
 * A record's figure, written the way it is read.
 *
 * The two that are not plain counts are the two most easily misread: a match
 * rating is the out-of-ten mark a club gave on the night, **not** the
 * out-of-a-hundred season rating shown everywhere else, and a rating jump only
 * means anything with its sign on the front.
 */
export function recordValue(def: RecordDef, value: number): string {
  switch (def.id) {
    case 'matchRating':
      return value.toFixed(1);
    case 'matchGain':
      return '+' + value;
    case 'fastestGoal':
      return value + "'";
    default:
      return String(value);
  }
}
