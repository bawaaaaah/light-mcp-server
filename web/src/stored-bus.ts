/**
 * A choice kept on this device and read in several places (a switch in the bar, the previews it governs):
 * whoever sets it tells the others of the same key at once, even where the browser keeps nothing.
 */
export interface StoredBus {
  /** Listens to one key; returns what stops listening. */
  subscribe(key: string, listener: (value: unknown) => void): () => void;
  /** Tells every listener of that key (and only that key) the new value, and remembers it. */
  publish(key: string, value: unknown): void;
  /** The last value published for that key, for what mounts later (the browser may keep nothing); undefined before any. */
  get(key: string): unknown;
}

export function createStoredBus(): StoredBus {
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const last = new Map<string, unknown>();
  return {
    subscribe(key, listener) {
      const all = listeners.get(key) ?? new Set();
      all.add(listener);
      listeners.set(key, all);
      return () => void all.delete(listener);
    },
    publish(key, value) {
      last.set(key, value);
      for (const listener of [...(listeners.get(key) ?? [])]) listener(value);
    },
    get: (key) => last.get(key),
  };
}
