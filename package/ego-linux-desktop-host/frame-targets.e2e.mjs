// Feed to this Linux host's CLI: ego-browser-linux nodejs < frame-targets.e2e.mjs
const http = await import('node:http');
const fs = await import('node:fs/promises');
const os = await import('node:os');
const path = await import('node:path');
const { spawn } = await import('node:child_process');
const { randomUUID } = await import('node:crypto');
const assert = (await import('node:assert/strict')).default;
const servers = [];
const tasks = [];
const name = 'Linux frame targets ' + randomUUID();

async function serve(host, render) {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(render(request.url));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  servers.push(server);
  return `http://${host}:${server.address().port}`;
}

async function fillRef(page, name, value) {
  const snapshot = await page.snapshot({ scope: 'full_page' });
  const line = snapshot.split('\n').find(text => text.trimStart().startsWith('textbox ') && text.includes(JSON.stringify(name)));
  const ref = line?.match(/\[ref=([0-9]+)\]/)?.[1];
  assert.ok(ref, 'Missing actual textbox reference: ' + name);
  await page.fill('@' + ref, value);
  const after = await page.snapshot({ scope: 'full_page' });
  const changed = after.split('\n').find(text => text.trimStart().startsWith('textbox ') && text.includes(JSON.stringify(name)));
  assert.ok(changed?.includes(`value=${JSON.stringify(value)}`), 'Reference filled its own frame: ' + name);
}

async function nextClient(source) {
  const child = spawn(process.execPath, [process.argv[1], 'nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', value => { stdout += value; });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { stderr += value; });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  child.stdin.end(source);
  const code = await done;
  assert.equal(code, 0, 'Independent CLI client succeeded: ' + stderr);
  assert.ok(stdout.includes('LINUX_FRAME_SECOND_CLIENT_PASS'), 'Independent CLI client read frame values');
}

try {
  const cross = await serve('127.0.0.2', () => '<!doctype html><title>Cross frame</title><input aria-label="Cross frame ref">');
  const main = await serve('127.0.0.1', route => route === '/same'
    ? '<!doctype html><title>Same frame</title><input aria-label="Same frame ref">'
    : `<!doctype html><title>Linux frame targets</title><h1>Real frame reference regression</h1><input aria-label="Main frame ref"><iframe title="Same origin" src="/same"></iframe><iframe title="Cross origin" src="${cross}/"></iframe>`);
  const task = await taskSpace(name); tasks.push(task);
  const page = task.page('p1');
  await page.goto(main + '/'); await page.waitForLoadState();
  await page.waitForSelector('loc=role:textbox[name="Cross frame ref"]', { state: 'visible', timeout: 15000 });
  for (const [label, value] of [['Main frame ref', 'main-value'], ['Same frame ref', 'same-value'], ['Cross frame ref', 'cross-value']]) {
    await fillRef(page, label, value);
  }
  const owned = await task.cdp('Target.getTargets');
  const frame = owned.targetInfos.find(info => info.type === 'iframe');
  assert.ok(frame, 'The owned OOPIF is discoverable');
  assert.equal((await task.cdp('Target.getTargetInfo', { targetId: frame.targetId })).targetInfo.targetId, frame.targetId);
  const attached = await task.cdp('Target.attachToTarget', { targetId: frame.targetId, flatten: true });
  assert.ok(attached.sessionId, 'The owned OOPIF can be attached');
  await task.cdp('Target.detachFromTarget', { sessionId: attached.sessionId });
  await fillRef(page, 'Cross frame ref', 'cross-after-detach');

  const foreign = await taskSpace(name + ' foreign'); tasks.push(foreign);
  const foreignPage = foreign.page('p1');
  await foreignPage.goto(main + '/'); await foreignPage.waitForLoadState();
  await foreignPage.waitForSelector('loc=role:textbox[name="Cross frame ref"]', { state: 'visible', timeout: 15000 });
  await foreignPage.snapshot({ scope: 'full_page' });
  const foreignTargets = await foreign.cdp('Target.getTargets');
  const foreignFrame = foreignTargets.targetInfos.find(info => info.type === 'iframe');
  assert.ok(foreignFrame, 'The second space has its own OOPIF');
  const foreignAttached = await foreign.cdp('Target.attachToTarget', { targetId: foreignFrame.targetId, flatten: true });
  const scoped = await task.cdp('Target.getTargets');
  assert.ok(scoped.targetInfos.every(info => !foreignTargets.targetInfos.some(other => other.targetId === info.targetId)), 'Enumeration excludes the other space');
  await assert.rejects(() => task.cdp('Target.getTargetInfo', { targetId: foreignFrame.targetId }), /not in this task space/);
  await assert.rejects(() => task.cdp('Target.attachToTarget', { targetId: foreignFrame.targetId, flatten: true }), /not in this task space/);
  await assert.rejects(() => task.cdp('Target.detachFromTarget', { sessionId: foreignAttached.sessionId }), /Unknown target session/);
  const foreignSnapshot = await foreignPage.snapshot({ scope: 'full_page' });
  for (const label of ['Main frame ref', 'Same frame ref', 'Cross frame ref']) {
    const line = foreignSnapshot.split('\n').find(text => text.trimStart().startsWith('textbox ') && text.includes(JSON.stringify(label)));
    const value = line?.match(/\bvalue=("(?:[^"\\]|\\.)*")/)?.[1];
    assert.ok(line, 'The foreign textbox remains present: ' + label);
    assert.equal(value ? JSON.parse(value) : '', '', 'Rejected foreign operations leave the form unchanged: ' + label);
  }

  await nextClient(`
    const task = await taskSpace(${task.spaceId});
    const page = task.page('p1');
    const observed = await page.snapshot({scope:'full_page'});
    for (const value of ['main-value','same-value','cross-after-detach']) {
      if (!observed.includes('value=' + JSON.stringify(value))) throw Error('Missing frame value after client reconnect');
    }
    console.log('LINUX_FRAME_SECOND_CLIENT_PASS');
  `);
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ego-linux-frame-targets-'));
  const screenshot = await page.screenshot({ path: path.join(artifactDir, 'frame-targets.png') });
  console.log('LINUX_FRAME_TARGETS_PASS ' + JSON.stringify({ frames: 3, ownAttachDetach: true, foreignDeniedWithoutMutation: true, independentClientReconnect: true, screenshot }));
} finally {
  for (const task of tasks.reverse()) await task.finish({ keep: [] });
  for (const server of servers) await new Promise(resolve => server.close(resolve));
}
