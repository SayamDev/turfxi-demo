/**
 * Which matches still need their detail fetching.
 *
 * ## Why this exists
 *
 * `pullClub` asked for the club's entire history on every single sync: every
 * fixture ever played, and every child row of every one of them. That is fine
 * in week one and quietly ruinous by week forty, because the cost grows with
 * the season rather than with what changed.
 *
 * Ratings are what make it bite. The table holds one row per rater per rated
 * player, so a ten-a-side match writes about ninety rows — roughly 3,600 by the
 * end of a season, on top of the events, predictions, RSVPs and banter. And a
 * realtime event triggers a full sync, so a goal in a live match had ten phones
 * each downloading the whole season. The busiest moment of the week was also
 * the most expensive, and got worse every week.
 *
 * ## The rule
 *
 * Fixture *rows* are still pulled in full — a season is a few dozen rows and
 * they are what tells us what changed. Only the **children** are narrowed, and
 * only for matches that are genuinely finished with.
 *
 * A match is "hot" — worth re-fetching in full — when any of these hold:
 *
 *   - we have no local copy of it at all
 *   - it has not finished, so people are still answering, predicting and
 *     posting, none of which touches the fixture row itself
 *   - its own row changed since the last sync
 *   - it is one of the few most recent, which is where the ratings, the
 *     payments and the banter still move
 *
 * Everything else keeps the children already on the device. They came from the
 * same mappers and round-trip losslessly, which `tests/sync.ts` asserts.
 *
 * ## What this trades away
 *
 * A child row *deleted* on the server for a cold fixture would linger locally
 * until the next full pull. The three things the app can delete — match events,
 * banter and RSVPs — are all reconciled on active fixtures, and every app
 * launch starts with a full pull, so the window is one session on a match
 * nobody is touching. That is the honest cost of not downloading a season
 * every few seconds.
 */

/** How many recent matches stay fully fresh regardless of what changed. */
export const KEEP_WARM = 3;

export interface FixtureFreshness {
  id: string;
  /** ISO timestamp from the fixture row. */
  updatedAt: string;
  finished: boolean;
  /** ISO date, used only to find the most recent few. */
  date: string;
}

export interface FreshnessInput {
  rows: FixtureFreshness[];
  /** Fixtures already on the device, with their children. */
  haveLocally: Set<string>;
  /**
   * When this device last pulled, in ms. `null` means never — a cold start, a
   * new club, or a session that has been reset — and pulls everything.
   */
  since: number | null;
}

export function hotFixtureIds(input: FreshnessInput): string[] {
  const { rows, haveLocally, since } = input;

  /* No baseline means no way to know what moved. Ask for all of it once, then
     never again this session. Deliberately not persisted: one full pull per
     app launch is cheap, and it repairs any drift the rules below could
     accumulate. */
  if (since === null) return rows.map((r) => r.id);

  const recent = new Set(
    [...rows]
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .slice(-KEEP_WARM)
      .map((r) => r.id),
  );

  return rows
    .filter((r) => {
      if (!haveLocally.has(r.id)) return true;
      if (!r.finished) return true;
      if (recent.has(r.id)) return true;
      const moved = Date.parse(r.updatedAt);
      /* An unparseable timestamp is not evidence of staleness, but it is not
         evidence of freshness either — so re-fetch rather than trust it. */
      return Number.isNaN(moved) || moved > since;
    })
    .map((r) => r.id);
}
