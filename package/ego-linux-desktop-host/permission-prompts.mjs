// The permission handler exposes a URL and isMainFrame, but not the requesting
// WebFrameMain. Only main-document wake locks are safe to coalesce: permissions
// such as media and fileSystem can carry additional request-specific details.
export const MAX_PERMISSION_PROMPTS = 32; // Includes the active dialog, even while it is closing.
export const MAX_PERMISSION_CALLBACKS = 32; // Per prompt, including the first request.
export const MAX_PENDING_PERMISSION_CALLBACKS = 256; // Across all prompts, including callbacks awaiting delivery.

export function createPermissionPrompts(show) {
  const states = new WeakMap();
  const queue = [];
  let active;
  let pumping = false;
  let admitting = 0;
  let pendingCallbacks = 0;

  function identify(contents, details) {
    try {
      if (contents.isDestroyed()) return;
      if (typeof details?.requestingUrl !== 'string' || typeof details.isMainFrame !== 'boolean') return;
      const origin = new URL(details.requestingUrl).origin;
      if (origin === 'null') return; // Opaque origins cannot be compared safely.
      const main = contents.mainFrame;
      let frame = main;
      if (details.isMainFrame) {
        // A stale request from a different same-origin URL must not be attributed to this document.
        if (main.url !== details.requestingUrl) return;
      } else {
        const matches = main.framesInSubtree.filter(candidate => candidate.frameTreeNodeId !== main.frameTreeNodeId &&
          !candidate.isDestroyed() && !candidate.detached && candidate.url === details.requestingUrl && candidate.origin === origin);
        if (matches.length !== 1) return;
        [frame] = matches;
      }
      if (frame.isDestroyed() || frame.detached || frame.origin !== origin) return;
      return { origin, frame, mainFrame: details.isMainFrame };
    } catch { return; }
  }

  function current(entry) {
    try {
      const { contents, state, frame, origin } = entry;
      if (states.get(contents) !== state || state.mainNavigating || contents.isDestroyed() || frame.isDestroyed() || frame.detached || frame.origin !== origin) return false;
      const frames = entry.mainFrame ? [contents.mainFrame] : contents.mainFrame.framesInSubtree;
      return frames.some(candidate => candidate.processId === frame.processId && candidate.routingId === frame.routingId);
    } catch { return false; }
  }

  function takeCallbacks(entry) {
    if (entry.done) return [];
    entry.done = true;
    if (entry.key && entry.state.pending.get(entry.key) === entry) entry.state.pending.delete(entry.key);
    const callbacks = entry.callbacks;
    entry.callbacks = [];
    return callbacks;
  }

  function deliver(entry, callbacks, allowed) {
    for (const callback of callbacks) {
      pendingCallbacks--;
      // A previous callback can synchronously navigate or destroy the page.
      try { callback(allowed && current(entry)); } catch { /* Do not strand the other callbacks. */ }
    }
  }

  function reject(callback) {
    try { callback(false); } catch { /* A stale callback must not block the queue. */ }
  }

  function settle(entry, allowed) {
    deliver(entry, takeCallbacks(entry), allowed);
  }

  function cancel(entry) {
    const index = queue.indexOf(entry);
    if (index !== -1) queue.splice(index, 1);
    const callbacks = takeCallbacks(entry);
    if (active === entry) { try { entry.controller.abort(); } catch {} }
    deliver(entry, callbacks, false);
  }

  function invalidate(contents, mainFrame) {
    const affected = entry => entry.contents === contents && (mainFrame || !entry.mainFrame);
    // Detach all affected entries before aborting or invoking callbacks, which can re-enter.
    const canceled = queue.filter(affected);
    for (const entry of canceled) queue.splice(queue.indexOf(entry), 1);
    const canceledActive = active && affected(active) ? active : undefined;
    if (canceledActive) canceled.unshift(canceledActive);
    const completions = canceled.map(entry => [entry, takeCallbacks(entry)]);
    if (canceledActive) { try { canceledActive.controller.abort(); } catch {} }
    for (const [entry, callbacks] of completions) deliver(entry, callbacks, false);
    pump();
  }

  function complete(entry, allowed) {
    if (!entry.done) {
      const valid = current(entry);
      if (valid && !allowed && entry.key) entry.state.denied.add(entry.key);
      settle(entry, valid && allowed);
    }
    if (active === entry) active = undefined;
    pump();
  }

  function pump() {
    if (active || pumping || admitting) return;
    pumping = true;
    try {
      while (!active && queue.length) {
        const entry = queue.shift();
        if (!current(entry)) { settle(entry, false); continue; }
        active = entry;
        entry.controller = new AbortController();
        Promise.resolve().then(() => {
          if (entry.done || !current(entry)) return false;
          return show({ permission: entry.permission, origin: entry.origin, signal: entry.controller.signal });
        }).then(allowed => complete(entry, allowed === true), () => complete(entry, false));
      }
    } finally { pumping = false; }
  }

  function track(contents, onQueued = () => {}) {
    const state = { mainNavigating: false, pending: new Map(), denied: new Set(), onQueued };
    states.set(contents, state);
    contents.on('did-start-navigation', (event, _url, inPlace, main) => {
      if ((event.isSameDocument ?? inPlace) === true) return;
      const mainFrame = (event.isMainFrame ?? main) !== false;
      if (mainFrame) state.mainNavigating = true;
      invalidate(contents, mainFrame);
    });
    contents.on('did-frame-navigate', (_event, _url, _code, _status, main) => {
      const mainFrame = main !== false;
      if (mainFrame) state.mainNavigating = true;
      invalidate(contents, mainFrame);
      if (mainFrame) { state.denied.clear(); state.mainNavigating = false; }
      pump();
    });
    contents.on('did-fail-provisional-load', (_event, _code, _description, _url, main) => {
      if (main !== false && !contents.isLoadingMainFrame()) state.mainNavigating = false;
    });
    contents.on('did-stop-loading', () => { if (!contents.isLoadingMainFrame()) state.mainNavigating = false; });
    contents.on('render-process-gone', () => { state.mainNavigating = true; state.denied.clear(); invalidate(contents, true); });
    contents.once('destroyed', () => forget(contents));
  }

  function forget(contents) {
    const state = states.get(contents);
    if (!state) return;
    states.delete(contents);
    state.denied.clear();
    invalidate(contents, true);
  }

  function request(contents, permission, callback, details) {
    // Canceling a stale entry can re-enter request(), so re-read state and the
    // pending map before deciding whether to merge or admit a new prompt.
    while (true) {
      const state = contents && states.get(contents);
      const identity = state && !state.mainNavigating && identify(contents, details);
      if (!identity) { reject(callback); return; }
      const key = identity.mainFrame && permission === 'screen-wake-lock' ? JSON.stringify([identity.origin, permission]) : undefined;
      if (key && state.denied.has(key)) { reject(callback); return; }
      const existing = key && state.pending.get(key);
      if (existing) {
        if (!current(existing)) { cancel(existing); continue; }
        if (existing.callbacks.length >= MAX_PERMISSION_CALLBACKS || pendingCallbacks >= MAX_PENDING_PERMISSION_CALLBACKS) { reject(callback); return; }
        existing.callbacks.push(callback);
        pendingCallbacks++;
        return;
      }
      if (queue.length + (active ? 1 : 0) >= MAX_PERMISSION_PROMPTS || pendingCallbacks >= MAX_PENDING_PERMISSION_CALLBACKS) { reject(callback); return; }
      const entry = { contents, state, permission, ...identity, key, callbacks: [callback], done: false };
      pendingCallbacks++;
      if (key) state.pending.set(key, entry);
      queue.push(entry);
      // The transition must finish before any reentrant request can show a dialog.
      admitting++;
      try { state.onQueued(); } catch { cancel(entry); } finally { admitting--; pump(); }
      return;
    }
  }

  return { track, forget, request };
}
