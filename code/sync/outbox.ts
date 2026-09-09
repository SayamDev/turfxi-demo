import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * What still needs sending.
 *
 * The obvious design is a log of operations — "goal added", "RSVP changed" —
 * but a log replayed after a week offline re-runs history the server may have
 * moved past, and it grows without bound. This stores *which things changed*
 * instead: a set of entity keys. Flushing reads the current value of each one
 * and sends that, so ten edits to the same fixture cost one write, and the
 * queue can never disagree with what the user is looking at.
 *
 * Keys look like:
 *   club
 *   player:<id>          fixture:<id>
 *   del:player:<id>      del:fixture:<id>
 */
export type DirtyKey = string;

const STORAGE_KEY = 'turfxi.outbox.v1';

let dirty = new Set<DirtyKey>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Persist lazily — the queue changes on every keystroke in a form. */
function schedulePersist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...dirty]));
  }, 400);
}

export async function loadOutbox(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) dirty = new Set(JSON.parse(raw) as DirtyKey[]);
  } catch {
    /* A corrupt queue is not worth crashing over — worst case a change is
       re-sent by the next full push. */
    dirty = new Set();
  }
}

export function markDirty(...keys: DirtyKey[]): void {
  let changed = false;
  for (const k of keys) {
    if (!dirty.has(k)) {
      dirty.add(k);
      changed = true;
    }
  }
  if (changed) schedulePersist();
}

/** A delete supersedes any pending edit to the same thing. */
export function markDeleted(kind: 'player' | 'fixture', id: string): void {
  dirty.delete(`${kind}:${id}`);
  markDirty(`del:${kind}:${id}`);
}

export function pending(): DirtyKey[] {
  return [...dirty];
}

export function pendingCount(): number {
  return dirty.size;
}

/**
 * Drop keys that were successfully sent.
 *
 * Only the keys handed back are cleared, never the whole set: anything the
 * user changed *while* the flush was in flight has to survive it, or an edit
 * made during a slow upload would vanish.
 */
export function clearKeys(keys: DirtyKey[]): void {
  for (const k of keys) dirty.delete(k);
  schedulePersist();
}

export async function resetOutbox(): Promise<void> {
  dirty = new Set();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  await AsyncStorage.removeItem(STORAGE_KEY);
}
