/**
 * Writes the match report.
 *
 * Runs on Supabase, not on the phone, for one reason above all others: the
 * Anthropic API key. Anything shipped inside a React Native bundle can be
 * unzipped and read, so a key in the app is a key given away. Here it is an
 * environment variable the client never sees.
 *
 * The function also decides *who* may ask. It reads the caller's own JWT and
 * queries with it, so row-level security applies exactly as it would in the
 * app — a request for a club you're not in returns nothing to write about.
 * Only the final insert uses the service role, and only after that check.
 */
import Anthropic from 'npm:@anthropic-ai/sdk@^0.68.0';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { cors, json } from '../_shared/cors.ts';

/* Sonnet: near-Opus quality on this kind of writing, fast enough that the
   report is ready before anyone has finished arguing about the second goal. */
const MODEL = 'claude-sonnet-5';

/**
 * Spend limits.
 *
 * Every call costs real money on the club's behalf, and the endpoint is
 * reachable by anyone with an account and a club. Without a ceiling, a single
 * member holding down a button — or a script with their token — runs up the
 * bill until the card declines.
 *
 * Counted from `ai_generations` rather than an in-memory map: Edge Functions
 * are stateless and per-instance memory resets on every cold start, which
 * makes an in-memory limiter security theatre.
 */
const MAX_PER_CLUB_PER_HOUR = 20;
const MAX_PER_USER_PER_HOUR = 6;

interface EventRow {
  kind: string;
  team: string | null;
  minute: number;
  player_id: string | null;
  assist_id: string | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  /* Who is asking, before what the server is holding. The key check used to
     run first, so an unauthenticated POST was answered with a sentence about
     this server's configuration — a stranger learning that a key is missing
     also learns the endpoint exists, which model it wants, and that nobody is
     watching it closely. Nothing about the server is worth saying to somebody
     who has not signed in. */
  const auth = req.headers.get('Authorization');
  if (!auth) return json({ error: 'Not signed in.' }, 401);

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return json({ error: 'The server has no Anthropic key configured.' }, 500);

  const url = Deno.env.get('SUPABASE_URL')!;

  /* Acting as the caller: every read below is filtered by the same policies
     the app runs under. This is what stops the function becoming a way to
     read another club's match. */
  const asUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } },
  });

  const { data: userData } = await asUser.auth.getUser();
  if (!userData?.user) return json({ error: 'Not signed in.' }, 401);

  const { fixtureId, regenerate } = await req.json().catch(() => ({}));
  if (!fixtureId) return json({ error: 'Which match?' }, 400);

  /* --- gather the facts ------------------------------------------------ */

  const { data: fx } = await asUser
    .from('fixtures')
    .select('id, club_id, date, venue, teams, finished, motm_winner, honours, ratings_results')
    .eq('id', fixtureId)
    .maybeSingle();

  if (!fx) return json({ error: "That match isn't yours to read." }, 404);
  if (!fx.finished) return json({ error: 'The match has not finished yet.' }, 409);

  const [{ data: events }, { data: players }, { data: club }] = await Promise.all([
    asUser
      .from('match_events')
      .select('kind, team, minute, player_id, assist_id')
      .eq('fixture_id', fixtureId)
      .order('minute'),
    asUser.from('players').select('id, name').eq('club_id', fx.club_id),
    asUser.from('clubs').select('name').eq('id', fx.club_id).maybeSingle(),
  ]);

  const nameOf = (id: string | null) =>
    (id && players?.find((p) => p.id === id)?.name) || 'someone';

  const teams = (fx.teams ?? {}) as Record<string, { name?: string; ids?: string[] }>;
  const teamName = (k: string) => teams[k]?.name ?? `Team ${k}`;

  const goals = (events ?? []).filter((e: EventRow) => ['goal', 'pen', 'own'].includes(e.kind));
  const scoreA = goals.filter((e) => (e.kind === 'own' ? e.team === 'B' : e.team === 'A')).length;
  const scoreB = goals.filter((e) => (e.kind === 'own' ? e.team === 'A' : e.team === 'B')).length;

  /* If the facts haven't changed, serve what was already written — the report
     is a record, and a record that rewords itself on every read isn't one. */
  const sourceHash = await sha256(
    JSON.stringify({
      events,
      motm: fx.motm_winner,
      honours: fx.honours,
      scoreA,
      scoreB,
    }),
  );

  if (!regenerate) {
    const { data: cached } = await asUser
      .from('ai_generations')
      .select('body, data, model, created_at, source_hash')
      .eq('fixture_id', fixtureId)
      .eq('kind', 'match_report')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (cached?.source_hash === sourceHash) {
      return json({ ...cached, cached: true });
    }
  }

  const timeline = (events ?? [])
    .map((e: EventRow) => {
      const who = nameOf(e.player_id);
      const side = e.team ? teamName(e.team) : '';
      switch (e.kind) {
        case 'goal':
          return `${e.minute}' GOAL ${side} — ${who}${e.assist_id ? `, assisted by ${nameOf(e.assist_id)}` : ''}`;
        case 'pen':
          return `${e.minute}' PENALTY scored by ${who} (${side})`;
        case 'own':
          return `${e.minute}' OWN GOAL by ${who} (${side})`;
        case 'yellow':
          return `${e.minute}' Yellow card — ${who}`;
        case 'red':
          return `${e.minute}' RED CARD — ${who}`;
        case 'sub':
          return `${e.minute}' Substitution (${side})`;
        case 'ko':
          return `Kick-off`;
        case 'ht':
          return `Half-time`;
        case 'ft':
          return `Full-time`;
        default:
          return null;
      }
    })
    .filter(Boolean)
    .join('\n');

  const honours = fx.honours as { totw?: { id: string }[]; star?: string } | null;

  const facts = [
    `Club: ${club?.name ?? 'the club'}`,
    `Date: ${fx.date}${fx.venue ? ` at ${fx.venue}` : ''}`,
    `Final score: ${teamName('A')} ${scoreA} — ${scoreB} ${teamName('B')}`,
    `${teamName('A')}: ${(teams.A?.ids ?? []).map(nameOf).join(', ') || 'unknown'}`,
    `${teamName('B')}: ${(teams.B?.ids ?? []).map(nameOf).join(', ') || 'unknown'}`,
    fx.motm_winner ? `Man of the Match: ${nameOf(fx.motm_winner)}` : null,
    honours?.star ? `Star player: ${nameOf(honours.star)}` : null,
    '',
    'Timeline:',
    timeline || '(no events were recorded)',
  ]
    .filter(Boolean)
    .join('\n');

  /* --- claim the spend, then make it ------------------------------------

     The row goes in before the model is called. Counting finished rows could
     never limit what was starting: concurrent callers all read the same count
     and all passed it. Now every attempt exists as a row the moment it is an
     attempt, so the requests race each other in Postgres rather than in the
     bill.

     Service role deliberately: there is no insert policy for players, and the
     count has to see rows raised by everyone in the club, not just what the
     caller's own policies would show. */
  const asService = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const claim = {
    club_id: fx.club_id,
    fixture_id: fixtureId,
    kind: 'match_report',
    body: '',
    model: MODEL,
    source_hash: sourceHash,
    created_by: userData.user.id,
    state: 'pending',
  };

  const { data: claimed, error: claimError } = await asService
    .from('ai_generations')
    .insert(claim)
    .select('id')
    .single();

  if (claimError || !claimed) {
    /* 23505 is `ai_generations_one_in_flight`: somebody asked for this same
       match a moment ago and the model has not answered them yet. Rejecting is
       the safe branch — waiting on an attempt whose fate is unknown is exactly
       when duplicating costs most. */
    if (claimError?.code === '23505') {
      return json({ error: 'That report is already being written. Try again in a moment.' }, 409);
    }
    console.error('could not claim a generation', claimError?.message);
    return json({ error: 'Could not start that report.' }, 500);
  }

  const generationId = claimed.id as string;

  /* Give up the claim, for every path that does not reach a stored report. A
     row left `pending` would hold the fixture's in-flight slot and count
     against the hour forever. */
  const abandon = async () => {
    await asService.from('ai_generations').update({ state: 'failed' }).eq('id', generationId);
  };

  /* --- spend limit ------------------------------------------------------

     Counted after the claim and including it, so a burst of callers sees each
     other. Pending rows count: an unanswered call is money already committed,
     and treating it as free is how the old version could be made to spend
     without limit. */
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const [{ count: clubCount }, { count: userCount }] = await Promise.all([
    asService
      .from('ai_generations')
      .select('id', { count: 'exact', head: true })
      .eq('club_id', fx.club_id)
      .in('state', ['pending', 'succeeded'])
      .gte('created_at', since),
    asService
      .from('ai_generations')
      .select('id', { count: 'exact', head: true })
      .eq('created_by', userData.user.id)
      .in('state', ['pending', 'succeeded'])
      .gte('created_at', since),
  ]);

  if ((clubCount ?? 0) > MAX_PER_CLUB_PER_HOUR) {
    await abandon();
    return json(
      { error: 'This club has written a lot of reports in the last hour. Try again shortly.' },
      429,
    );
  }
  if ((userCount ?? 0) > MAX_PER_USER_PER_HOUR) {
    await abandon();
    return json(
      { error: "You've written a few of these in the last hour. Try again shortly." },
      429,
    );
  }

  /* --- write it -------------------------------------------------------- */

  const anthropic = new Anthropic({ apiKey });

  let response;
  try {
    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000,
      /* A report is a short writing task, not a reasoning one — medium keeps it
         quick without the prose going flat. */
      output_config: {
        effort: 'medium',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              headline: {
                type: 'string',
                description: 'Six words or fewer. No punctuation at the end.',
              },
              report: {
                type: 'string',
                description: 'Two or three short paragraphs of match report.',
              },
              moment: {
                type: 'string',
                description: 'One sentence on the moment the match turned.',
              },
              shout: {
                type: 'string',
                description:
                  'One sentence praising a specific named player for something the timeline actually shows.',
              },
            },
            required: ['headline', 'report', 'moment', 'shout'],
            additionalProperties: false,
          },
        },
      },
      system: [
        'You write short match reports for a Sunday league football club app.',
        '',
        'Voice: a mate who was on the touchline. Warm, funny, never sneering.',
        'These are amateurs who pay to play — tease the result, never the person.',
        '',
        'Rules you must not break:',
        '- Use only what the timeline and facts give you. Never invent a goal, a',
        '  save, a tackle, a scoreline or a quote. If the timeline is thin, write',
        '  a short report rather than filling space with things that did not happen.',
        '- Name players exactly as spelled in the facts.',
        '- British English. No emoji. No hashtags. No markdown headings.',
        '- Do not mention ratings, votes or anything not listed in the facts.',
      ].join('\n'),
      messages: [{ role: 'user', content: facts }],
    });
  } catch (e) {
    /* The claim stays `failed` rather than being deleted: the attempt may well
       have cost something, and a row that says so is how that is ever noticed. */
    await abandon();
    console.error('model call failed', e instanceof Error ? e.message : String(e));
    return json({ error: 'That report could not be written.' }, 502);
  }

  if (response.stop_reason === 'refusal') {
    await abandon();
    return json({ error: 'That report could not be written.' }, 422);
  }

  const block = response.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') {
    await abandon();
    return json({ error: 'Empty response.' }, 502);
  }

  let parsed: { headline: string; report: string; moment: string; shout: string };
  try {
    parsed = JSON.parse(block.text);
  } catch {
    await abandon();
    return json({ error: 'The report came back malformed.' }, 502);
  }

  const finished = {
    body: parsed.report,
    data: parsed,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    state: 'succeeded',
  };

  const { error: storeError } = await asService
    .from('ai_generations')
    .update(finished)
    .eq('id', generationId);

  if (storeError) {
    /* The report is written and worth returning even if storing it failed. It
       stays `pending` in that case rather than being marked failed — it was
       paid for, and the in-flight index will not release until somebody looks. */
    console.error('could not store report', storeError.message);
  }

  return json({
    ...claim,
    ...finished,
    id: generationId,
    created_at: new Date().toISOString(),
    cached: false,
  });
});

async function sha256(input: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
