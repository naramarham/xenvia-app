// Drop-in replacement for the Claude-artifact `window.storage` API, backed
// by plain localStorage — so App.jsx (ported straight from the Claude
// artifact) needs almost no changes to work in a normal browser / Android
// WebView, where `window.storage` doesn't exist.
//
// Matches the real API's observed behavior closely enough for App.jsx's
// usage: get() throws/rejects when the key doesn't exist (App.jsx already
// catches that and falls back to defaults), set() resolves with the stored
// value. The `shared` parameter is accepted for signature compatibility but
// ignored — there's no multi-user "shared" concept outside the Claude
// artifact platform; everything here is just this device's local storage.

export const storage = {
  async get(key) {
    const raw = window.localStorage.getItem(key);
    if (raw === null) throw new Error(`xenvia-storage: no value for "${key}"`);
    return { key, value: raw, shared: false };
  },
  async set(key, value) {
    window.localStorage.setItem(key, value);
    return { key, value, shared: false };
  },
  async delete(key) {
    const existed = window.localStorage.getItem(key) !== null;
    window.localStorage.removeItem(key);
    return { key, deleted: existed, shared: false };
  },
};
