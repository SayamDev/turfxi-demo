import type { AppState, Fixture, Player } from '../types';
import { rsvpLists } from './waitlist';
import { motmStatus } from './motm';
import { matchState } from './participation';
import { ratingWindow, trustedProgress } from './consensus';
import { score } from './match';
import { money } from '../utils';
import type { ChecklistAction } from './checklist';

/**
 * The matchday as a state machine.
 *
 * The checklists that came before this worked, but each rule computed its own
 * answer inline, so "what happens next" was spread across a long if-chain and
 * adding a stage meant re-reading all of it. Here every task declares what it
 * needs and how it finishes, and one evaluator resolves the graph.
 *
 * The rules that matter are invariants, not preferences, and they are the same
 * ones RULES.md has always claimed:
 *
 *   - exactly one task is `active` for a given person at a time
 *   - a task nobody can act on is never `active`
 *   - progress only counts tasks that person could actually do
 *
 * They are asserted in the tests rather than trusted.
 */

export type TaskState =
  /** Dependencies unmet — not shown as actionable. */
  | 'locked'
  /** Unlocked, but it belongs to someone else. Shown, never highlighted. */
  | 'waiting'
  /** Yours, now. At most one of these per person. */
  | 'active'
  | 'completed'
  /** The window shut before it was done. Kept for the record, never counted. */
  | 'expired'
  /** Deliberately bypassed — a force-closed rating round. */
  | 'skipped'
  /** The fixture it belonged to went away. */
  | 'cancelled'
  /** Still doable, but past its deadline. */
  | 'overdue';

export type WorkflowRole =
  | 'admin'
  | 'captain'
  | 'player'
  | 'participant'
  /**
   * Appointed to submit marks on behalf of someone who never did.
   *
   * A role you are given mid-matchday rather than one you hold, so it cannot
   * be derived from the squad — it has to be read off the consensus round.
   */
  | 'trusted'
  /**
   * Asked to help pick the teams, this fixture only.
   *
   * Like `trusted`, a role you are *given* mid-matchday rather than one you
   * hold, so it cannot be derived from the squad — it is read off the fixture.
   */
  | 'adviser';

export type PhaseId =
  | 'availability'
  | 'squad'
  | 'teams'
  | 'reveal'
  | 'predictions'
  | 'live'
  | 'motm'
  | 'ratings'
  | 'honours'
  | 'settle';

export interface Phase {
  id: PhaseId;
  name: string;
  /** Every task in this phase is finished or closed. */
  complete: boolean;
  /** The match is here now. */
  current: boolean;
  taskIds: string[];
}

/**
 * The two halves of a matchday.
 *
 * Everything before the final whistle is one job — getting eleven people onto
 * a pitch — and everything after it is a different one. They were always
 * separate lists, and collapsing them into a single stream of nineteen tasks
 * meant a card headed "After full time" listed the RSVP chasing and the team
 * picking from four days earlier, all ticked, above the two things actually
 * outstanding.
 */
export type Stage = 'pre' | 'post';

export const STAGE_OF: Record<PhaseId, Stage> = {
  availability: 'pre',
  squad: 'pre',
  teams: 'pre',
  reveal: 'pre',
  predictions: 'pre',
  live: 'pre',
  motm: 'post',
  ratings: 'post',
  honours: 'post',
  settle: 'post',
};

export const PHASES: { id: PhaseId; name: string }[] = [
  { id: 'availability', name: 'Availability' },
  { id: 'squad', name: 'Squad' },
  { id: 'teams', name: 'Teams' },
  { id: 'reveal', name: 'Line-ups' },
  { id: 'predictions', name: 'Predictions' },
  { id: 'live', name: 'Match' },
  { id: 'motm', name: 'MOTM' },
  { id: 'ratings', name: 'Ratings' },
  { id: 'honours', name: 'Team of the Week' },
  { id: 'settle', name: 'Wrap up' },
];

/** Everything a rule needs, worked out once per evaluation. */
interface Ctx {
  state: AppState;
  fx: Fixture;
  me: Player | undefined;
  isAdmin: boolean;
  isCaptain: boolean;
  played: boolean;
  lists: ReturnType<typeof rsvpLists>;
  motm: ReturnType<typeof motmStatus>;
  match: ReturnType<typeof matchState>;
  ratings: ReturnType<typeof ratingWindow>;
  now: number;
}

interface TaskDef {
  id: string;
  name: string;
  /**
   * The row's title, when it reads differently depending on who is looking.
   *
   * `hint` was made role-aware and `name` was not, so a plain player still read
   * "Sort your line-up" — an instruction, in the imperative, for a job they
   * cannot do — with a softer explanation underneath contradicting it. The
   * title is the part people actually read.
   */
  nameFor?: (c: Ctx) => string;
  /**
   * There is something worth opening here even when it is not your move.
   *
   * Kept separate from `actionable` on purpose. `actionable` means "this is
   * yours to do now" and is what picks the single next step, so widening it to
   * cover "you may look" would tell an admin their next job is a captain's.
   * Tappable and actionable are different questions.
   */
  openWhenWaiting?: boolean;
  phase: PhaseId;
  role: WorkflowRole;
  /** Task ids that must be `completed` (or closed) before this unlocks. */
  deps: string[];
  /**
   * A precondition that is nobody's task.
   *
   * Depending on another *task* only works when that task means the same thing
   * to everyone looking. "Sort your line-up" does not: it is each captain's own
   * side, so to an admin — who captains neither — it read as already done, and
   * the reveal unlocked before a single captain had confirmed anything. A gate
   * asks the fixture instead of asking a role.
   */
  gate?: (c: Ctx) => boolean;
  /** Lower sorts first when several are actionable. */
  priority: number;
  /** Never blocks anything and never gates a phase. */
  optional?: boolean;
  /** Where tapping it goes. */
  action: ChecklistAction;
  done: (c: Ctx) => boolean;
  /** The chance has gone — shown for the record, excluded from progress. */
  gone?: (c: Ctx) => boolean;
  /** Deliberately bypassed rather than done. */
  skipped?: (c: Ctx) => boolean;
  deadline?: (c: Ctx) => number | null;
  hint: (c: Ctx) => string;
}

const MIN_SQUAD = 4;

/** Nobody lost, so nobody owes a forfeit. */
function isDraw(fx: Fixture): boolean {
  const [a, b] = score(fx);
  return fx.match.finished && a === b;
}

/**
 * The graph.
 *
 * Ordered by priority, which is also the order a matchday actually happens in
 * — so the list reads as the sequence rather than needing to be sorted mentally.
 */
const TASKS: TaskDef[] = [
  {
    id: 'rsvp',
    name: 'Say if you can play',
    phase: 'availability',
    role: 'player',
    deps: [],
    priority: 10,
    action: 'rsvp',
    done: (c) => !!c.me && !!c.fx.rsvps[c.me.id],
    gone: (c) => c.fx.flow.confirmed && !!c.me && !c.fx.rsvps[c.me.id],
    hint: () => 'In, maybe, or out',
  },
  {
    id: 'chase',
    name: 'Chase the quiet ones',
    phase: 'availability',
    role: 'admin',
    deps: [],
    priority: 20,
    optional: true,
    action: 'chase',
    done: (c) => c.lists.none.length === 0,
    gone: (c) => c.fx.flow.confirmed,
    hint: (c) => `${c.lists.none.length} still haven't answered`,
  },
  {
    id: 'confirm',
    name: 'Confirm the squad',
    phase: 'squad',
    role: 'admin',
    deps: ['rsvp'],
    priority: 30,
    action: 'confirm',
    done: (c) => c.fx.flow.confirmed,
    hint: (c) =>
      c.lists.playing.length < MIN_SQUAD
        ? `Need ${MIN_SQUAD - c.lists.playing.length} more before you can confirm`
        : `${c.lists.playing.length} in`,
  },
  {
    id: 'teams',
    name: 'Pick the teams',
    phase: 'teams',
    role: 'admin',
    deps: ['confirm'],
    priority: 40,
    action: 'squads',
    done: (c) => !!c.fx.teams,
    hint: () => 'Split the squad, or auto-balance',
  },
  /**
   * The favour somebody was asked for.
   *
   * **Optional, both of them, and that is not a detail.** Nobody's matchday is
   * incomplete because no one advised: a required task here would land in
   * `adminOutstanding` and quietly refuse the admin the next fixture until a
   * friend got round to answering a favour. Optional also keeps both rows out
   * of everybody else's list — `workflowRows` only carries other people's
   * tasks when they are required and waiting — so asking Liam for a hand adds
   * nothing to anyone's counter but Liam's.
   */
  {
    id: 'adviseAnswer',
    name: 'Say if you can help pick the teams',
    phase: 'teams',
    role: 'adviser',
    deps: [],
    optional: true,
    priority: 35,
    action: 'squads',
    /* Answered either way. A no is a finished job, not a failed one. */
    done: (c) => c.fx.adviserAccepted != null,
    /* The question goes with the teams. Once they exist there is nothing left
       to advise on. */
    gone: (c) => !!c.fx.teams,
    hint: () => 'The admin asked for a hand. You can say no.',
  },
  {
    id: 'adviseSuggest',
    name: 'Suggest a split',
    phase: 'teams',
    role: 'adviser',
    deps: ['adviseAnswer', 'confirm'],
    optional: true,
    priority: 36,
    action: 'squads',
    gate: (c) => c.fx.adviserAccepted === true,
    done: (c) => c.fx.squadProposal?.by === c.me?.id,
    /* Declined is `skipped`, not `expired`. The engine reserves expiry for a
       window that shut on somebody — nothing shut here, they said no, which is
       exactly what "deliberately bypassed" means. */
    skipped: (c) => c.fx.adviserAccepted === false,
    gone: (c) => !!c.fx.teams,
    hint: () => 'The admin decides whether to use it',
  },
  {
    id: 'captains',
    name: 'Assign captains',
    phase: 'teams',
    role: 'admin',
    deps: ['teams'],
    priority: 50,
    action: 'squads',
    done: (c) => !!c.fx.teams?.A.cap && !!c.fx.teams?.B.cap,
    hint: () => 'One for each side',
  },
  {
    id: 'formation',
    name: 'Sort your line-up',
    /* Whose job it is, in the title. An imperative aimed at somebody who
       cannot act on it is not a softer instruction, it is a wrong one. */
    nameFor: (c) => {
      const t = c.fx.teams;
      const mine = c.me && t && (t.A.cap === c.me.id || t.B.cap === c.me.id);
      if (mine) return 'Sort your line-up';
      return c.isAdmin ? 'Check the line-ups' : 'View the line-ups';
    },
    /* Everyone can open the line-up. The admin may need to take a side over,
       and a player is entitled to see the shape they are playing in — the
       screen itself is what refuses the edits, and it already does. */
    openWhenWaiting: true,
    phase: 'teams',
    role: 'captain',
    deps: ['captains'],
    priority: 60,
    action: 'lineup',
    /**
     * A captain answers for their own side; everybody else is watching both.
     *
     * The `: true` this replaces is what broke the list. To anyone who wasn't
     * a captain — the admin, most of all — an untouched line-up read as
     * finished, so "Line-ups revealed" could tick while "Set your team's
     * formation" was still sitting there unticked underneath it.
     */
    done: (c) => {
      const t = c.fx.teams;
      if (!t) return false;
      const mine = c.me && t.A.cap === c.me.id ? 'A' : c.me && t.B.cap === c.me.id ? 'B' : null;
      return mine ? !!t[mine].ready : !!t.A.ready && !!t.B.ready;
    },
    /* Once the line-ups are out the shape is public; there is nothing left
       to confirm. */
    gone: (c) => c.fx.flow.revealed,
    /**
     * The same row means three different things, so it says three things.
     *
     * One line written for a captain was shown to everybody: an admin and a
     * plain player both read "Arrange your side, then confirm it" about a side
     * that is not theirs and a job they cannot do. The row is worth keeping for
     * all three — it is how the club sees where the matchday has got to — but
     * only the captain is being asked for anything.
     */
    hint: (c) => {
      const t = c.fx.teams;
      const mine = c.me && t && (t.A.cap === c.me.id || t.B.cap === c.me.id);
      if (mine) return 'Arrange your side, then confirm it';
      if (c.isAdmin) {
        const waiting = t
          ? (['A', 'B'] as const).filter((k) => !t[k].ready).map((k) => t[k].name)
          : [];
        return waiting.length
          ? `${waiting.join(' and ')} still to confirm — open it to take over`
          : 'Both sides are set — take a look before you reveal';
      }
      return 'See how your captain is lining the team up';
    },
  },
  {
    id: 'reveal',
    name: 'Reveal the line-ups',
    phase: 'reveal',
    role: 'admin',
    /* Waits on the captains — see the gate below. Revealing while somebody is
       still dragging players around publishes a team that is not finished. */
    deps: ['captains'],
    priority: 70,
    action: 'reveal',
    /* Both captains, objectively — not "the captains task looks done from
       where I'm standing". */
    gate: (c) => !!c.fx.teams?.A.ready && !!c.fx.teams?.B.ready,
    done: (c) => c.fx.flow.revealed,
    hint: (c) => {
      const t = c.fx.teams;
      if (!t) return 'Pick the teams first';
      const waiting = [t.A, t.B].filter((x) => !x.ready).map((x) => x.name);
      return waiting.length
        ? `Waiting on ${waiting.join(' and ')} to confirm the shape`
        : 'Makes the teams public and opens predictions';
    },
  },
  {
    id: 'predict',
    name: 'Call the score',
    phase: 'predictions',
    role: 'player',
    deps: ['reveal'],
    priority: 80,
    action: 'predict',
    done: (c) => !!c.me && !!c.fx.predictions[c.me.id],
    gone: (c) => c.fx.match.started && !!c.me && !c.fx.predictions[c.me.id],
    hint: () => 'Locks at kick-off. Exact score is worth +0.5',
  },
  {
    id: 'kickoff',
    name: 'Kick off',
    phase: 'live',
    role: 'admin',
    deps: ['reveal'],
    priority: 90,
    action: 'kickoff',
    done: (c) => c.fx.match.started,
    hint: (c) =>
      Object.keys(c.fx.predictions).length === 0
        ? 'Needs at least one prediction first'
        : 'Start the match',
  },
  {
    id: 'fulltime',
    name: 'Run the match',
    phase: 'live',
    role: 'admin',
    deps: ['kickoff'],
    priority: 100,
    action: 'kickoff',
    done: (c) => c.fx.match.finished,
    hint: () => 'Record the goals, then blow for full time',
  },
  {
    id: 'motm',
    name: 'Vote for Man of the Match',
    phase: 'motm',
    role: 'participant',
    deps: ['fulltime'],
    priority: 110,
    action: 'vote',
    done: (c) => !!c.me && !!c.fx.motm.votes[c.me.id],
    /* A vote you never cast before it settled is a chance missed, not a job
       you still owe — this is what used to strand people on "1 to go". */
    gone: (c) => c.motm.settled && !!c.me && !c.fx.motm.votes[c.me.id],
    deadline: (c) => c.fx.motm.closesAt || null,
    hint: () => 'One vote each, changeable until it closes',
  },
  {
    id: 'closevote',
    name: 'Close the vote',
    phase: 'motm',
    role: 'admin',
    deps: ['fulltime'],
    priority: 115,
    optional: true,
    action: 'vote',
    done: (c) => c.motm.settled,
    hint: () => 'Or let the 12-hour window run out',
  },
  {
    id: 'rate',
    name: 'Rate the players',
    phase: 'ratings',
    role: 'participant',
    deps: ['motm'],
    priority: 120,
    action: 'rate',
    done: (c) => !!c.me && !!c.fx.ratings.ratedBy[c.me.id],
    gone: (c) => !!c.fx.ratings.closed && !!c.me && !c.fx.ratings.ratedBy[c.me.id],
    deadline: (c) => c.fx.ratings.closesAt ?? null,
    hint: (c) => {
      const total = c.match.participants.length - 1;
      return total > 0 ? `Everyone who played, all at once — ${total} of them` : 'All at once';
    },
  },
  {
    id: 'chaseratings',
    name: 'Chase the missing ratings',
    phase: 'ratings',
    role: 'admin',
    deps: ['motm'],
    priority: 125,
    optional: true,
    action: 'rate',
    /* Nothing to chase once everyone has rated — or once the window has shut,
       at which point they are missing rather than late and recovery takes
       over. */
    done: (c) => c.ratings.outstanding.length === 0,
    gone: (c) => c.ratings.expired || !!c.fx.ratings.closed,
    deadline: (c) => c.fx.ratings.closesAt ?? null,
    hint: (c) => `${c.ratings.outstanding.length} still to rate`,
  },
  {
    /**
     * The job an appointed stand-in has been given.
     *
     * There was no task for it at all: the admin picked somebody, they were
     * notified, and then the app told them they had nothing to do. Their own
     * task list said the matchday was finished with while the whole club was
     * waiting on them.
     *
     * It is `gate`d on a recovery round actually existing, so before one
     * starts the row is locked and belongs to nobody, and `workflowRows` keeps
     * it off everyone's list.
     */
    id: 'standin',
    name: 'Rate for the players who missed the deadline',
    phase: 'ratings',
    role: 'trusted',
    deps: ['motm'],
    gate: (c) => !!c.fx.ratings.consensus?.trusted.length,
    priority: 128,
    action: 'chase',
    done: (c) => {
      const cs = c.fx.ratings.consensus;
      if (!cs || !c.me) return false;
      /* Finished once your own marks are in for every missing player — or
         once the admin has approved them all, at which point there is nothing
         left to submit whoever did it. */
      if (cs.missing.length > 0 && cs.missing.every((pid) => !!cs.approved[pid])) return true;
      return trustedProgress(c.fx, c.me.id).complete;
    },
    /* Force close is the admin releasing them from it. Nothing else does —
       the whole point is that the match cannot settle until this is done. */
    skipped: (c) => !!c.fx.ratings.consensus?.forceClosed,
    hint: (c) => {
      const cs = c.fx.ratings.consensus;
      if (!cs || !c.me) return 'Mark everyone as you saw it';
      const p = trustedProgress(c.fx, c.me.id);
      return p.total
        ? `${p.done} of ${p.total} covered — they never see each other's marks`
        : 'Mark everyone as you saw it';
    },
  },
  {
    id: 'consensus',
    name: 'Recover the missing ratings',
    phase: 'ratings',
    role: 'admin',
    /**
     * Not gated on the stand-ins.
     *
     * Depending on `standin` looked tidier — approving does come last — but it
     * locked the admin out of the recovery screen for the whole time it was
     * running, which is exactly when they need to chase, extend, appoint
     * somebody else or force close. Running the rating round is theirs from
     * the moment somebody is missing until it is settled, and `done` below is
     * what ends it: every gap covered, or force-closed.
     */
    deps: ['motm'],
    priority: 130,
    action: 'rate',
    done: (c) => !c.ratings.needsIntervention,
    skipped: (c) => !!c.fx.ratings.consensus?.forceClosed,
    hint: (c) => {
      const cs = c.fx.ratings.consensus;
      if (!cs?.trusted.length) return `${c.ratings.missing.length} never submitted`;
      const waiting = cs.trusted.filter(
        (t) => !cs.missing.every((pid) => !!cs.submissions[t]?.[pid]),
      ).length;
      return waiting
        ? `Waiting on ${waiting} stand-in${waiting === 1 ? '' : 's'} to submit`
        : 'Compare the stand-ins and approve the marks';
    },
  },
  {
    /**
     * Go and look at how everyone was marked.
     *
     * Rating was a job you did and then never heard about again: you gave ten
     * marks, the room closed, and the results existed only inside a screen
     * nothing pointed at. This is the payoff for having done it, so it earns a
     * row — optional, because reading it is not something the club is waiting
     * on.
     *
     * `gate`d on the room being finished rather than depending on `rate`,
     * which is one person's marks. Somebody who missed the deadline should
     * still get to see where it landed.
     */
    id: 'ratingsroom',
    name: 'See how everyone was rated',
    phase: 'ratings',
    role: 'participant',
    deps: ['motm'],
    gate: (c) => !!c.fx.ratings.results && (c.match.everyoneRated || !!c.fx.ratings.closed),
    priority: 135,
    optional: true,
    action: 'rate',
    /* Per person, and local — see `viewed` on AppState. The fixture's own
       flags mean "somebody looked", which would tick this off for the whole
       club the moment the first person opened it. */
    done: (c) => !!c.state.viewed?.['ratings:' + c.fx.id],
    hint: (c) =>
      c.fx.ratings.results
        ? `Every mark is in — ${c.fx.ratings.results.rows.length} rated`
        : 'Opens once every mark is in',
  },
  {
    id: 'totw',
    name: 'Reveal the Team of the Week',
    phase: 'honours',
    role: 'admin',
    /**
     * Everyone's marks, not the admin's own.
     *
     * This used to depend on the `rate` task, which is personal — an admin who
     * did not play never rates, so `rate` never settles for them and the XI
     * stayed locked for the one person whose job it is to reveal it. Worse, it
     * kept the finished matchday pinned to the home screen for ever, because
     * the wrap-up was waiting on a task that could not happen.
     */
    deps: ['fulltime'],
    gate: (c) => c.match.everyoneRated || !!c.fx.ratings.closed,
    priority: 140,
    action: 'totw',
    /* Publishing it, not computing it. The XI is worked out automatically the
       moment the last mark lands; this is the admin choosing to show it. */
    done: (c) => !!c.fx.honoursRevealed,
    /**
     * A closed round with no honours means nobody rated.
     *
     * There is no XI, there is never going to be one, and the task cannot be
     * completed — so it is skipped rather than left pending. Without this the
     * admin kept a row they could not action, and `wrapup` waits on this task,
     * so the whole matchday stayed pinned to the home screen for good.
     *
     * Derived rather than stored: the two facts together already say it, and a
     * flag would need a column, a migration and a mapper to say it again.
     * `settleRatingsNow` closes the round without naming honours in exactly
     * this case, and `settleHonours` never produces an empty XI.
     */
    skipped: (c) => !!c.fx.ratings.closed && !c.fx.honours,
    hint: (c) =>
      c.fx.honours
        ? 'The XI is ready — show it to the club'
        : c.fx.ratings.closed
          ? 'Nobody rated, so there is no XI this week'
          : c.match.everyoneRated
            ? 'Every rating is in — name the XI'
            : `Named once everyone has rated (${c.match.ratedBy.length}/${c.match.participants.length} in)`,
  },
  {
    id: 'report',
    name: 'Read the match report',
    phase: 'settle',
    role: 'player',
    deps: ['totw'],
    /**
     * There has to be a report to read.
     *
     * The screen always has *something* — a built-in write-up computed from the
     * events, so it is never empty — but "read the match report" means the one
     * the admin had written, and telling ten people to go and read a report
     * that does not exist is how a task list stops being believed. `0018`
     * records it on the fixture; before that migration the flag is simply
     * absent and the row stays locked.
     */
    gate: (c) => !!c.fx.reportReady,
    priority: 150,
    optional: true,
    action: 'report',
    /**
     * Per person.
     *
     * This used to read `c.fx.reportSeen`, which is one boolean on the fixture
     * meaning "somebody, somewhere, opened it". So the first person to look
     * ticked the job off for the other ten, who never found out there was a
     * report at all. The fixture flag still records that the club has seen it —
     * it just is not an answer to "have *you* read it".
     */
    done: (c) => !!c.state.viewed?.['report:' + c.fx.id],
    hint: (c) => (c.fx.reportSeen ? 'How it was written up' : 'Be the first to read it'),
  },
  {
    id: 'pay',
    name: 'Settle the match fee',
    phase: 'settle',
    role: 'participant',
    deps: ['fulltime'],
    priority: 160,
    /**
     * Required, not optional.
     *
     * An outstanding fee was a suggestion the list quietly stopped mentioning,
     * so somebody could owe the admin money and see a finished matchday. It
     * stays on the list until they pay — or until the admin books the next
     * match, which is them drawing a line under this one.
     */
    action: 'pay',
    done: (c) => !!c.me && !!c.fx.pay[c.me.id]?.paid,
    gone: (c) => !!c.fx.wrappedUp,
    hint: (c) =>
      c.me && c.fx.pay[c.me.id]
        ? `${money(c.fx.pay[c.me.id].amount)} to the admin`
        : 'Split between everyone who played',
  },
  {
    id: 'wheel',
    name: 'Spin the forfeit wheel',
    phase: 'settle',
    role: 'admin',
    deps: ['fulltime'],
    priority: 170,
    optional: true,
    action: 'wheel',
    /* A draw has no losing side, so there is nothing to spin for. It used to
       sit outstanding for ever on a 2-2, waiting for something that could
       never happen. */
    done: (c) => c.fx.wheel.spun || isDraw(c.fx),
    hint: (c) =>
      isDraw(c.fx) ? 'Honours even — no forfeit this week' : 'Losing side takes the forfeit',
  },
  {
    id: 'next',
    name: 'Book the next match',
    phase: 'settle',
    role: 'admin',
    /* Everything the matchday still owes. Booking the next fixture closes
       this one, so it cannot come first. `rate` is deliberately not here: it
       is one person's marks, and an admin who did not play has none to give —
       waiting on it would mean they could never book another game. */
    deps: ['totw', 'consensus'],
    priority: 180,
    optional: true,
    action: 'next',
    /* Deliberately never "done": booking the next fixture is how a matchday
       ends, so treating it as completable would keep this one on screen. */
    done: () => false,
    hint: () => 'Closes this matchday',
  },
];

export interface ResolvedTask {
  id: string;
  name: string;
  hint: string;
  phase: PhaseId;
  /** Which half of the matchday this belongs to. */
  stage: Stage;
  role: WorkflowRole;
  state: TaskState;
  action: ChecklistAction;
  optional: boolean;
  priority: number;
  deadline: number | null;
  /**
   * This row is addressed to the person looking.
   *
   * Distinct from `actionable`: a job can be yours and still be locked, and a
   * job can be somebody else's and worth showing so you can see what everyone
   * is waiting for.
   */
  mine: boolean;
  /** This person could act on it right now. */
  actionable: boolean;
  /** Nothing to do, but something to see — opens read-only. */
  viewable: boolean;
  /**
   * This is the row everything of yours is waiting on.
   *
   * Not the same as "urgent to you": you cannot do it. It is worth marking
   * because it is the only row on the list whose state decides whether your
   * own work can start.
   */
  blocking?: boolean;
  /** Whose move it is, when it isn't yours. */
  waitingOn: WorkflowRole | null;
}

export interface Workflow {
  tasks: ResolvedTask[];
  /** The single thing this person should do. Null when they're caught up. */
  current: ResolvedTask | null;
  /** What everyone is waiting for, when the user has nothing to do. */
  blockedBy: ResolvedTask | null;
  /** Yours, but locked behind `blockedBy`. What the wait is actually for. */
  nextMine: ResolvedTask | null;
  phases: Phase[];
  currentPhase: Phase | null;
  /** Progress across the whole matchday — what the journey strip shows. */
  progress: { done: number; total: number; pct: number; remaining: number };
  /** Which half of the matchday this club is in. */
  stage: Stage;
  /**
   * Progress within this half only.
   *
   * The task list is headed "Before kick-off" or "After full time" and shows
   * that half's rows, so its counter has to count the same thing. Quoting the
   * whole-matchday total under a half-matchday list is how "3 of 14" ended up
   * above four rows.
   */
  stageProgress: { done: number; total: number; pct: number; remaining: number };
  /** What to call the task list for this person, right now. */
  title: string;
}

/**
 * The rows worth putting on a task card.
 *
 * Nineteen tasks is the whole matchday; nobody needs all of it at once. Two
 * kinds earn a place: the ones addressed to you, and the ones that are
 * currently holding everybody up. A required job locked behind something that
 * hasn't happened yet is neither, so it stays off the list until it matters.
 */
export function workflowRows(w: Workflow): ResolvedTask[] {
  return w.tasks
    .filter((t) => {
      if (t.state === 'cancelled') return false;
      /* This half of the matchday only. Before the whistle nobody needs the
         ratings and the forfeit wheel; after it, nobody needs to be shown the
         RSVP chasing they finished on Thursday. */
      if (t.stage !== w.stage) return false;
      if (t.mine) return true;
      /* Somebody else's, but it is the thing everyone is waiting for. */
      return !t.optional && t.state === 'waiting';
    })
    .sort((a, b) => a.priority - b.priority);
}

/**
 * What the admin still owes on the match they are trying to move on from.
 *
 * Booking the next fixture is how a matchday ends — the `next` task says so —
 * but nothing enforced it, so a new date could go up with the score unrecorded,
 * the ratings half-collected and the Team of the Week never revealed. The old
 * match then vanished off the home screen carrying its unfinished business with
 * it, and the only way back was the fixtures list.
 *
 * Only *required* admin jobs count. The optional ones — chasing, the forfeit
 * wheel on a draw — are exactly the things it is reasonable to leave.
 *
 * Returns the outstanding rows in the order they should be done, so the caller
 * can name the first one rather than saying "something isn't finished".
 */
export function adminOutstanding(w: Workflow): ResolvedTask[] {
  return w.tasks
    .filter(
      (t) =>
        t.role === 'admin' &&
        !t.optional &&
        /* `next` is the booking itself. Requiring it of oneself before it is
           allowed would lock the admin out of every future fixture. */
        t.id !== 'next' &&
        t.state !== 'completed' &&
        t.state !== 'expired' &&
        t.state !== 'skipped' &&
        t.state !== 'cancelled',
    )
    .sort((a, b) => a.priority - b.priority);
}

/**
 * The match that has to be finished with before another can be booked.
 *
 * The most recent one that has not been wrapped up. A fixture the admin has
 * already drawn a line under is not in the way of anything.
 */
export function fixtureInTheWay(state: AppState): Fixture | undefined {
  return state.fixtures
    .filter((f) => !f.wrappedUp)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-1)[0];
}

/** Plain English for "whose move is this". */
export function roleLabel(role: WorkflowRole): string {
  switch (role) {
    case 'admin':
      return 'the admin';
    case 'captain':
      return 'the captains';
    case 'trusted':
      return 'the trusted players';
    case 'participant':
      return 'the players who played';
    case 'adviser':
      return 'the squad adviser';
    case 'player':
      return 'the squad';
  }
}

/** Does this role describe the person looking? */
function isMine(role: WorkflowRole, c: Ctx): boolean {
  switch (role) {
    case 'admin':
      return c.isAdmin;
    case 'captain':
      return c.isCaptain;
    /* Participants are the people named in a team. A spectator — including an
       admin who didn't play — is never asked to vote or rate. */
    case 'participant':
      return c.played;
    case 'player':
      return !!c.me;
    case 'trusted':
      return !!c.me && !!c.fx.ratings.consensus?.trusted.includes(c.me.id);
    case 'adviser':
      return !!c.me && c.fx.adviser === c.me.id;
  }
}

export function buildWorkflow(
  state: AppState,
  fx: Fixture,
  me: Player | undefined,
  isAdmin: boolean,
  now = Date.now(),
): Workflow {
  const match = matchState(state, fx);
  const c: Ctx = {
    state,
    fx,
    me,
    isAdmin,
    isCaptain: !!me && !!fx.teams && (fx.teams.A.cap === me.id || fx.teams.B.cap === me.id),
    played: !!me && match.played(me.id),
    lists: rsvpLists(state, fx),
    motm: motmStatus(state, fx),
    match,
    ratings: ratingWindow(state, fx),
    now,
  };

  /* First pass: completion only. Dependencies are resolved afterwards, because
     a task's own doneness never depends on whether it was unlocked. */
  const done = new Map<string, boolean>();
  const gone = new Map<string, boolean>();
  const skipped = new Map<string, boolean>();
  for (const t of TASKS) {
    done.set(t.id, t.done(c));
    gone.set(t.id, !!t.gone?.(c));
    skipped.set(t.id, !!t.skipped?.(c));
  }

  /* A dependency is satisfied when it is finished *or* can never finish —
     otherwise one missed vote would freeze the rest of the matchday. */
  const settled = (id: string) => !!done.get(id) || !!gone.get(id) || !!skipped.get(id);

  const resolved: ResolvedTask[] = TASKS.map((t) => {
    const mine = isMine(t.role, c);
    const unlocked = t.deps.every(settled) && (t.gate?.(c) ?? true);
    const deadline = t.deadline?.(c) ?? null;

    let stateOf: TaskState;
    if (skipped.get(t.id)) stateOf = 'skipped';
    else if (done.get(t.id)) stateOf = 'completed';
    else if (gone.get(t.id)) stateOf = 'expired';
    else if (!unlocked) stateOf = 'locked';
    else if (!mine) stateOf = 'waiting';
    else if (deadline && now > deadline) stateOf = 'overdue';
    else stateOf = 'active';

    return {
      id: t.id,
      name: t.nameFor ? t.nameFor(c) : t.name,
      hint: t.hint(c),
      phase: t.phase,
      role: t.role,
      state: stateOf,
      stage: STAGE_OF[t.phase],
      action: t.action,
      optional: !!t.optional,
      priority: t.priority,
      deadline,
      mine,
      actionable: stateOf === 'active' || stateOf === 'overdue',
      /* Waiting, not locked: the dependency is met and the screen behind it
         has something real on it. A locked row still opens nothing, because
         there is genuinely nothing there yet. */
      viewable: stateOf === 'waiting' && !!t.openWhenWaiting,
      waitingOn: stateOf === 'waiting' ? t.role : null,
    };
  });

  /* Exactly one active task. Everything actionable stays tappable; only the
     highest-priority one is presented as *the* next thing, because two things
     described as next is the same as none. */
  const actionable = resolved
    .filter((t) => t.actionable)
    .sort((a, b) => Number(a.optional) - Number(b.optional) || a.priority - b.priority);
  const current = actionable[0] ?? null;
  for (const t of resolved) {
    if (t.actionable && t !== current)
      t.state = t.deadline && now > t.deadline ? 'overdue' : 'waiting';
  }
  if (current) current.state = current.deadline && now > current.deadline ? 'overdue' : 'active';

  /* When there's nothing to do, name whose move it is rather than showing an
     empty screen. Required work outranks optional. */
  const blockedBy = current
    ? null
    : (resolved
        .filter((t) => t.state === 'waiting' && !t.optional)
        .sort((a, b) => a.priority - b.priority)[0] ?? null);

  /* The row this person is actually held up by, marked on the row itself so a
     list can draw it without being handed the whole workflow. */
  if (blockedBy) {
    const b = resolved.find((t) => t.id === blockedBy.id);
    if (b) b.blocking = true;
  }

  /**
   * What becomes yours once the block clears.
   *
   * `blockedBy` alone told an admin "waiting on the club" and stopped there,
   * while four of their own jobs sat locked behind it. Being told only what you
   * cannot do reads as having nothing left — the honest version names the wait
   * *and* what it unlocks, so the next step card can say both without dumping
   * the whole list onto Home.
   */
  const nextMine = current
    ? null
    : (resolved
        .filter((t) => isMine(t.role, c) && t.state === 'locked' && !t.optional)
        .sort((a, b) => a.priority - b.priority)[0] ?? null);

  const phases: Phase[] = PHASES.map((p) => {
    const inPhase = resolved.filter((t) => t.phase === p.id);
    const required = inPhase.filter((t) => !t.optional);
    return {
      id: p.id,
      name: p.name,
      taskIds: inPhase.map((t) => t.id),
      complete:
        required.length > 0 &&
        required.every((t) => ['completed', 'expired', 'skipped'].includes(t.state)),
      current: false,
    };
  });
  const currentPhaseIndex = phases.findIndex((p) => !p.complete);
  if (currentPhaseIndex >= 0) phases[currentPhaseIndex].current = true;

  /* Only rows this person could act on are counted. A spectator is not "0 of
     9" on jobs that were never theirs, and a closed chance is not a debt. */
  const counted = resolved.filter(
    (t) => isMine(t.role, c) && t.state !== 'expired' && t.state !== 'skipped',
  );
  const doneCount = counted.filter((t) => t.state === 'completed').length;
  const total = counted.length;

  const who = isAdmin ? 'admin' : c.isCaptain ? 'captain' : c.played ? 'player' : 'watching';
  const when = fx.match.finished
    ? 'After full time'
    : fx.match.started
      ? 'Match day'
      : 'Before kick-off';

  /* Which half we are in. The final whistle is the boundary — everything up to
     it is about getting a game on, everything after is about settling it. */
  const stage: Stage = fx.match.finished ? 'post' : 'pre';
  const inStage = counted.filter((t) => t.stage === stage);
  const stageDone = inStage.filter((t) => t.state === 'completed').length;
  const stageTotal = inStage.length;

  return {
    tasks: resolved,
    current,
    blockedBy,
    nextMine,
    phases,
    currentPhase: currentPhaseIndex >= 0 ? phases[currentPhaseIndex] : null,
    stage,
    stageProgress: {
      done: stageDone,
      total: stageTotal,
      pct: stageTotal === 0 ? 100 : Math.round((stageDone / stageTotal) * 100),
      remaining: Math.max(0, stageTotal - stageDone),
    },
    title: `${when} — ${who}`,
    progress: {
      done: doneCount,
      total,
      pct: total === 0 ? 100 : Math.round((doneCount / total) * 100),
      remaining: Math.max(0, total - doneCount),
    },
  };
}
