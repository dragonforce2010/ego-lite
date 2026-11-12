// The host supplies real DOM backend ids. The upstream SDK owns durable @refs.
const roleNames = { RootWebArea: 'document', StaticText: 'text', generic: 'container', none: 'container' };
const omitted = new Set(['InlineTextBox', 'LineBreak']);
const valueOf = value => value?.value;

function rectangles(snapshot) {
  const result = new Map();
  for (const doc of snapshot.documents ?? []) {
    const ids = doc.nodes?.backendNodeId ?? [];
    const layout = doc.layout ?? {};
    for (let i = 0; i < (layout.nodeIndex?.length ?? 0); i++) {
      const backend = ids[layout.nodeIndex[i]];
      if (backend) result.set(backend, { bounds: layout.bounds[i], x: doc.scrollOffsetX ?? 0, y: doc.scrollOffsetY ?? 0 });
    }
  }
  return result;
}

export async function captureSnapshot(page, options = {}, ensureControl = async () => {}) {
  const send = (method, params = {}, sessionId) => page.view.webContents.debugger.sendCommand(method, params, sessionId);
  const tree = await send('Page.getFrameTree');
  const frames = [];
  const visitFrame = branch => {
    frames.push(branch.frame);
    for (const child of branch.childFrames ?? []) visitFrame(child);
  };
  visitFrame(tree.frameTree);
  for (const child of page.childTargets.values()) {
    if (child.targetInfo?.type === 'iframe' && !frames.some(f => f.id === child.targetInfo.targetId)) {
      frames.push({ id: child.targetInfo.targetId, url: child.targetInfo.url });
    }
  }
  const refs = [];
  const lines = ['root'];
  let refId = 0;
  let length = 5;
  let truncated = false;
  let foundRoot = options.root === undefined;
  const limit = Math.min(250000, Number(options.maxResultLength) || 250000);
  const captures = [];
  for (const frame of frames.slice(0, 32)) {
    await ensureControl();
    const child = [...page.childTargets.entries()].find(([, data]) => data.targetInfo?.targetId === frame.id);
    const sessionId = child?.[0];
    try {
      const ax = await send('Accessibility.getFullAXTree', { frameId: frame.id }, sessionId);
      let geometry = new Map();
      let viewport = { width: 100000, height: 100000 };
      if (options.scope !== 'full_page') {
        const dom = await send('DOMSnapshot.captureSnapshot', { computedStyles: [], includeDOMRects: true }, sessionId);
        geometry = rectangles(dom);
        const metrics = await send('Page.getLayoutMetrics', {}, sessionId);
        viewport = metrics.cssVisualViewport ?? metrics.visualViewport ?? viewport;
      }
      captures.push({ frame, nodes: ax.nodes, geometry, viewport });
    } catch (error) {
      // Missing a frame must be explicit: never silently claim a complete capture.
      if (frame.id === tree.frameTree.frame.id) throw error;
      lines.push(`  text ${JSON.stringify('[Embedded frame unavailable; use a fresh screenshot or retry]')}`);
    }
  }
  const matches = captures.flatMap(c => c.nodes.filter(n => n.backendDOMNodeId === options.root).map(n => ({ capture: c, node: n })));
  if (options.root !== undefined && matches.length !== 1) {
    throw Object.assign(new Error('Snapshot subtree root is missing or ambiguous across frames'), { error_code: 'EGO_SNAPSHOT_FAILED' });
  }
  for (const capture of captures) {
    const { frame, nodes, geometry, viewport } = capture;
    const byId = new Map(nodes.map(n => [n.nodeId, n]));
    const selectedRoot = options.root === undefined ? nodes.find(n => !n.parentId || !byId.has(n.parentId)) : matches[0]?.capture === capture ? matches[0].node : null;
    if (!selectedRoot) continue;
    foundRoot = true;
    if (frame.id !== tree.frameTree.frame.id) lines.push('  iframe');
    const seen = new Set();
    const walk = (node, depth) => {
      if (!node || seen.has(node.nodeId) || truncated || seen.size > 16000) return;
      seen.add(node.nodeId);
      const rawRole = valueOf(node.role) ?? 'container';
      const role = roleNames[rawRole] ?? rawRole;
      const backendNodeId = node.backendDOMNodeId;
      const rect = geometry.get(backendNodeId);
      const bounds = rect?.bounds;
      const visible = !bounds || (bounds[2] > 0 && bounds[3] > 0 && bounds[0] - rect.x < (viewport.clientWidth ?? viewport.width) && bounds[1] - rect.y < (viewport.clientHeight ?? viewport.height) && bounds[0] + bounds[2] > rect.x && bounds[1] + bounds[3] > rect.y);
      const keep = !node.ignored && !omitted.has(rawRole) && (options.scope === 'full_page' || visible);
      let nextDepth = depth;
      if (keep) {
        const name = String(valueOf(node.name) ?? '').slice(0, 3000);
        const value = valueOf(node.value);
        const properties = (node.properties ?? []).filter(p => ['checked', 'selected', 'expanded', 'disabled', 'required', 'level', 'multiline'].includes(p.name));
        const nativeRef = backendNodeId > 0 ? ++refId : undefined;
        let text = `${'  '.repeat(Math.min(depth, 30))}${role}${name ? ` ${JSON.stringify(name)}` : ''}`;
        if (value !== undefined && value !== '') text += ` value=${JSON.stringify(String(value).slice(0, 1500))}`;
        for (const property of properties) text += ` ${property.name}=${JSON.stringify(valueOf(property.value))}`;
        if (nativeRef) text += ` [ref=${nativeRef}]`;
        if (length + text.length > limit) { truncated = true; return; }
        lines.push(text);
        length += text.length + 1;
        if (nativeRef) {
          // The SDK treats frameId as an embedded-frame scope, even when
          // frameProvenance is page. Top-level refs must remain unscoped.
          const owner = frame.id === tree.frameTree.frame.id
            ? { frameProvenance: 'page' }
            : { frameId: frame.id, frameProvenance: 'frame' };
          refs.push({ refId: nativeRef, backendNodeId, role, name, ...owner });
        }
        nextDepth = depth + 1;
      }
      for (const id of node.childIds ?? []) walk(byId.get(id), nextDepth);
    };
    walk(selectedRoot, 1);
  }
  if (!foundRoot) throw Object.assign(new Error('Snapshot subtree was not found'), { error_code: 'EGO_SNAPSHOT_FAILED' });
  if (truncated) lines.push('  text "[Snapshot truncated; request a subtree or inspect a screenshot]"');
  return { content: lines.join('\n'), refs };
}
