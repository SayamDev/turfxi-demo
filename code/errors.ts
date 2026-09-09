/**
 * Finding out when it breaks for somebody else.
 *
 * Until now a crash on a pitch-side phone produced exactly one artefact: a
 * player saying "it didn't work". No stack, no screen, no idea whether it hit
 * one person or the whole club.
 *
 * ## Why there is no SDK here
 *
 * `@sentry/react-native` is the obvious answer and it brings native modules,
 * which means a config plugin, a rebuild, and a failure mode that only shows up
 * in a store build. This talks to Sentry's ingest endpoint over plain HTTP
 * instead — no native code, works in Expo Go, and cannot break a build.
 *
 * The trade is real and worth stating: **this captures JavaScript errors, not
 * native crashes.** A hard crash in the Hermes runtime or a native module dies
 * without reporting anything. In an app of this shape almost everything is JS,
 * so this catches the great majority — but it is not the same as full crash
 * reporting, and if that becomes necessary the native SDK is the answer.
 *
 * ## Without a DSN
 *
 * Everything below still runs; it just logs to the console instead of sending.
 * Nothing about the app depends on reporting being configured, which is the
 * point — an error handler that can itself fail to load is worse than none.
 */

const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN ?? '';

/**
 * The last few errors, kept in memory.
 *
 * So the app can show somebody what went wrong when they ask, without needing
 * the dashboard or a connection. Deliberately small and never persisted:
 * a stack trace can quote application state, and storing that on the device
 * turns a debugging aid into a thing worth protecting.
 */
const recent: { at: number; message: string; where: string }[] = [];
const KEEP = 20;

export function recentErrors(): readonly { at: number; message: string; where: string }[] {
  return recent;
}

interface Dsn {
  key: string;
  host: string;
  projectId: string;
}

/** `https://<key>@<host>/<projectId>` — anything else is treated as absent. */
function parseDsn(raw: string): Dsn | null {
  const m = raw.match(/^https:\/\/([^@]+)@([^/]+)\/(.+)$/);
  return m ? { key: m[1], host: m[2], projectId: m[3] } : null;
}

/**
 * Report something that went wrong.
 *
 * Never throws and never rejects. An error handler that can itself fail turns
 * one bug into two, and the second one is invisible.
 */
export function reportError(err: unknown, where = 'app'): void {
  const error = err instanceof Error ? err : new Error(String(err));
  const message = error.message || String(err);

  recent.unshift({ at: Date.now(), message, where });
  if (recent.length > KEEP) recent.length = KEEP;

  /* Always. The console is where this is read during development, and it is
     the only place it is read at all when no DSN is set. */
  console.error(`[${where}]`, error);

  const dsn = parseDsn(DSN);
  if (!dsn) return;

  void send(dsn, error, where).catch(() => {
    /* Swallowed on purpose. Failing to report an error must never become an
       error — that is how a crash loop starts. */
  });
}

async function send(dsn: Dsn, error: Error, where: string): Promise<void> {
  const body = JSON.stringify({
    event_id: randomHex32(),
    timestamp: new Date().toISOString(),
    platform: 'javascript',
    level: 'error',
    logger: where,
    /* No user, no email, no club. Sentry would happily take them and there is
       no reason it should have them: a stack trace and a version is enough to
       find a bug, and anything more is somebody's data sitting in a third
       party's system for no benefit. */
    exception: {
      values: [
        {
          type: error.name || 'Error',
          value: error.message,
          stacktrace: { frames: framesOf(error) },
        },
      ],
    },
  });

  await fetch(`https://${dsn.host}/api/${dsn.projectId}/store/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${dsn.key}, sentry_client=turfxi/1.0`,
    },
    body,
  });
}

/** Sentry wants oldest frame first; a JS stack is newest first. */
function framesOf(error: Error): { filename: string; function: string }[] {
  return (error.stack ?? '')
    .split('\n')
    .slice(1, 30)
    .map((line) => {
      const m = line.match(/at\s+(.+?)\s+\((.+)\)/) ?? line.match(/at\s+(.+)/);
      return { function: m?.[1]?.trim() ?? line.trim(), filename: m?.[2]?.trim() ?? '' };
    })
    .reverse();
}

function randomHex32(): string {
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

/**
 * Catch the errors nobody caught.
 *
 * React's error boundary only sees errors thrown while rendering. A rejected
 * promise in a sync pass, a callback that throws — those are what actually go
 * wrong in this app, and they were silent.
 *
 * Returns a function that puts the previous handler back, so a test or a hot
 * reload does not stack them.
 */
export function installGlobalErrorHandler(): () => void {
  interface WithErrorUtils {
    ErrorUtils?: {
      getGlobalHandler: () => (e: unknown, fatal?: boolean) => void;
      setGlobalHandler: (h: (e: unknown, fatal?: boolean) => void) => void;
    };
  }
  const utils = (globalThis as unknown as WithErrorUtils).ErrorUtils;
  if (!utils) return () => {};

  const previous = utils.getGlobalHandler();
  utils.setGlobalHandler((e, fatal) => {
    reportError(e, fatal ? 'fatal' : 'uncaught');
    /* Still hand it on. React Native's own handler is what shows the red box in
       development and ends the process on a genuine fatal — replacing it would
       hide crashes rather than report them. */
    previous(e, fatal);
  });

  return () => utils.setGlobalHandler(previous);
}
