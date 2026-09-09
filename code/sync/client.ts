import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

/**
 * Is there a backend to talk to?
 *
 * The app has to run without one — the demo club is local, and somebody
 * cloning the repo shouldn't hit a crash before they've made a project. Every
 * sync entry point checks this first and quietly does nothing.
 */
export const isConfigured = !!url && !!anonKey;

/**
 * Session storage.
 *
 * The refresh token is a long-lived credential, so it belongs in the keychain
 * rather than AsyncStorage. SecureStore caps a value at 2048 bytes, and a
 * Supabase session is usually — but not reliably — under that: the JWT alone
 * runs to about a thousand characters, and a Google sign-in adds a user object
 * carrying a name, an avatar URL and provider identities.
 *
 * This used to fall back to AsyncStorage when the value was too big. That kept
 * people signed in, which was the intent, but it did it by writing a working
 * refresh token to an unencrypted file — readable from a rooted device, an adb
 * backup, or an unencrypted desktop backup. The failure was silent, so nobody
 * would ever have known which of the two stores their token was in.
 *
 * So the value is split instead. Chunks are written to numbered keys with a
 * count alongside, and the keychain is never abandoned for being asked to hold
 * too much. AsyncStorage is still read once, to pick up a session written by
 * the old code, and erased the moment it has been moved.
 */
const CHUNK = 1800;
const partsKey = (key: string) => `${key}.parts`;
const partKey = (key: string, i: number) => `${key}.${i}`;

const secureStorage = {
  getItem: async (key: string) => {
    try {
      const count = Number(await SecureStore.getItemAsync(partsKey(key)));
      if (count > 0) {
        const parts = await Promise.all(
          Array.from({ length: count }, (_, i) => SecureStore.getItemAsync(partKey(key, i))),
        );
        /* A missing chunk means a half-written session, which is worse than
           none: it would be handed to the client as a malformed token. */
        if (parts.every((v) => v !== null)) return parts.join('');
      }
      /* Written by a build before the split. */
      const whole = await SecureStore.getItemAsync(key);
      if (whole !== null) return whole;
    } catch {
      /* keychain unavailable — fall through to the legacy read */
    }
    return AsyncStorage.getItem(key);
  },

  setItem: async (key: string, value: string) => {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i += CHUNK) parts.push(value.slice(i, i + CHUNK));

    try {
      await Promise.all(parts.map((p, i) => SecureStore.setItemAsync(partKey(key, i), p)));
      await SecureStore.setItemAsync(partsKey(key), String(parts.length));
      /* Clear a longer session's leftovers, the single-key form, and anything
         the old fallback left in the clear. Each is best-effort: none of them
         failing should cost the session that was just stored. */
      await Promise.all([
        SecureStore.deleteItemAsync(key).catch(() => {}),
        AsyncStorage.removeItem(key),
        ...Array.from({ length: 4 }, (_, i) =>
          SecureStore.deleteItemAsync(partKey(key, parts.length + i)).catch(() => {}),
        ),
      ]);
      return;
    } catch {
      /* The keychain itself is unavailable — a locked device during a
         background refresh, or a simulator with no entitlement. Falling back
         keeps the session, and the next successful write moves it back. */
    }
    await AsyncStorage.setItem(key, value);
  },

  removeItem: async (key: string) => {
    try {
      const count = Number(await SecureStore.getItemAsync(partsKey(key))) || 0;
      await Promise.all([
        SecureStore.deleteItemAsync(partsKey(key)),
        SecureStore.deleteItemAsync(key),
        ...Array.from({ length: count }, (_, i) => SecureStore.deleteItemAsync(partKey(key, i))),
      ]);
    } catch {
      /* ignore */
    }
    await AsyncStorage.removeItem(key);
  },
};

/**
 * The one client. Created even when unconfigured so imports never explode;
 * callers gate on `isConfigured` instead.
 */
export const supabase: SupabaseClient<Database> = createClient<Database>(
  url || 'http://localhost',
  anonKey || 'public-anon-key',
  {
    auth: {
      storage: secureStorage,
      autoRefreshToken: true,
      persistSession: true,
      /* PKCE, explicitly. supabase-js defaults to the implicit flow, which
         hands back the access and refresh tokens in the redirect URL itself —
         and the redirect lands on `turfxi://`, a scheme any other installed
         app may also register. On Android that is a live account takeover: a
         second app claiming the scheme receives a working refresh token.

         PKCE returns a single-use code bound to a verifier this app generated
         and kept, so intercepting the redirect yields something the attacker
         cannot spend. */
      flowType: 'pkce',
      /* No URL to parse on native, and leaving it on makes the client hunt
         for a browser location that isn't there. */
      detectSessionInUrl: false,
    },
    realtime: { params: { eventsPerSecond: 5 } },
  },
);
