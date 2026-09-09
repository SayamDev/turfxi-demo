import type { AppState, CardMod, Player, Tier } from '../types';
import type { IconName } from '../../shared/components/Icon';
import { clamp } from '../utils';
import { playerStats } from './stats';
import { cardRole, ROLE_LABEL } from './roles';
import { fantasyPts } from './fantasy';
import { honoursActive, starActive } from './honours';
import { seasonPoints } from './honours';

/**
 * The rating engine — deliberately honest.
 *
 * There are no invented attributes here: no pace, no passing, no defending.
 * Nobody is timing sprints on a Sunday pitch, so the app refuses to make
 * numbers up. A player's rating is the one thing the club genuinely decides
 * — the season rating earned match by match in the Ratings Room — and every
 * other figure on a card is a real, counted event.
 */

/** Everyone starts a season here and earns the rest. */
export const SEASON_START = 60;

export const TIERS: Record<string, Tier> = {
  elite: {
    key: 'elite',
    name: 'GOLD ELITE',
    min: 90,
    blurb: 'Gold Elite — the very best in the club',
  },
  gold: { key: 'gold', name: 'GOLD', min: 78, blurb: 'Gold tier — a top player' },
  silver: { key: 'silver', name: 'SILVER', min: 69, blurb: 'Silver tier — a solid regular' },
  bronze: { key: 'bronze', name: 'BRONZE', min: 0, blurb: 'Bronze tier — building up' },
};

export const TIER_ORDER = ['bronze', 'silver', 'gold', 'elite'] as const;

export function tierOf(rating: number): Tier {
  return rating >= 90
    ? TIERS.elite
    : rating >= 78
      ? TIERS.gold
      : rating >= 69
        ? TIERS.silver
        : TIERS.bronze;
}

/** How far to the next tier — the "one good run away" hook. */
export function tierProgress(p: Player): { next: Tier; gap: number } | null {
  const order = TIER_ORDER.map((k) => TIERS[k]);
  const cur = tierOf(p.rating);
  const next = order[order.indexOf(cur) + 1];
  if (!next) return null;
  return { next, gap: next.min - p.rating };
}

/** The overall shown on a card. */
export function ratingOf(state: AppState, pid: string): { ovr: number } {
  const p = state.players.find((x) => x.id === pid);
  return { ovr: typeof p?.rating === 'number' ? p.rating : SEASON_START };
}

/**
 * The four numbers every card shows — all of them really happened.
 *
 * The first slot is the only one that changes: it is what the player is worth
 * in the line they are listed in, and it is labelled with that line. Every card
 * keeps the same four slots in the same order, so no position's card is shaped
 * differently from anyone else's — which was the point. A keeper's card used to
 * open `0 GOALS · 0 ASSISTS`, two dead slots out of four, and close on a `PTS`
 * figure a formula had quietly marked down.
 *
 * **Goals and assists stay on every card.** In small-sided football defenders
 * and midfielders score regularly and keepers do occasionally, and hiding that
 * to make room would have been a worse trade than the one it replaced.
 *
 * `PTS` moves to the profile. It is the club-wide comparable the XI is picked
 * on and it still matters, but it is one scale for eleven jobs and there are
 * only four slots here.
 */
export function cardStats(state: AppState, pid: string): Array<[string, number]> {
  const st = playerStats(state, pid);
  const { role, points } = cardRole(state, pid);
  return [
    [ROLE_LABEL[role], points],
    ['GOALS', st.goals],
    ['ASSISTS', st.assists],
    ['APPS', st.apps],
  ];
}

/** Earned badges, each one from a counted event. Icon is a semantic name. */
export function cardBadges(state: AppState, pid: string): Array<[IconName, string]> {
  const st = playerStats(state, pid);
  const p = state.players.find((x) => x.id === pid);
  const out: Array<[IconName, string]> = [];
  if (st.goals >= 5) out.push(['marksman', 'Marksman']);
  if (st.assists >= 3) out.push(['assist', 'Playmaker']);
  if (st.motm >= 1) out.push(['trophy', 'MOTM' + (st.motm > 1 ? ' ×' + st.motm : '')]);
  if (st.apps >= 5 && st.attendance >= 90) out.push(['evergreen', 'Ever-present']);
  if (st.cleans >= 3) out.push(['cleanSheet', 'Clean sheets ×' + st.cleans]);
  if (st.streak >= 3) out.push(['streak', st.streak + '-win streak']);
  if (p?.totsCount) {
    out.push(['crown', 'Team of the Season' + (p.totsCount > 1 ? ' ×' + p.totsCount : '')]);
  }
  if (p?.starCount) out.push(['star', 'Star player' + (p.starCount > 1 ? ' ×' + p.starCount : '')]);
  if (p?.totwCount) out.push(['medal', 'TOTW ×' + p.totwCount]);

  /* A wider spread, so most players have something to show rather than only
     the top scorers. Milestones, discipline, loyalty and honest graft all
     count for something. */
  if (st.apps >= 1 && st.apps < 3) out.push(['wave', 'New signing']);
  if (st.apps >= 10) out.push(['award', String(st.apps) + ' appearances']);
  if (st.apps >= 25) out.push(['evergreen', 'Club veteran']);
  if (st.goals >= 1 && st.goals < 5) out.push(['goal', 'Off the mark']);
  if (st.goals >= 10) out.push(['marksman', 'Ten-goal man']);
  if (st.goals >= 25) out.push(['flame', 'Golden boot pace']);
  if (st.assists >= 8) out.push(['eye', 'Chief creator']);
  if (st.wins >= 10) out.push(['climb', String(st.wins) + ' wins']);
  if (st.apps >= 6 && st.yellows === 0 && st.reds === 0) out.push(['level', 'Never booked']);
  if (st.reds >= 1) out.push(['skull', 'Seen red']);
  if (p && p.rating >= 78) out.push(['medal', 'Silver standard']);
  if (p && p.rating >= 90) out.push(['trophy', 'Elite']);
  if (p && (p.bestRating ?? 0) > p.rating + 4) out.push(['fall', 'Past his peak']);
  if (p?.captain) out.push(['award', 'Captain']);
  if (st.attendance >= 95 && st.apps >= 5) out.push(['evergreen', 'Never misses']);
  /* Everyone in a Pro club carries the supporter mark — they kept the lights
     on, and it should be visible. */
  if (state.pro?.unlocked) out.push(['heart', 'Supporter']);
  return out;
}

/**
 * Which special design a card wears, rarest first.
 * Team of the Season is voted once a year and outranks everything.
 */
/**
 * Special card artwork is a *current* honour, not a permanent trophy.
 *
 * Team of the Season art used to stick for the rest of the season, so by the
 * time the next match was being voted on, half the squad were still walking
 * around in gold. Every special finish now lasts until the next match kicks
 * off, then the card reverts to the player's own tier — the same rule Team of
 * the Week already followed.
 */
export function cardModOf(state: AppState, pid: string): CardMod {
  /**
   * Team of the Season is kept, not lent.
   *
   * It used to be retired the moment any newer match kicked off, so the four
   * players who won the season's rarest card lost it the following Sunday and
   * went back to bronze. Team of the *Week* is a weekly honour and rightly
   * expires; the season's XI is the highest thing in the app and stays on the
   * card until a new season replaces it.
   */
  if (state.tots?.revealed && state.tots.winners.includes(pid)) return 'tots';
  /**
   * The star comes first, and on its own schedule.
   *
   * It used to be read off the same `honours` record as the Team of the Week,
   * so holding the XI back until the admin reveals it held the star card back
   * too — even though the Man of the Match had been announced to the whole club
   * hours earlier. Two different moments, two different sources.
   */
  if (starActive(state)?.pid === pid) return 'star';
  const h = honoursActive(state);
  if (h?.totw.some((x) => x.id === pid)) return 'totw';
  const d = state.players.find((x) => x.id === pid)?.formDelta ?? 0;
  if (d > 0) return 'rising';
  if (d < 0) return 'falling';
  return '';
}

/**
 * Rating progression.
 *
 * Your card moves on the mark the other players gave you this week compared
 * with the mark you got last week. Deliberately slow: the most anyone can
 * move in a single match is +3, so climbing from 60 to a Gold Elite 90 is a
 * season's work — and a bad run genuinely costs you.
 *
 *   Man of the Match ........... +3
 *   in the Team of the Week .... +2
 *   rated better than last week  +1
 *   rated the same .............  0
 *   rated worse than last week . -1
 */
export function ratingStep(p: Player, cur: number, isMotm: boolean, isTotw: boolean): number {
  if (isMotm) return 3;
  if (isTotw) return 2;
  const hist = p.ratingHist ?? [];
  const prev = hist.length ? hist[hist.length - 1] : null;
  if (prev == null) return cur >= 7 ? 1 : cur < 6 ? -1 : 0;
  if (cur > prev) return 1;
  if (cur < prev) return -1;
  return 0;
}

export function applyRatingStep(p: Player, step: number): number {
  return clamp(p.rating + step, 1, 99);
}

/** Frame accent per tier, used by the card and the pitch. */
export const TIER_COLOR: Record<string, string> = {
  elite: '#ffd76a',
  gold: '#e8c15a',
  silver: '#c8ccd6',
  bronze: '#cd7f32',
};
