// Appendix H basics without axe (not an approved package): alt attributes, accessible names from
// Chromium's own accessibility tree, html[lang], no positive tabindex, a visible focus indicator,
// and no horizontal scroll at 320 CSS px. The Next.js dev overlay (<nextjs-portal>) is ignored.
import assert from 'node:assert/strict';

// Roles whose nodes must carry a name, besides every input/select/textarea/button element.
const NAMED_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch',
  'slider', 'spinbutton', 'menuitem', 'tab',
]);
const CONTROL_TAGS = new Set(['input', 'select', 'textarea', 'button']);

function attrMap(list = []) {
  const out = {};
  for (let i = 0; i < list.length; i += 2) out[list[i]] = list[i + 1];
  return out;
}

function describeNode(tag, a) {
  const bits = [tag];
  if (a.id) bits.push(`#${a.id}`);
  for (const k of ['type', 'name', 'role', 'href', 'placeholder']) if (a[k]) bits.push(`[${k}="${a[k].slice(0, 60)}"]`);
  return `<${bits.join('')}>`;
}

// Every input, select, textarea, button and named-role node that assistive technology can reach
// has a non-empty accessible name, as computed by Chromium (CDP Accessibility domain).
export async function unnamedControls(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('Accessibility.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const dom = new Map();
    const walk = (node, inOverlay) => {
      const overlay = inOverlay || node.nodeName === 'NEXTJS-PORTAL';
      dom.set(node.backendNodeId, { node, overlay });
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? []), ...(node.contentDocument ? [node.contentDocument] : [])]) {
        walk(child, overlay);
      }
    };
    walk(root, false);
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const problems = [];
    for (const ax of nodes) {
      if (ax.ignored || !ax.backendDOMNodeId) continue;
      const entry = dom.get(ax.backendDOMNodeId);
      if (!entry || entry.overlay) continue;
      const tag = entry.node.nodeName.toLowerCase();
      const attrs = attrMap(entry.node.attributes);
      const role = String(ax.role?.value ?? '');
      const isControl = (CONTROL_TAGS.has(tag) && attrs.type !== 'hidden') || NAMED_ROLES.has(role);
      if (!isControl) continue;
      if (!String(ax.name?.value ?? '').trim()) problems.push(`${role || tag} has no accessible name: ${describeNode(tag, attrs)}`);
    }
    return problems;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

// Every <img> has an alt attribute (empty is right for decorative images); html[lang] is set; no
// element has a positive tabindex.
export async function documentProblems(page) {
  return page.evaluate(() => {
    const out = [];
    for (const img of document.querySelectorAll('img:not([alt])')) {
      out.push(`img without an alt attribute: ${(img.currentSrc || img.src || '').slice(0, 100)}`);
    }
    if (!document.documentElement.getAttribute('lang')?.trim()) out.push('<html> has no lang attribute');
    for (const el of document.querySelectorAll('[tabindex]')) {
      const v = Number.parseInt(el.getAttribute('tabindex'), 10);
      if (v > 0) out.push(`positive tabindex=${v} on <${el.tagName.toLowerCase()}> ${el.textContent.replace(/\s+/g, ' ').trim().slice(0, 40)}`);
    }
    return out;
  });
}

// Tabs through up to `stops` elements from the current focus; each focused element must show a
// non-none outline or a box-shadow.
export async function focusProblems(page, stops = 12) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < stops; i++) {
    await page.keyboard.press('Tab');
    const r = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement || el.tagName === 'NEXTJS-PORTAL') return null;
      const cs = getComputedStyle(el);
      const outline = cs.outlineStyle !== 'none' && Number.parseFloat(cs.outlineWidth) > 0;
      const shadow = Boolean(cs.boxShadow) && cs.boxShadow !== 'none';
      const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || el.id || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      return { key: `<${el.tagName.toLowerCase()}> ${name}`, ok: outline || shadow };
    });
    if (!r) continue;
    if (seen.has(r.key)) break; // wrapped around
    seen.add(r.key);
    if (!r.ok) out.push(`no visible focus indicator (outline or box-shadow) on ${r.key}`);
  }
  if (seen.size === 0) out.push('Tab never moved focus to an element');
  return out;
}

// Reflow (WCAG 1.4.10): at the current viewport the page itself does not scroll sideways.
// Scrolling inside an overflow container (a wide table) is allowed.
export async function reflowProblems(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const vw = root.clientWidth;
    if (root.scrollWidth <= vw + 1) return [];
    const wide = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (el.closest('nextjs-portal')) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1) {
        const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
        wide.push(`<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}> right edge ${Math.round(r.right)}px`);
        if (wide.length >= 6) break;
      }
    }
    return [`the page scrolls sideways at ${vw}px (content is ${root.scrollWidth}px wide); widest: ${wide.join(', ')}`];
  });
}

export async function assertAccessible(page, where, { focusStops = 12 } = {}) {
  const problems = [...(await documentProblems(page)), ...(await unnamedControls(page)), ...(await focusProblems(page, focusStops))];
  assert.deepEqual(problems, [], `${where}: accessibility problems (Appendix H):\n  ${problems.join('\n  ')}`);
}
