// Banneret Hub: browser test files share one origin's storage, so whatever a test leaves saved
// (tabs, drafts, panels, filters) is there when the next file's stores load.

const read = (store: Storage) =>
  new Map(Object.keys(store).map((key) => [key, store.getItem(key)!]));

/**
 * Puts localStorage and sessionStorage back as they are now when disposed. Saves the app still
 * holds back are written first (its stores flush on beforeunload), so none lands afterwards.
 * Declare it before what writes: `using` disposes in reverse order, so the view is gone by then.
 */
export function keepBrowserStorage(): Disposable {
  const kept = [localStorage, sessionStorage].map((store) => ({ store, saved: read(store) }));
  return {
    [Symbol.dispose]() {
      window.dispatchEvent(new Event("beforeunload"));
      for (const { store, saved } of kept) {
        for (const key of read(store).keys()) {
          if (!saved.has(key)) store.removeItem(key);
        }
        for (const [key, value] of saved) store.setItem(key, value);
      }
    },
  };
}
