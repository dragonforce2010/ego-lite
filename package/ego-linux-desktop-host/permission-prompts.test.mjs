import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createPermissionPrompts, MAX_PENDING_PERMISSION_CALLBACKS, MAX_PERMISSION_CALLBACKS, MAX_PERMISSION_PROMPTS } from './permission-prompts.mjs';

let nextFrameId = 1;
function frame(url) {
  const id = nextFrameId++;
  return { url, origin: new URL(url).origin, frameTreeNodeId: id, processId: id, routingId: id,
    detached: false, destroyed: false, isDestroyed() { return this.destroyed; } };
}

function contents(url = 'https://play2048.co/') {
  const wc = new EventEmitter();
  wc.mainFrame = frame(url);
  wc.mainFrame.framesInSubtree = [wc.mainFrame];
  wc.destroyed = false;
  wc.loading = false;
  wc.isDestroyed = () => wc.destroyed;
  wc.isLoadingMainFrame = () => wc.loading;
  return wc;
}

function harness() {
  const dialogs = [];
  const prompts = createPermissionPrompts(options => new Promise((resolve, reject) => {
    dialogs.push({ ...options, resolve, reject });
  }));
  return { dialogs, prompts };
}

function request(prompts, wc, permission = 'screen-wake-lock', requestingFrame = wc.mainFrame) {
  const results = [];
  prompts.request(wc, permission, value => results.push(value), {
    requestingUrl: requestingFrame.url, isMainFrame: requestingFrame === wc.mainFrame,
  });
  return results;
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('coalesces concurrent main-document wake locks, but does not cache an allow', async () => {
  const { prompts, dialogs } = harness();
  const page = contents();
  prompts.track(page);
  const first = request(prompts, page);
  const second = request(prompts, page);
  const third = request(prompts, page);
  await tick();
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].origin, 'https://play2048.co');
  dialogs[0].resolve(true);
  await tick();
  assert.deepEqual([first, second, third], [[true], [true], [true]]);

  const later = request(prompts, page);
  await tick();
  assert.equal(dialogs.length, 2);
  dialogs[1].resolve(false);
  await tick();
  assert.deepEqual(later, [false]);
});

test('denied wake locks stay denied for the main document until a cross-document navigation', async () => {
  const { prompts, dialogs } = harness();
  const page = contents();
  prompts.track(page);
  const first = request(prompts, page);
  await tick();
  dialogs[0].resolve(false);
  await tick();
  assert.deepEqual(first, [false]);
  page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true }, '', true, true);
  assert.deepEqual(request(prompts, page), [false]);
  assert.equal(dialogs.length, 1);

  page.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false }, '', false, false);
  assert.deepEqual(request(prompts, page), [false]);
  page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }, '', false, true);
  assert.deepEqual(request(prompts, page), [false]); // no grants during a provisional navigation
  page.emit('did-frame-navigate', {}, page.mainFrame.url, 200, 'OK', true);
  const afterReload = request(prompts, page);
  await tick();
  assert.equal(dialogs.length, 2);
  dialogs[1].resolve(true);
  await tick();
  assert.deepEqual(afterReload, [true]);
});

test('serializes different pages, origins, and permissions without sharing decisions', async () => {
  const { prompts, dialogs } = harness();
  const firstPage = contents();
  const sameOriginPage = contents();
  const otherOriginPage = contents('https://other.example/');
  for (const page of [firstPage, sameOriginPage, otherOriginPage]) prompts.track(page);
  const first = request(prompts, firstPage);
  const second = request(prompts, sameOriginPage);
  const third = request(prompts, otherOriginPage);
  const fourth = request(prompts, firstPage, 'geolocation');
  await tick();
  assert.equal(dialogs.length, 1);
  dialogs[0].resolve(true);
  await tick();
  assert.deepEqual([first, second, third, fourth], [[true], [], [], []]);
  assert.equal(dialogs.length, 2);
  dialogs[1].resolve(false);
  await tick();
  assert.deepEqual(second, [false]);
  assert.equal(dialogs[2].origin, 'https://other.example');
  dialogs[2].resolve(true);
  await tick();
  assert.deepEqual(third, [true]);
  assert.equal(dialogs[3].permission, 'geolocation');
  dialogs[3].resolve(false);
  await tick();
  assert.deepEqual(fourth, [false]);
});

test('does not merge media requests or subframes, and rejects ambiguous or detached frames', async () => {
  const { prompts, dialogs } = harness();
  const page = contents();
  const one = frame('https://embedded.example/one');
  const two = frame('https://embedded.example/two');
  page.mainFrame.framesInSubtree.push(one, two);
  prompts.track(page);
  const firstMedia = request(prompts, page, 'media');
  const secondMedia = request(prompts, page, 'media');
  const firstFrame = request(prompts, page, 'screen-wake-lock', one);
  const secondFrame = request(prompts, page, 'screen-wake-lock', two);
  await tick();
  assert.equal(dialogs.length, 1);
  dialogs[0].resolve(true);
  await tick();
  assert.deepEqual([firstMedia, secondMedia], [[true], []]);
  dialogs[1].resolve(false);
  await tick();
  dialogs[2].resolve(true);
  await tick();
  assert.deepEqual([firstFrame, secondFrame], [[true], []]);
  two.detached = true;
  dialogs[3].resolve(true);
  await tick();
  assert.deepEqual(secondFrame, [false]);

  const duplicate = frame(one.url);
  page.mainFrame.framesInSubtree.push(duplicate);
  assert.deepEqual(request(prompts, page, 'screen-wake-lock', one), [false]);
  assert.equal(dialogs.length, 4);
});

test('navigation cancels old callbacks and keeps the next dialog waiting for closure', async () => {
  const { prompts, dialogs } = harness();
  const navigating = contents();
  const other = contents('https://other.example/');
  prompts.track(navigating);
  prompts.track(other);
  const first = request(prompts, navigating);
  const duplicate = request(prompts, navigating);
  const queuedOld = request(prompts, navigating, 'geolocation');
  const queuedOther = request(prompts, other);
  await tick();
  navigating.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }, '', false, true);
  assert.equal(dialogs[0].signal.aborted, true);
  assert.deepEqual([first, duplicate, queuedOld, queuedOther], [[false], [false], [false], []]);
  assert.equal(dialogs.length, 1);
  dialogs[0].resolve(true); // even a late allow cannot revive the old document
  await tick();
  assert.deepEqual([first, duplicate], [[false], [false]]);
  assert.equal(dialogs.length, 2);
  dialogs[1].resolve(true);
  await tick();
  assert.deepEqual(queuedOther, [true]);
});

test('rechecks document validity between callbacks in the same group', async () => {
  const { prompts, dialogs } = harness();
  const page = contents();
  prompts.track(page);
  const first = [];
  prompts.request(page, 'screen-wake-lock', value => {
    first.push(value);
    page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }, '', false, true);
  }, { requestingUrl: page.mainFrame.url, isMainFrame: true });
  const second = request(prompts, page);
  await tick();
  dialogs[0].resolve(true);
  await tick();
  assert.deepEqual(first, [true]);
  assert.deepEqual(second, [false]);
});

test('subframe navigation cancels subframe requests without invalidating the main document prompt', async () => {
  const { prompts, dialogs } = harness();
  const page = contents();
  const child = frame('https://embedded.example/');
  page.mainFrame.framesInSubtree.push(child);
  prompts.track(page);
  const main = request(prompts, page);
  const subframe = request(prompts, page, 'screen-wake-lock', child);
  await tick();
  page.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false }, '', false, false);
  assert.deepEqual(subframe, [false]);
  assert.equal(dialogs[0].signal.aborted, false);
  dialogs[0].resolve(true);
  await tick();
  assert.deepEqual(main, [true]);
  assert.equal(dialogs.length, 1);
});

test('a canceled provisional navigation releases the surviving document after loading stops', async () => {
  const { prompts, dialogs } = harness();
  const page = contents();
  prompts.track(page);
  page.loading = true;
  page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }, '', false, true);
  page.emit('did-fail-provisional-load', {}, -3, 'aborted', page.mainFrame.url, true);
  assert.deepEqual(request(prompts, page), [false]);
  page.loading = false;
  page.emit('did-stop-loading');
  const retry = request(prompts, page);
  await tick();
  assert.equal(dialogs.length, 1);
  dialogs[0].resolve(false);
  await tick();
  assert.deepEqual(retry, [false]);
});

test('a canceled navigation does not erase a denial from the surviving document', async () => {
  const { prompts, dialogs } = harness();
  const page = contents();
  prompts.track(page);
  const first = request(prompts, page);
  await tick();
  dialogs[0].resolve(false);
  await tick();
  assert.deepEqual(first, [false]);
  page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }, '', false, true);
  page.emit('did-fail-provisional-load', {}, -3, 'aborted', page.mainFrame.url, true);
  assert.deepEqual(request(prompts, page), [false]);
  assert.equal(dialogs.length, 1);
});

test('destroyed pages, dialog failures, and throwing callbacks fail closed without blocking the queue', async () => {
  const { prompts, dialogs } = harness();
  const page = contents();
  const other = contents('https://other.example/');
  prompts.track(page);
  prompts.track(other);
  const first = request(prompts, page);
  prompts.request(page, 'screen-wake-lock', () => { throw new Error('stale callback'); }, {
    requestingUrl: page.mainFrame.url, isMainFrame: true,
  });
  const queued = request(prompts, page, 'geolocation');
  const next = request(prompts, other);
  await tick();
  page.destroyed = true;
  page.emit('destroyed');
  assert.deepEqual([first, queued], [[false], [false]]);
  assert.equal(dialogs[0].signal.aborted, true);
  dialogs[0].resolve(true);
  await tick();
  dialogs[1].reject(new Error('dialog unavailable'));
  await tick();
  assert.deepEqual(next, [false]);
  assert.deepEqual(request(prompts, other), [false]);
  assert.equal(dialogs.length, 2);
});

test('rejects unknown and opaque requesting documents', () => {
  const { prompts, dialogs } = harness();
  const page = contents();
  prompts.track(page);
  const results = [];
  prompts.request(page, 'screen-wake-lock', value => results.push(value), {});
  prompts.request(page, 'screen-wake-lock', value => results.push(value), { requestingUrl: 'file:///tmp/a', isMainFrame: true });
  prompts.request(page, 'screen-wake-lock', value => results.push(value), { requestingUrl: 'https://play2048.co/old', isMainFrame: true });
  prompts.request(contents(), 'screen-wake-lock', value => results.push(value), { requestingUrl: page.mainFrame.url, isMainFrame: true });
  assert.deepEqual(results, [false, false, false, false]);
  assert.equal(dialogs.length, 0);
});

test('transfers control only for a newly admitted prompt, not silent denials or merged requests', async () => {
  const { prompts, dialogs } = harness();
  const page = contents();
  let ownership = 'agent';
  let transfers = 0;
  prompts.track(page, () => { ownership = 'user'; transfers++; });
  const invalid = [];
  prompts.request(page, 'screen-wake-lock', value => invalid.push(value), {});
  assert.deepEqual(invalid, [false]);
  assert.equal(ownership, 'agent');
  assert.equal(transfers, 0);

  const first = request(prompts, page);
  assert.equal(ownership, 'user');
  assert.equal(transfers, 1);
  ownership = 'agent'; // A later merged request must not transfer control again.
  const merged = request(prompts, page);
  assert.equal(ownership, 'agent');
  assert.equal(transfers, 1);
  await tick();
  dialogs[0].resolve(false);
  await tick();
  assert.deepEqual([first, merged], [[false], [false]]);
  assert.deepEqual(request(prompts, page), [false]);
  assert.equal(ownership, 'agent');
  assert.equal(transfers, 1);
});

test('bounds merged callbacks and rejects overflow without affecting admitted callbacks', async () => {
  const { prompts, dialogs } = harness();
  const page = contents();
  let transfers = 0;
  let ownership = 'agent';
  prompts.track(page, () => { ownership = 'user'; transfers++; });
  const admitted = Array.from({ length: MAX_PERMISSION_CALLBACKS }, () => request(prompts, page));
  ownership = 'agent';
  const overflow = request(prompts, page);
  assert.deepEqual(overflow, [false]);
  assert.equal(transfers, 1);
  assert.equal(ownership, 'agent');
  await tick();
  assert.equal(dialogs.length, 1);
  dialogs[0].resolve(true);
  await tick();
  assert.ok(admitted.every(result => result.length === 1 && result[0] === true));
  assert.deepEqual(overflow, [false]);
});

test('bounds all active and queued prompts, rejecting overflow without taking control', async () => {
  const { prompts, dialogs } = harness();
  const busy = contents();
  const other = contents('https://other.example/');
  let busyTransfers = 0;
  let otherTransfers = 0;
  prompts.track(busy, () => { busyTransfers++; });
  prompts.track(other, () => { otherTransfers++; });
  const admitted = Array.from({ length: MAX_PERMISSION_PROMPTS }, () => request(prompts, busy, 'media'));
  const overflow = request(prompts, other, 'geolocation');
  assert.deepEqual(overflow, [false]);
  assert.equal(busyTransfers, MAX_PERMISSION_PROMPTS);
  assert.equal(otherTransfers, 0);
  await tick();
  assert.equal(dialogs.length, 1);
  dialogs[0].resolve(true);
  await tick();
  assert.deepEqual(admitted[0], [true]);
  assert.equal(dialogs.length, 2);

  // Canceling one page completes every remaining callback once. The active
  // native dialog still occupies a slot until its promise settles.
  busy.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }, '', false, true);
  assert.ok(admitted.slice(1).every(result => result.length === 1 && result[0] === false));
  assert.equal(dialogs[1].signal.aborted, true);
  const retry = request(prompts, other, 'geolocation');
  assert.equal(otherTransfers, 1);
  assert.equal(dialogs.length, 2);
  dialogs[1].resolve(true);
  await tick();
  assert.equal(dialogs.length, 3);
  dialogs[2].resolve(true);
  await tick();
  assert.deepEqual(retry, [true]);
  assert.ok(admitted.slice(1).every(result => result.length === 1 && result[0] === false));
});

test('bounds callbacks across prompts and frees capacity as callbacks complete', async () => {
  const { prompts, dialogs } = harness();
  const groupCount = MAX_PENDING_PERMISSION_CALLBACKS / MAX_PERMISSION_CALLBACKS;
  const pages = Array.from({ length: groupCount + 1 }, (_, index) => contents(`https://group-${index}.example/`));
  const other = contents('https://other.example/');
  let otherTransfers = 0;
  for (const page of pages) prompts.track(page);
  prompts.track(other, () => { otherTransfers++; });
  const admitted = pages.map((page, index) => Array.from({ length: index === groupCount ? 1 :
    index === groupCount - 1 ? MAX_PERMISSION_CALLBACKS - 1 : MAX_PERMISSION_CALLBACKS }, () => request(prompts, page)));
  const overflow = request(prompts, other);
  const duplicateOverflow = request(prompts, pages[groupCount]);
  assert.deepEqual(overflow, [false]);
  assert.deepEqual(duplicateOverflow, [false]);
  assert.equal(otherTransfers, 0);
  await tick();
  assert.equal(dialogs.length, 1);
  dialogs[0].resolve(true);
  await tick();
  assert.ok(admitted[0].every(result => result.length === 1 && result[0] === true));
  const retry = request(prompts, other);
  assert.equal(otherTransfers, 1);
  for (let index = 1; index <= pages.length; index++) {
    assert.equal(dialogs.length, index + 1);
    dialogs[index].resolve(true);
    await tick();
  }
  assert.ok(admitted.flat().every(result => result.length === 1 && result[0] === true));
  assert.deepEqual(retry, [true]);
  assert.deepEqual(overflow, [false]);
  assert.deepEqual(duplicateOverflow, [false]);
});

test('a canceled dialog occupies capacity until it closes, without interrupting other pages', async () => {
  const { prompts, dialogs } = harness();
  const closing = contents('https://closing.example/');
  const queuedPage = contents('https://queued.example/');
  const other = contents('https://other.example/');
  let otherTransfers = 0;
  prompts.track(closing);
  prompts.track(queuedPage);
  prompts.track(other, () => { otherTransfers++; });
  const closedResult = request(prompts, closing);
  const queued = Array.from({ length: MAX_PERMISSION_PROMPTS - 1 }, () => request(prompts, queuedPage, 'media'));
  await tick();
  closing.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }, '', false, true);
  assert.deepEqual(closedResult, [false]);
  assert.equal(dialogs[0].signal.aborted, true);
  assert.deepEqual(request(prompts, other), [false]);
  assert.equal(otherTransfers, 0);
  dialogs[0].resolve(true);
  await tick();
  assert.equal(dialogs.length, 2);
  const retry = request(prompts, other);
  assert.equal(otherTransfers, 1);
  dialogs[1].resolve(true);
  await tick();
  assert.deepEqual(queued[0], [true]);
  queuedPage.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }, '', false, true);
  assert.ok(queued.slice(1).every(result => result.length === 1 && result[0] === false));
  dialogs[2].resolve(true);
  await tick();
  assert.equal(dialogs.length, 4);
  dialogs[3].resolve(true);
  await tick();
  assert.deepEqual(retry, [true]);
});

test('reentrant requests after stale cancellation join the new entry without losing callbacks', async () => {
  const { prompts, dialogs } = harness();
  const page = contents();
  let transfers = 0;
  prompts.track(page, () => { transfers++; });
  const oldResult = [];
  const reentered = [];
  prompts.request(page, 'screen-wake-lock', value => {
    oldResult.push(value);
    prompts.request(page, 'screen-wake-lock', result => reentered.push(result), {
      requestingUrl: page.mainFrame.url, isMainFrame: true,
    });
  }, { requestingUrl: page.mainFrame.url, isMainFrame: true });
  await tick();
  const replacement = frame(page.mainFrame.url);
  replacement.framesInSubtree = [replacement];
  page.mainFrame = replacement;
  const outer = request(prompts, page);
  assert.deepEqual(oldResult, [false]);
  assert.equal(transfers, 2);
  assert.equal(dialogs[0].signal.aborted, true);
  dialogs[0].resolve(true);
  await tick();
  assert.equal(dialogs.length, 2);
  dialogs[1].resolve(true);
  await tick();
  assert.deepEqual([oldResult, reentered, outer], [[false], [true], [true]]);
});

test('reentrant callbacks while skipping stale queued entries do not open overlapping dialogs', async () => {
  const { prompts, dialogs } = harness();
  const first = contents('https://first.example/');
  const stale = contents('https://stale.example/');
  const next = contents('https://next.example/');
  const reentrant = contents('https://reentrant.example/');
  for (const page of [first, stale, next, reentrant]) prompts.track(page);
  const firstResult = request(prompts, first);
  const staleResult = [];
  const reentrantResult = [];
  prompts.request(stale, 'geolocation', value => {
    staleResult.push(value);
    prompts.request(reentrant, 'geolocation', result => reentrantResult.push(result), {
      requestingUrl: reentrant.mainFrame.url, isMainFrame: true,
    });
  }, { requestingUrl: stale.mainFrame.url, isMainFrame: true });
  const nextResult = request(prompts, next, 'geolocation');
  await tick();
  stale.mainFrame.destroyed = true;
  dialogs[0].resolve(true);
  await tick();
  assert.deepEqual([firstResult, staleResult, nextResult, reentrantResult], [[true], [false], [], []]);
  assert.equal(dialogs.length, 2);
  assert.equal(dialogs[1].origin, 'https://next.example');
  dialogs[1].resolve(true);
  await tick();
  assert.deepEqual(nextResult, [true]);
  assert.equal(dialogs.length, 3);
  assert.equal(dialogs[2].origin, 'https://reentrant.example');
  dialogs[2].resolve(false);
  await tick();
  assert.deepEqual(reentrantResult, [false]);
});

test('nested navigation and reentrant requests complete every canceled callback once', async () => {
  const { prompts, dialogs } = harness();
  const page = contents();
  const other = contents('https://other.example/');
  prompts.track(page);
  prompts.track(other);
  const active = [];
  const queued = [];
  const blocked = [];
  const otherResult = [];
  const navigation = { isMainFrame: true, isSameDocument: false };
  prompts.request(page, 'screen-wake-lock', value => {
    active.push(value);
    page.emit('did-start-navigation', navigation, '', false, true);
    prompts.request(other, 'geolocation', result => otherResult.push(result), {
      requestingUrl: other.mainFrame.url, isMainFrame: true,
    });
  }, { requestingUrl: page.mainFrame.url, isMainFrame: true });
  prompts.request(page, 'geolocation', value => {
    queued.push(['geolocation', value]);
    prompts.request(page, 'media', result => blocked.push(result), {
      requestingUrl: page.mainFrame.url, isMainFrame: true,
    });
  }, { requestingUrl: page.mainFrame.url, isMainFrame: true });
  prompts.request(page, 'media', value => queued.push(['media', value]), {
    requestingUrl: page.mainFrame.url, isMainFrame: true,
  });
  await tick();
  page.emit('did-start-navigation', navigation, '', false, true);
  assert.deepEqual(active, [false]);
  assert.deepEqual(queued, [['geolocation', false], ['media', false]]);
  assert.deepEqual(blocked, [false]);
  assert.deepEqual(otherResult, []);
  dialogs[0].resolve(true);
  await tick();
  assert.equal(dialogs.length, 2);
  dialogs[1].resolve(true);
  await tick();
  assert.deepEqual(otherResult, [true]);
  assert.deepEqual(active, [false]);
  assert.equal(queued.length, 2);
});

test('failed handoff rejects its queued group and leaves the scheduler usable', async () => {
  const { prompts, dialogs } = harness();
  const page = contents();
  const other = contents('https://other.example/');
  const nested = [];
  prompts.track(page, () => {
    prompts.request(page, 'screen-wake-lock', value => nested.push(value), {
      requestingUrl: page.mainFrame.url, isMainFrame: true,
    });
    throw new Error('handoff failed');
  });
  prompts.track(other);
  const failed = request(prompts, page);
  assert.deepEqual([failed, nested], [[false], [false]]);
  const next = request(prompts, other);
  await tick();
  assert.equal(dialogs.length, 1);
  dialogs[0].resolve(true);
  await tick();
  assert.deepEqual(next, [true]);
});
