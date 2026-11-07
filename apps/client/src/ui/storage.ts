/**
 * The page's localStorage, or a memory stand-in when the browser refuses it. With site data
 * blocked (some school PCs, strict privacy settings) merely READING `window.localStorage`
 * throws, which used to fail a mode's whole boot before its own try/catch around each read
 * and write could help. The stand-in keeps the session playable; nothing outlives the tab.
 */
let store: Storage | null = null;

export function browserStorage(): Storage {
  if (store) return store;
  try {
    const ls = window.localStorage;
    ls.getItem("craftyap-probe"); // a storage that exists but throws on use counts as blocked
    store = ls;
  } catch {
    store = memoryStorage();
  }
  return store;
}

/** A Storage that lives only in memory (exported for tests). */
export function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}
