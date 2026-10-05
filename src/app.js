const $ = (s) => document.querySelector(s);
const doc = $('#doc'), scroller = $('#scroller'), tocList = $('#toc-list');
const editor = $('#editor'), editorPane = $('#editor-pane');
let headings = [];
let tabs = [], active = -1;
let sourceMode = false, editing = false, recent = [];
let untitledN = 0;

const cur = () => tabs[active];
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

/* ---------- theme / layout ---------- */
function setTheme(t) { document.documentElement.dataset.theme = t; lsSet('theme', t); }
setTheme(lsGet('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
const toggleTheme = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
function setWide(w) { document.body.classList.toggle('wide', w); lsSet('wide', w ? '1' : '0'); }
setWide(lsGet('wide') === '1');
const toggleWide = () => setWide(!document.body.classList.contains('wide'));

/* ---------- building the rendered document ---------- */
function slugify(t) {
  return t.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-') || 'section';
}
function fileBase(p) { return p ? encodeURI('file:///' + p.replace(/\\/g, '/')) : null; }

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { meta: null, body: text };
  const meta = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w.-]+)\s*:\s*(.*)$/);
    if (kv) meta.push([kv[1], kv[2].replace(/^["']|["']$/g, '')]);
  }
  return { meta: meta.length ? meta : null, body: meta.length ? text.slice(m[0].length) : text };
}

const CALLOUTS = {
  note: ['Note', 'info'], info: ['Info', 'info'], abstract: ['Abstract', 'info'], summary: ['Summary', 'info'], todo: ['To do', 'info'],
  tip: ['Tip', 'tip'], hint: ['Hint', 'tip'], success: ['Success', 'tip'], check: ['Done', 'tip'], done: ['Done', 'tip'],
  important: ['Important', 'imp'], question: ['Question', 'imp'], help: ['Help', 'imp'], faq: ['FAQ', 'imp'],
  warning: ['Warning', 'warn'], caution: ['Caution', 'warn'], attention: ['Attention', 'warn'],
  danger: ['Danger', 'bad'], error: ['Error', 'bad'], bug: ['Bug', 'bad'], failure: ['Failure', 'bad'],
  example: ['Example', 'imp'], quote: ['Quote', 'info'],
};

function makeCallouts(root) {
  root.querySelectorAll('blockquote').forEach((bq) => {
    const p = bq.firstElementChild;
    if (!p || p.tagName !== 'P') return;
    const n = p.firstChild;
    if (!n || n.nodeType !== 3) return;
    const m = n.nodeValue.match(/^\s*\[!(\w+)\][+-]?[ \t]*([^\n]*)\n?/);
    if (!m) return;
    const type = m[1].toLowerCase();
    const def = CALLOUTS[type] || [type[0].toUpperCase() + type.slice(1), 'info'];
    n.nodeValue = n.nodeValue.slice(m[0].length);
    if (!p.textContent.trim() && !p.querySelector('*')) p.remove();
    const box = document.createElement('div');
    box.className = 'callout c-' + def[1];
    const title = document.createElement('div');
    title.className = 'callout-title';
    title.textContent = m[2] || def[0];
    box.appendChild(title);
    while (bq.firstChild) box.appendChild(bq.firstChild);
    bq.replaceWith(box);
  });
}

function decorateCode(root) {
  root.querySelectorAll('pre').forEach((pre) => {
    const code = pre.querySelector('code');
    if (!code) return;
    const lang = ((code.className.match(/language-([\w+-]+)/) || [])[1]) || '';
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    const head = document.createElement('div');
    head.className = 'code-head';
    const l = document.createElement('span');
    l.textContent = lang;
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'Copy';
    head.append(l, btn);
    pre.replaceWith(wrap);
    wrap.append(head, pre);
  });
}

/* block-level diff between two versions (used by the "what changed" view) */
function diffBlocks(oldText, newText) {
  const A = window.api.blocks(parseFrontmatter(oldText).body);
  const B = window.api.blocks(parseFrontmatter(newText).body);
  const n = A.length, m = B.length;
  const ops = [];
  if (n * m > 4e6) {
    A.forEach((b) => ops.push({ t: 'del', html: b.html }));
    B.forEach((b) => ops.push({ t: 'add', html: b.html }));
    return ops;
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i].raw === B[j].raw ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i].raw === B[j].raw) { ops.push({ t: 'eq', html: B[j].html }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: 'del', html: A[i++].html });
    else ops.push({ t: 'add', html: B[j++].html });
  }
  while (i < n) ops.push({ t: 'del', html: A[i++].html });
  while (j < m) ops.push({ t: 'add', html: B[j++].html });
  return ops;
}
function diffStats(oldText, newText) {
  const ops = diffBlocks(oldText, newText);
  return { add: ops.filter((o) => o.t === 'add').length, del: ops.filter((o) => o.t === 'del').length };
}

function build(text, filePath, diffBase) {
  const { meta, body } = parseFrontmatter(text);
  const div = document.createElement('div');
  if (diffBase != null) {
    div.innerHTML = diffBlocks(diffBase, text).map((o) => `<div class="blk ${o.t}">${o.html}</div>`).join('');
  } else div.innerHTML = window.api.render(body);

  if (meta) {
    const fm = document.createElement('div');
    fm.className = 'frontmatter';
    meta.forEach(([k, v]) => {
      const row = document.createElement('div');
      const kk = document.createElement('span'); kk.className = 'fm-k'; kk.textContent = k;
      const vv = document.createElement('span'); vv.className = 'fm-v'; vv.textContent = v;
      row.append(kk, vv);
      fm.appendChild(row);
    });
    div.prepend(fm);
  }

  decorateTables(div);
  makeCallouts(div);
  decorateCode(div);
  decorateHeadings(div);
  decorateTasks(div, diffBase != null);

  const base = fileBase(filePath);
  if (base) {
    div.querySelectorAll('img').forEach((img) => {
      const s = img.getAttribute('src') || '';
      if (s && !/^(https?:|data:|file:|\/\/)/i.test(s)) { try { img.src = new URL(s, base).href; } catch {} }
    });
  }
  return div;
}

/* ---------- displaying ---------- */
function showEmpty() {
  doc.textContent = '';
  const box = document.createElement('div');
  box.id = 'empty';
  const h = document.createElement('h1'); h.textContent = 'MD Reader';
  const p = document.createElement('p'); p.textContent = 'Open a Markdown file, drag one here, or start a new one.';
  const row = document.createElement('p');
  const b1 = document.createElement('button'); b1.className = 'primary'; b1.textContent = 'Open file…'; b1.onclick = () => window.api.openDialog();
  const b2 = document.createElement('button'); b2.className = 'ghost'; b2.textContent = 'New file'; b2.onclick = newTab;
  const b3 = document.createElement('button'); b3.className = 'ghost'; b3.textContent = 'Paste from clipboard'; b3.onclick = () => openFromClipboard();
  row.append(b1, ' ', b2, ' ', b3);
  box.append(h, p, row);
  if (recent.length) {
    const rh = document.createElement('div'); rh.className = 'recent-h'; rh.textContent = 'Recent';
    box.appendChild(rh);
    recent.slice(0, 8).forEach((f) => {
      const a = document.createElement('a');
      a.className = 'recent-item';
      a.textContent = f.split(/[\\/]/).pop();
      const sub = document.createElement('small'); sub.textContent = f;
      a.appendChild(sub);
      a.onclick = () => window.api.openPath(f);
      box.appendChild(a);
    });
  }
  doc.appendChild(box);
}

function updateChrome() {
  const t = cur();
  $('#filename').textContent = t ? (t.dirty ? '● ' : '') + t.name : 'MD Reader';
  $('#filename').title = t && t.path ? t.path : '';
  document.title = t ? `${t.dirty ? '● ' : ''}${t.name} | MD Reader` : 'MD Reader';
  $('#btn-edit').classList.toggle('on', editing);
  $('#btn-source').classList.toggle('on', sourceMode);
  document.body.classList.toggle('editing', editing);
  editorPane.hidden = !editing || !t;
  $('#st-path').textContent = t && t.path ? t.path : (t ? 'Not saved yet' : '');
  if (t) {
    const body = parseFrontmatter(t.text).body;
    const words = (body.match(/\S+/g) || []).length;
    const mins = Math.max(1, Math.round(words / 220));
    const tasks = parseTasks(t.text);
    const done = tasks.filter(Boolean).length;
    $('#st-stats').textContent = `${words.toLocaleString()} words · ~${Math.ceil(t.text.length / 4).toLocaleString()} tokens · ${mins} min read` +
      (tasks.length ? ` · ✓ ${done}/${tasks.length} tasks` : '');
  } else $('#st-stats').textContent = '';
  window.api.setDirty(tabs.some((x) => x.dirty));
  const cb = $('#changebar');
  if (t && t.base != null && t.diff) {
    cb.hidden = false;
    $('#cb-text').textContent = `Changed since you last read: ${t.diff.add} block${t.diff.add === 1 ? '' : 's'} added or edited, ${t.diff.del} removed`;
    $('#cb-toggle').textContent = t.showChanges ? 'Hide changes' : 'Show changes';
  } else cb.hidden = true;
  renderTabs();
}

function renderTabs() {
  const bar = $('#tabs');
  bar.hidden = tabs.length < 2;
  bar.textContent = '';
  tabs.forEach((t, i) => {
    const el = document.createElement('div');
    el.className = 'tab' + (i === active ? ' active' : '');
    el.title = t.path || t.name;
    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = (t.dirty ? '● ' : '') + t.name;
    const x = document.createElement('button');
    x.className = 'tab-x';
    x.textContent = '×';
    x.onclick = (e) => { e.stopPropagation(); closeTab(i); };
    el.append(name, x);
    el.onclick = () => switchTab(i);
    el.onauxclick = (e) => { if (e.button === 1) closeTab(i); };
    bar.appendChild(el);
  });
}

function showPreview(keepScroll) {
  const t = cur();
  const prev = scroller.scrollTop;
  if (!t) { showEmpty(); buildToc(); clearFind(); updateChrome(); return; }
  if (sourceMode) {
    doc.textContent = '';
    const pre = document.createElement('pre');
    pre.className = 'source';
    pre.textContent = t.text;
    doc.appendChild(pre);
  } else {
    doc.replaceChildren(...build(t.text, t.path, t.showChanges && t.base != null ? t.base : null).childNodes);
  }
  buildToc();
  applyNotes();
  if (!$('#find-bar').hidden && $('#find-input').value) runFind(); else clearFind();
  scroller.style.scrollBehavior = 'auto';
  scroller.scrollTop = keepScroll ? prev : (t.scroll || 0);
  scroller.style.scrollBehavior = '';
  spy();
  updateProgress();
}

function show() {
  const t = cur();
  editor.value = t ? t.text : '';
  loadNotes();
  showPreview(false);
  updateChrome();
}

/* ---------- tabs ---------- */
function switchTab(i) {
  if (i === active || i < 0 || i >= tabs.length) return;
  if (cur()) cur().scroll = scroller.scrollTop;
  active = i;
  show();
}
function addTab(t) { tabs.push(t); active = tabs.length - 1; show(); }
function newTab() {
  untitledN++;
  addTab({ path: null, name: untitledN === 1 ? 'Untitled.md' : `Untitled ${untitledN}.md`, text: '# Untitled\n\n', scroll: 0, dirty: false });
  setEditing(true);
  editor.focus();
  editor.setSelectionRange(editor.value.length, editor.value.length);
}
function closeTab(i) {
  const t = tabs[i];
  if (!t) return;
  if (t.dirty && !confirm(`"${t.name}" has unsaved changes. Close and discard them?`)) return;
  if (t.path) window.api.unwatch(t.path);
  tabs.splice(i, 1);
  if (active >= tabs.length) active = tabs.length - 1;
  else if (i < active) active--;
  if (!tabs.length) { editing = false; }
  show();
}
function stepTab(d) { if (tabs.length > 1) switchTab((active + d + tabs.length) % tabs.length); }

// remember the last version you read, so we can show what changed next time
function noteBaseline(t) {
  if (!t.path || t.text.length > 400000) return;
  const old = lsGet('base:' + t.path);
  if (old !== null && old !== t.text) {
    const d = diffStats(old, t.text);
    if (d.add || d.del) { t.base = old; t.diff = d; }
  }
  lsSet('base:' + t.path, t.text);
}

window.api.onLoaded(({ name, path, text }) => {
  const i = tabs.findIndex((t) => t.path && t.path.toLowerCase() === path.toLowerCase());
  if (i >= 0) {
    if (!tabs[i].dirty && tabs[i].text !== text) externalChange(tabs[i], text);
    if (i === active) { if (!tabs[i].dirty) editor.value = tabs[i].text; showPreview(true); updateChrome(); } else switchTab(i);
    return;
  }
  // replace an empty, untouched untitled tab
  const c = cur();
  if (c && !c.path && !c.dirty && c.text.trim() === '# Untitled') tabs.splice(active, 1);
  const nt = { path, name, text, scroll: 0, dirty: false };
  noteBaseline(nt);
  addTab(nt);
});

function externalChange(t, text) {
  const prev = t.text;
  const keep = t.base != null ? t.base : prev; // cumulative since last read
  t.text = text;
  const d = text.length < 400000 ? diffStats(keep, text) : { add: 0, del: 0 };
  if (d.add || d.del) { t.base = keep; t.diff = d; } else { t.base = null; t.diff = null; t.showChanges = false; }
  if (t.path) lsSet('base:' + t.path, text);
  if (t === cur()) {
    editor.value = text;
    showPreview(true);
    updateChrome();
    if (t.base != null) toast('File updated on disk. See what changed.');
  }
}
window.api.onChanged(({ path, text }) => {
  const t = tabs.find((x) => x.path === path);
  if (!t || t.dirty || t.text === text) return;
  externalChange(t, text);
});
window.api.onRecent((list) => { recent = list; if (!tabs.length) showEmpty(); });
window.api.getRecent().then((l) => { recent = l; if (!tabs.length) showEmpty(); });

/* ---------- table of contents ---------- */
function buildToc() {
  const seen = {};
  headings = sourceMode ? [] : [...doc.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter((h) => !h.closest('#empty'));
  tocList.textContent = '';
  if (!headings.length) {
    const d = document.createElement('div');
    d.className = 'toc-none';
    d.textContent = cur() ? 'No headings' : '';
    tocList.appendChild(d);
    return;
  }
  headings.forEach((h, i) => {
    const label = hText(h);
    let id = slugify(label);
    seen[id] = (seen[id] ?? -1) + 1;
    if (seen[id]) id += '-' + seen[id];
    h.id = id;
    const a = document.createElement('a');
    a.className = 'l' + h.tagName[1];
    a.textContent = label;
    a.title = label;
    a.addEventListener('click', () => h.scrollIntoView());
    tocList.appendChild(a);
  });
}

let spyRaf;
function spy() {
  cancelAnimationFrame(spyRaf);
  spyRaf = requestAnimationFrame(() => {
    if (!headings.length) return;
    const top = scroller.getBoundingClientRect().top + 40;
    let idx = 0;
    for (let i = 0; i < headings.length; i++) {
      if (headings[i].getBoundingClientRect().top <= top) idx = i; else break;
    }
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) idx = headings.length - 1;
    const links = tocList.children;
    for (const a of links) a.classList.remove('active');
    const c = links[idx];
    if (c && c.classList) {
      c.classList.add('active');
      const r = c.getBoundingClientRect(), tr = $('#toc').getBoundingClientRect();
      if (r.top < tr.top + 30 || r.bottom > tr.bottom - 10) c.scrollIntoView({ block: 'center' });
    }
  });
}
function updateProgress() {
  const max = scroller.scrollHeight - scroller.clientHeight;
  $('#progress').style.width = (max > 0 ? (scroller.scrollTop / max) * 100 : 0) + '%';
}
scroller.addEventListener('scroll', () => { spy(); updateProgress(); });

/* ---------- link / copy handling inside the document ---------- */
doc.addEventListener('click', (e) => {
  const copy = e.target.closest('.copy-btn');
  if (copy) {
    const code = copy.closest('.code-block').querySelector('code');
    navigator.clipboard.writeText(code.textContent).then(() => {
      copy.textContent = 'Copied ✓';
      setTimeout(() => (copy.textContent = 'Copy'), 1400);
    });
    return;
  }
  const a = e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (href.startsWith('#')) {
    e.preventDefault();
    const el = document.getElementById(decodeURIComponent(href.slice(1)));
    if (el) el.scrollIntoView();
  } else if (!/^(https?:|mailto:)/i.test(href) && /\.(md|markdown)(#.*)?$/i.test(href) && cur() && cur().path) {
    e.preventDefault();
    try {
      const u = new URL(href, fileBase(cur().path));
      window.api.openPath(decodeURIComponent(u.pathname).replace(/^\//, ''));
    } catch {}
  }
});

/* ---------- find ---------- */
const bar = $('#find-bar'), input = $('#find-input'), countEl = $('#find-count');
let matches = [], curMatch = -1, matchCase = false;

function clearFind() {
  doc.querySelectorAll('mark.find').forEach((m) => {
    const p = m.parentNode;
    p.replaceChild(document.createTextNode(m.textContent), m);
    p.normalize();
  });
  matches = []; curMatch = -1;
  countEl.textContent = '0/0';
}
function runFind() {
  clearFind();
  const q = input.value;
  if (!q) return;
  const needle = matchCase ? q : q.toLowerCase();
  const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue.trim() && !n.parentElement.closest('.copy-btn, .code-head, .h-tools, .table-tools, .task-badge') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const hay = matchCase ? node.nodeValue : node.nodeValue.toLowerCase();
    let pos = hay.indexOf(needle);
    if (pos < 0) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    while (pos >= 0) {
      frag.appendChild(document.createTextNode(node.nodeValue.slice(last, pos)));
      const m = document.createElement('mark');
      m.className = 'find';
      m.textContent = node.nodeValue.slice(pos, pos + q.length);
      frag.appendChild(m);
      matches.push(m);
      last = pos + q.length;
      pos = hay.indexOf(needle, last);
    }
    frag.appendChild(document.createTextNode(node.nodeValue.slice(last)));
    node.replaceWith(frag);
  }
  if (matches.length) go(0);
}
function go(i) {
  if (!matches.length) return;
  if (curMatch >= 0) matches[curMatch].classList.remove('cur');
  curMatch = (i + matches.length) % matches.length;
  const m = matches[curMatch];
  m.classList.add('cur');
  m.scrollIntoView({ block: 'center' });
  countEl.textContent = `${curMatch + 1}/${matches.length}`;
}
function openFind() {
  bar.hidden = false;
  $('#btn-find').classList.add('on');
  const sel = getSelection().toString();
  if (sel && !sel.includes('\n') && sel.length < 80) input.value = sel;
  input.focus(); input.select();
  if (input.value) runFind();
}
function closeFind() {
  bar.hidden = true;
  $('#btn-find').classList.remove('on');
  clearFind();
}
input.addEventListener('input', runFind);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); go(curMatch + (e.shiftKey ? -1 : 1)); }
  else if (e.key === 'Escape') closeFind();
});
$('#find-next').onclick = () => go(curMatch + 1);
$('#find-prev').onclick = () => go(curMatch - 1);
$('#find-close').onclick = closeFind;
$('#find-case').onclick = (e) => { matchCase = !matchCase; e.currentTarget.classList.toggle('on', matchCase); runFind(); };
$('#btn-find').onclick = () => (bar.hidden ? openFind() : closeFind());

/* ---------- editor ---------- */
function setEditing(on) {
  if (on && !cur()) { newTab(); return; }
  editing = on;
  if (editing) editor.value = cur().text;
  updateChrome();
  if (editing) editor.focus();
}

let previewTimer;
editor.addEventListener('input', () => {
  const t = cur();
  if (!t) return;
  t.text = editor.value;
  t.dirty = true;
  updateChrome();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => showPreview(true), 180);
});

// keep the preview roughly in step with the editor
editor.addEventListener('scroll', () => {
  const max = editor.scrollHeight - editor.clientHeight;
  if (max <= 0) return;
  scroller.style.scrollBehavior = 'auto';
  scroller.scrollTop = (editor.scrollTop / max) * (scroller.scrollHeight - scroller.clientHeight);
  scroller.style.scrollBehavior = '';
});

function edit(fn) {
  const s = editor.selectionStart, e = editor.selectionEnd, v = editor.value;
  const r = fn({ s, e, v, sel: v.slice(s, e) });
  editor.focus();
  editor.setRangeText(r.text, r.from ?? s, r.to ?? e, 'end');
  if (r.select) editor.setSelectionRange(r.select[0], r.select[1]);
  editor.dispatchEvent(new Event('input'));
}
const wrap = (b, a, ph) => edit(({ s, sel }) => {
  const inner = sel || ph;
  return { text: b + inner + a, select: [s + b.length, s + b.length + inner.length] };
});
const linePrefix = (prefix) => edit(({ s, e, v }) => {
  const start = v.lastIndexOf('\n', s - 1) + 1;
  let end = v.indexOf('\n', e); if (end < 0) end = v.length;
  const block = v.slice(start, end).split('\n');
  const out = block.map((l, i) => (typeof prefix === 'function' ? prefix(i) : prefix) + l.replace(/^(#{1,6}\s|[-*+]\s\[[ x]\]\s|[-*+]\s|\d+\.\s|>\s)/, '')).join('\n');
  return { text: out, from: start, to: end };
});
const FORMATS = {
  bold: () => wrap('**', '**', 'bold text'),
  italic: () => wrap('*', '*', 'italic text'),
  strike: () => wrap('~~', '~~', 'text'),
  code: () => wrap('`', '`', 'code'),
  h1: () => linePrefix('# '), h2: () => linePrefix('## '), h3: () => linePrefix('### '),
  ul: () => linePrefix('- '), ol: () => linePrefix((i) => `${i + 1}. `), task: () => linePrefix('- [ ] '), quote: () => linePrefix('> '),
  codeblock: () => edit(({ s, sel }) => ({ text: '\n```\n' + (sel || 'code') + '\n```\n', select: [s + 5, s + 5 + (sel || 'code').length] })),
  link: () => edit(({ s, sel }) => {
    const t = sel || 'link text';
    return { text: `[${t}](https://)`, select: [s + t.length + 3, s + t.length + 11] };
  }),
  table: () => edit(() => ({ text: '\n| Column 1 | Column 2 | Column 3 |\n|----------|----------|----------|\n| Cell     | Cell     | Cell     |\n' })),
  hr: () => edit(() => ({ text: '\n---\n' })),
};
$('#editbar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-fmt]');
  if (b) FORMATS[b.dataset.fmt]();
});
editor.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); FORMATS.bold(); }
  else if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); FORMATS.italic(); }
  else if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); FORMATS.link(); }
  else if (e.key === 'Tab') {
    e.preventDefault();
    if (e.shiftKey) {
      edit(({ s, e: en, v }) => {
        const start = v.lastIndexOf('\n', s - 1) + 1;
        const seg = v.slice(start, en).replace(/^( {1,2}|\t)/gm, '');
        return { text: seg, from: start, to: en };
      });
    } else edit(() => ({ text: '  ' }));
  } else if (e.key === 'Enter') {
    // continue lists
    const v = editor.value, s = editor.selectionStart;
    const ls = v.lastIndexOf('\n', s - 1) + 1;
    const line = v.slice(ls, s);
    const m = line.match(/^(\s*)([-*+]|\d+\.)(\s+\[[ x]\])?\s+(.*)$/);
    if (m && editor.selectionStart === editor.selectionEnd) {
      e.preventDefault();
      if (!m[4].trim()) { edit(() => ({ text: '', from: ls, to: s })); return; }
      const marker = /\d/.test(m[2]) ? `${parseInt(m[2], 10) + 1}.` : m[2];
      edit(() => ({ text: '\n' + m[1] + marker + (m[3] ? ' [ ]' : '') + ' ' }));
    }
  }
});

async function save(saveAs) {
  const t = cur();
  if (!t) return;
  const r = await window.api.save({ path: saveAs ? null : t.path, text: t.text, name: t.name });
  if (!r) return;
  t.path = r.path; t.name = r.name; t.dirty = false;
  lsSet('base:' + t.path, t.text); // your own edits aren't "changes"
  updateChrome();
}

/* ---------- export ---------- */
async function doExport(kind) {
  const t = cur();
  if (!t) return;
  if (kind === 'pdf') await window.api.exportPdf(t.name);
  else await window.api.exportHtml({ name: t.name, title: t.name, html: build(t.text, t.path).innerHTML });
}

/* ---------- toolbar / ui ---------- */
const toggleToc = () => $('#toc').classList.toggle('hidden');
const toggleSource = () => { sourceMode = !sourceMode; showPreview(true); updateChrome(); };
$('#btn-toc').onclick = toggleToc;
$('#btn-theme').onclick = toggleTheme;
$('#btn-open').onclick = () => window.api.openDialog();
$('#btn-source').onclick = toggleSource;
$('#btn-edit').onclick = () => setEditing(!editing);
$('#btn-save').onclick = () => save(false);

window.api.onFind(openFind);
window.api.onToggleToc(toggleToc);
window.api.onToggleTheme(toggleTheme);
window.api.onToggleSource(toggleSource);
window.api.onToggleWide(toggleWide);
window.api.onToggleEdit(() => setEditing(!editing));
window.api.onNew(newTab);
window.api.onSave(save);
window.api.onCloseTab(() => closeTab(active));
window.api.onNextTab(stepTab);
window.api.onExport(doExport);

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); }
  else if (e.key === 'F3') { e.preventDefault(); go(curMatch + (e.shiftKey ? -1 : 1)); }
  else if (e.key === 'Escape' && !bar.hidden) closeFind();
});

/* ---------- drag & drop ---------- */
const drop = $('#drop');
let dragDepth = 0;
addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; drop.hidden = false; });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; drop.hidden = true; } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; drop.hidden = true;
  [...e.dataTransfer.files].forEach((f) => window.api.openPath(window.api.pathFor(f)));
});

/* =====================================================================
   Signature features: table tools, section copy / Ask Claude,
   "what changed" bar, read aloud, focus mode
   ===================================================================== */

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}
const copyText = (s) => navigator.clipboard.writeText(s);

/* ---------- table tools ---------- */
function decorateTables(root) {
  root.querySelectorAll('table').forEach((t) => {
    const block = document.createElement('div');
    block.className = 'table-block';
    const tools = document.createElement('div');
    tools.className = 'table-tools';
    tools.innerHTML = '<input class="tt-filter" placeholder="Filter rows…" spellcheck="false"><span class="tt-count"></span><span class="spacer"></span>' +
      '<button data-act="copy" title="Copy for Excel / Sheets">Copy</button><button data-act="csv" title="Save as CSV">CSV</button>' +
      '<button data-act="chart" title="Chart this table">Chart</button><button data-act="ask" title="Ask an AI chat about this table">✦ Ask</button>';
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    const chart = document.createElement('div');
    chart.className = 'table-chart';
    t.replaceWith(block);
    wrap.appendChild(t);
    block.append(tools, wrap, chart);
    [...(t.tBodies[0] ? t.tBodies[0].rows : [])].forEach((r, i) => (r.dataset.o = i));
  });
}

const cellNum = (s) => {
  const c = s.replace(/[,$€£%\s]/g, '');
  return c !== '' && !isNaN(Number(c)) ? Number(c) : null;
};

function sortTable(th) {
  const table = th.closest('table');
  const body = table.tBodies[0];
  if (!body) return;
  const idx = th.cellIndex;
  const dir = th.dataset.dir === 'asc' ? 'desc' : th.dataset.dir === 'desc' ? '' : 'asc';
  table.querySelectorAll('th').forEach((h) => delete h.dataset.dir);
  if (dir) th.dataset.dir = dir;
  const rows = [...body.rows];
  rows.sort((a, b) => {
    if (!dir) return a.dataset.o - b.dataset.o;
    const x = (a.cells[idx] || {}).textContent || '', y = (b.cells[idx] || {}).textContent || '';
    const nx = cellNum(x), ny = cellNum(y);
    const c = nx !== null && ny !== null ? nx - ny : x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' });
    return dir === 'asc' ? c : -c;
  });
  rows.forEach((r) => body.appendChild(r));
}

function tableData(table) {
  const out = [];
  const head = table.tHead ? [...table.tHead.rows] : [];
  head.forEach((r) => out.push([...r.cells].map((c) => c.textContent.trim())));
  [...(table.tBodies[0] ? table.tBodies[0].rows : [])]
    .filter((r) => r.style.display !== 'none')
    .forEach((r) => out.push([...r.cells].map((c) => c.textContent.trim())));
  return out;
}
const toTSV = (d) => d.map((r) => r.map((c) => c.replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
const toCSV = (d) => d.map((r) => r.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n');
const toMdTable = (d) => {
  if (!d.length) return '';
  const row = (r) => '| ' + r.map((c) => c.replace(/\|/g, '\\|')).join(' | ') + ' |';
  return [row(d[0]), '|' + d[0].map(() => ' --- ').join('|') + '|', ...d.slice(1).map(row)].join('\n');
};

function drawChart(table, host) {
  if (host.dataset.on === '1') { host.textContent = ''; host.dataset.on = ''; return; }
  const d = tableData(table);
  const head = d[0] || [], rows = d.slice(1, 31);
  const numeric = head.map((_, c) => rows.length && rows.every((r) => (r[c] || '') === '' || cellNum(r[c]) !== null) && rows.some((r) => cellNum(r[c] || '') !== null));
  const labelCol = numeric.findIndex((n) => !n) >= 0 ? numeric.findIndex((n) => !n) : 0;
  const series = head.map((_, c) => c).filter((c) => numeric[c] && c !== labelCol).slice(0, 4);
  if (!series.length) { toast('No numeric columns to chart'); return; }
  const colors = ['#c96442', '#4078f2', '#50a14f', '#a626a4'];
  const max = Math.max(1e-9, ...rows.flatMap((r) => series.map((c) => cellNum(r[c] || '') || 0)));
  const barH = 14, gap = 4, rowGap = 12, lx = 170, W = 640, bw = W - lx - 70;
  const rowH = series.length * (barH + gap) + rowGap;
  const H = rows.length * rowH + 30 + (series.length > 1 ? 24 : 0);
  const NS = 'http://www.w3.org/2000/svg';
  const el = (n, a, txt) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); if (txt != null) e.textContent = txt; return e; };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg' });
  let y = 8;
  if (series.length > 1) {
    series.forEach((c, i) => {
      svg.appendChild(el('rect', { x: lx + i * 130, y: 4, width: 10, height: 10, rx: 2, fill: colors[i] }));
      svg.appendChild(el('text', { x: lx + i * 130 + 15, y: 13, class: 'ct' }, head[c]));
    });
    y = 30;
  }
  rows.forEach((r) => {
    const lab = (r[labelCol] || '').slice(0, 24);
    svg.appendChild(el('text', { x: lx - 8, y: y + (series.length * (barH + gap)) / 2 + 4, 'text-anchor': 'end', class: 'ct' }, lab));
    series.forEach((c, i) => {
      const v = cellNum(r[c] || '') || 0;
      const w = Math.max(0, (v / max) * bw);
      svg.appendChild(el('rect', { x: lx, y: y + i * (barH + gap), width: w, height: barH, rx: 3, fill: colors[i] }));
      svg.appendChild(el('text', { x: lx + w + 6, y: y + i * (barH + gap) + 11, class: 'ct dim' }, r[c] || ''));
    });
    y += rowH;
  });
  host.textContent = '';
  host.appendChild(svg);
  host.dataset.on = '1';
}

doc.addEventListener('click', (e) => {
  const th = e.target.closest('.table-block th');
  if (th) { sortTable(th); return; }
  const tb = e.target.closest('.table-tools button');
  if (!tb) return;
  const block = tb.closest('.table-block');
  const table = block.querySelector('table');
  const act = tb.dataset.act;
  const base = ((cur() && cur().name) || 'table').replace(/\.\w+$/, '');
  if (act === 'copy') copyText(toTSV(tableData(table))).then(() => toast('Table copied. Paste into Excel or Sheets.'));
  else if (act === 'csv') window.api.exportText({ name: base + '-table.csv', ext: 'csv', text: toCSV(tableData(table)) });
  else if (act === 'chart') drawChart(table, block.querySelector('.table-chart'));
  else if (act === 'ask') openAsk({ label: 'table', md: toMdTable(tableData(table)) });
});
doc.addEventListener('input', (e) => {
  if (!e.target.classList.contains('tt-filter')) return;
  const block = e.target.closest('.table-block');
  const q = e.target.value.toLowerCase();
  const rows = [...block.querySelectorAll('tbody tr')];
  let shown = 0;
  rows.forEach((r) => { const ok = !q || r.textContent.toLowerCase().includes(q); r.style.display = ok ? '' : 'none'; if (ok) shown++; });
  block.querySelector('.tt-count').textContent = q ? `${shown} of ${rows.length}` : '';
});

/* ---------- headings: copy section / ask Claude ---------- */
function hText(h) {
  const c = h.cloneNode(true);
  c.querySelectorAll('.h-tools, .task-badge').forEach((x) => x.remove());
  return c.textContent.trim();
}
function decorateHeadings(root) {
  root.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
    const tools = document.createElement('span');
    tools.className = 'h-tools';
    tools.innerHTML = '<button data-act="copy" title="Copy this section for any AI chat">⧉ Copy</button><button data-act="ask" title="Ask an AI chat about this section">✦ Ask</button>';
    h.appendChild(tools);
  });
}

function getSections(text) {
  const lines = parseFrontmatter(text).body.split(/\r?\n/);
  const secs = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const f = l.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; continue; }
    if (fence) continue;
    const m = l.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) { secs.push({ level: m[1].length, title: m[2], line: i }); continue; }
    if (l.trim() && i + 1 < lines.length && /^\s{0,3}(=+|-+)\s*$/.test(lines[i + 1]) && !/^\s*([-*+]|\d+\.)\s/.test(l) && (i === 0 || !lines[i - 1].trim())) {
      secs.push({ level: lines[i + 1].trim()[0] === '=' ? 1 : 2, title: l.trim(), line: i });
      i++;
    }
  }
  const stack = [];
  secs.forEach((s, k) => {
    s.end = lines.length;
    for (let j = k + 1; j < secs.length; j++) if (secs[j].level <= s.level) { s.end = secs[j].line; break; }
    while (stack.length && stack[stack.length - 1].level >= s.level) stack.pop();
    stack.push(s);
    s.path = stack.map((x) => x.title).join(' › ');
    s.md = lines.slice(s.line, s.end).join('\n').trimEnd();
  });
  return secs;
}

function sectionOf(h) {
  const hs = [...doc.querySelectorAll('h1,h2,h3,h4,h5,h6')];
  const secs = getSections(cur().text);
  const i = hs.indexOf(h);
  if (secs.length === hs.length && secs[i]) return secs[i];
  return { path: hText(h), md: '#'.repeat(+h.tagName[1]) + ' ' + hText(h) };
}

doc.addEventListener('click', (e) => {
  const b = e.target.closest('.h-tools button');
  if (!b) return;
  e.preventDefault();
  const sec = sectionOf(b.closest('h1,h2,h3,h4,h5,h6'));
  if (b.dataset.act === 'copy') {
    copyText(`From "${cur().name}" › ${sec.path}\n\n${sec.md}`).then(() => toast('Section copied. Ready to paste into any AI chat.'));
  } else openAsk({ label: `section "${sec.path}"`, md: sec.md });
});

/* ---------- AI chat picker (works with any chat) ---------- */
const CHATS = [['claude', 'Claude'], ['chatgpt', 'ChatGPT'], ['gemini', 'Gemini'], ['copilot', 'Copilot'], ['perplexity', 'Perplexity']];
let chatId = lsGet('chat') || 'claude';
if (!CHATS.some(([id]) => id === chatId)) chatId = 'claude';
const chatName = () => (CHATS.find(([id]) => id === chatId) || CHATS[0])[1];
function updateChatUI() {
  document.querySelectorAll('.chat-sel').forEach((sel) => {
    if (!sel.options.length) CHATS.forEach(([id, name]) => sel.add(new Option(name, id)));
    sel.value = chatId;
  });
  $('#ask-go').textContent = `Copy & open ${chatName()}`;
  $('#np-go').textContent = `Copy & open ${chatName()}`;
}
document.querySelectorAll('.chat-sel').forEach((sel) => sel.addEventListener('change', () => { chatId = sel.value; lsSet('chat', chatId); updateChatUI(); }));
updateChatUI();
function openChatWithToast() {
  window.api.openChat(chatId);
  toast(`Copied. Paste into ${chatName()} with Ctrl+V.`);
}

/* ---------- Ask AI ---------- */
let askCtx = null;
function openAsk({ label, md }) {
  askCtx = { label, md };
  $('#ask-q').value = '';
  $('#ask-ctx-label').textContent = `Included: ${label} from ${(cur() && cur().name) || 'document'} · ${md.length.toLocaleString()} characters`;
  $('#ask-ctx').textContent = md.length > 700 ? md.slice(0, 700) + '\n…' : md;
  $('#ask').hidden = false;
  $('#ask-q').focus();
}
function askPrompt() {
  const q = $('#ask-q').value.trim() || 'Please help me understand this.';
  return `${q}\n\n---\nFrom "${(cur() && cur().name) || 'document'}" (${askCtx.label}):\n\n${askCtx.md}`;
}
$('#ask-x').onclick = () => ($('#ask').hidden = true);
$('#ask').addEventListener('click', (e) => { if (e.target.id === 'ask') $('#ask').hidden = true; });
document.querySelectorAll('.chip').forEach((c) => (c.onclick = () => { $('#ask-q').value = c.dataset.q; $('#ask-q').focus(); }));
$('#ask-copy').onclick = () => copyText(askPrompt()).then(() => { $('#ask').hidden = true; toast('Copied to clipboard'); });
$('#ask-go').onclick = () => copyText(askPrompt()).then(() => {
  $('#ask').hidden = true;
  openChatWithToast();
});
$('#ask-q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#ask-go').click(); else if (e.key === 'Escape') $('#ask').hidden = true; });

$('#btn-ask').onclick = () => {
  if (!cur()) return;
  const sel = getSelection().toString().trim();
  if (sel) openAsk({ label: 'selection', md: sel });
  else openAsk({ label: 'whole document', md: cur().text });
};

// floating chip when text is selected
const chip = $('#sel-chip');
doc.addEventListener('mouseup', () => {
  setTimeout(() => {
    const s = getSelection();
    const txt = s.toString().trim();
    if (txt.length < 4 || !doc.contains(s.anchorNode)) { hideChips(); return; }
    const r = s.getRangeAt(0).getBoundingClientRect();
    const left = Math.min(innerWidth - 250, Math.max(8, r.left + r.width / 2 - 100));
    const top = Math.max(80, r.top - 38) + 'px';
    chip.style.left = left + 'px'; chip.style.top = top;
    selNote.style.left = left + 112 + 'px'; selNote.style.top = top;
    chip.hidden = false; selNote.hidden = false;
  }, 0);
});
const selNote = $('#sel-note');
function hideChips() { chip.hidden = true; selNote.hidden = true; }
chip.addEventListener('mousedown', (e) => e.preventDefault());
selNote.addEventListener('mousedown', (e) => e.preventDefault());
chip.onclick = () => { const t = getSelection().toString().trim(); hideChips(); if (t) openAsk({ label: 'selection', md: t }); };
scroller.addEventListener('scroll', hideChips);
document.addEventListener('mousedown', (e) => { if (e.target !== chip && e.target !== selNote) hideChips(); });

/* ---------- "what changed" bar ---------- */
$('#cb-toggle').onclick = () => { const t = cur(); if (!t) return; t.showChanges = !t.showChanges; showPreview(true); updateChrome(); };
$('#cb-dismiss').onclick = () => { const t = cur(); if (!t) return; t.base = null; t.diff = null; t.showChanges = false; showPreview(true); updateChrome(); };

/* ---------- read aloud ---------- */
let reading = false;
function stopReading() {
  speechSynthesis.cancel();
  reading = false;
  doc.querySelectorAll('.reading').forEach((x) => x.classList.remove('reading'));
  $('#btn-read').classList.remove('on');
}
function startReading() {
  const blocks = [...doc.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote > p,td,.callout > p')]
    .filter((el) => !el.closest('.table-tools, .code-block, .frontmatter'));
  const sel = getSelection();
  let start = 0;
  if (sel.rangeCount && sel.toString().trim()) { const i = blocks.findIndex((b) => b.contains(sel.anchorNode)); if (i >= 0) start = i; }
  else { const top = scroller.getBoundingClientRect().top; start = Math.max(0, blocks.findIndex((b) => b.getBoundingClientRect().top >= top)); }
  const queue = blocks.slice(start);
  if (!queue.length) return;
  reading = true;
  $('#btn-read').classList.add('on');
  const next = (i) => {
    if (!reading || i >= queue.length) { stopReading(); return; }
    const el = queue[i];
    doc.querySelectorAll('.reading').forEach((x) => x.classList.remove('reading'));
    el.classList.add('reading');
    el.scrollIntoView({ block: 'center' });
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.h-tools, .task-badge').forEach((x) => x.remove());
    const u = new SpeechSynthesisUtterance(clone.textContent.trim());
    u.onend = () => next(i + 1);
    u.onerror = () => { if (reading) next(i + 1); };
    speechSynthesis.speak(u);
  };
  next(0);
}
$('#btn-read').onclick = () => (reading ? stopReading() : startReading());
addEventListener('keydown', (e) => { if (e.key === 'Escape' && reading) stopReading(); });

/* ---------- live task lists ---------- */
const TASK_RE = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[([ xX])\]/;
function scanFences(lines, fn) {
  let fence = null;
  for (let k = 0; k < lines.length; k++) {
    const f = lines[k].match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; continue; }
    if (!fence && fn(lines[k], k) === false) break;
  }
}
function parseTasks(text) {
  const out = [];
  scanFences(parseFrontmatter(text).body.split('\n'), (l) => { const m = l.match(TASK_RE); if (m) out.push(m[1] !== ' '); });
  return out;
}
function decorateTasks(root, readonly) {
  const counts = new Map();
  let curH = null, i = 0;
  root.querySelectorAll('h1,h2,h3,h4,h5,h6,input[type="checkbox"]').forEach((el) => {
    if (el.tagName === 'INPUT') {
      el.dataset.i = i++;
      el.disabled = !!readonly;
      if (curH) { const c = counts.get(curH) || [0, 0]; c[1]++; if (el.checked) c[0]++; counts.set(curH, c); }
    } else curH = el;
  });
  counts.forEach(([d, n], h) => {
    const b = document.createElement('span');
    b.className = 'task-badge' + (d === n ? ' done' : '');
    b.textContent = `${d}/${n}`;
    h.appendChild(b);
  });
}
doc.addEventListener('change', (e) => {
  const cb = e.target;
  if (!(cb instanceof HTMLInputElement) || cb.type !== 'checkbox' || cb.dataset.i === undefined) return;
  const t = cur();
  if (!t) return;
  const lines = t.text.split('\n');
  let n = -1;
  scanFences(lines, (l, k) => {
    if (TASK_RE.test(l) && ++n === +cb.dataset.i) { lines[k] = l.replace(/\[[ xX]\]/, cb.checked ? '[x]' : '[ ]'); return false; }
  });
  t.text = lines.join('\n');
  editor.value = t.text;
  if (t.path) {
    window.api.save({ path: t.path, text: t.text, name: t.name }).then(() => lsSet('base:' + t.path, t.text));
  } else t.dirty = true;
  showPreview(true);
  updateChrome();
});

/* ---------- review comments ---------- */
let notes = [], pendingNote = null;
const notesKey = (t) => (t && t.path ? 'notes:' + t.path : null);
function loadNotes() {
  const t = cur();
  notes = [];
  const k = notesKey(t);
  if (k) { try { notes = JSON.parse(lsGet(k) || '[]'); } catch {} } else if (t) notes = t.notes || (t.notes = []);
  renderNotesPanel();
}
function saveNotes() {
  const t = cur();
  const k = notesKey(t);
  if (k) lsSet(k, JSON.stringify(notes)); else if (t) t.notes = notes;
  renderNotesPanel();
}
function applyNotes() {
  if (sourceMode || !cur()) return;
  notes.forEach((n) => {
    const w = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT, {
      acceptNode: (x) => (x.parentElement.closest('.h-tools,.table-tools,.copy-btn,.code-head,mark.note,.task-badge') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    while (w.nextNode()) {
      const node = w.currentNode;
      const p = node.nodeValue.indexOf(n.quote);
      if (p < 0) continue;
      const mid = node.splitText(p);
      mid.splitText(n.quote.length);
      const m = document.createElement('mark');
      m.className = 'note';
      m.dataset.id = n.id;
      m.title = n.comment;
      mid.replaceWith(m);
      m.appendChild(mid);
      break;
    }
  });
}
function renderNotesPanel() {
  $('#btn-notes').textContent = notes.length ? `💬 Review (${notes.length})` : '💬 Review';
  const list = $('#np-list');
  list.textContent = '';
  if (!notes.length) {
    const d = document.createElement('div');
    d.className = 'np-empty';
    d.textContent = 'Select any text in the document and click “💬 Comment”. When you are done, copy all comments as one revision request for any AI chat.';
    list.appendChild(d);
    return;
  }
  notes.forEach((n) => {
    const it = document.createElement('div');
    it.className = 'np-item';
    const del = document.createElement('button');
    del.className = 'np-del'; del.textContent = '×'; del.title = 'Delete comment';
    del.onclick = (e) => { e.stopPropagation(); notes = notes.filter((x) => x.id !== n.id); saveNotes(); showPreview(true); };
    const sec = document.createElement('div'); sec.className = 'np-sec'; sec.textContent = n.section || 'Document';
    const q = document.createElement('div'); q.className = 'np-quote'; q.textContent = n.quote.length > 140 ? n.quote.slice(0, 140) + '…' : n.quote;
    const c = document.createElement('div'); c.textContent = n.comment;
    it.append(del, sec, q, c);
    it.onclick = () => { const m = doc.querySelector(`mark.note[data-id="${n.id}"]`); if (m) m.scrollIntoView({ block: 'center' }); else toast('Couldn’t locate this passage. It may have changed.'); };
    list.appendChild(it);
  });
}
function feedbackPrompt() {
  const items = notes.map((n, i) => `${i + 1}. Section: ${n.section || 'Document'}\n   Quote: "${n.quote}"\n   Comment: ${n.comment}`).join('\n\n');
  return `I'm reviewing "${(cur() && cur().name) || 'my document'}". Please revise it to address each comment below. For every comment, return the updated text of the affected passage or section, and leave everything I didn't comment on unchanged.\n\n${items}`;
}
function headingBefore(node) {
  let found = null;
  for (const h of doc.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    if (h.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) found = h; else break;
  }
  return found ? hText(found) : '';
}
selNote.onclick = () => {
  const s = getSelection();
  const quote = s.toString().replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!quote || !s.rangeCount) return;
  pendingNote = { quote, section: headingBefore(s.getRangeAt(0).startContainer) };
  hideChips();
  $('#nd-quote').textContent = quote;
  $('#nd-text').value = '';
  $('#note-dlg').hidden = false;
  $('#nd-text').focus();
};
function saveNote() {
  const text = $('#nd-text').value.trim();
  if (!text || !pendingNote) return;
  notes.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), ...pendingNote, comment: text });
  pendingNote = null;
  $('#note-dlg').hidden = true;
  saveNotes();
  $('#notes-panel').hidden = false;
  showPreview(true);
}
$('#nd-save').onclick = saveNote;
$('#nd-x').onclick = () => ($('#note-dlg').hidden = true);
$('#nd-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveNote(); else if (e.key === 'Escape') $('#note-dlg').hidden = true; });
$('#btn-notes').onclick = () => ($('#notes-panel').hidden = !$('#notes-panel').hidden);
$('#np-x').onclick = () => ($('#notes-panel').hidden = true);
$('#np-copy').onclick = () => { if (!notes.length) return toast('No comments yet'); copyText(feedbackPrompt()).then(() => toast('Feedback copied. Paste it into any AI chat.')); };
$('#np-go').onclick = () => { if (!notes.length) return toast('No comments yet'); copyText(feedbackPrompt()).then(openChatWithToast); };
$('#np-clear').onclick = () => { if (notes.length && confirm('Delete all review comments for this document?')) { notes = []; saveNotes(); showPreview(true); } };
doc.addEventListener('click', (e) => {
  const m = e.target.closest('mark.note');
  if (!m) return;
  $('#notes-panel').hidden = false;
});

/* ---------- clipboard: detect Markdown copied from any chat ---------- */
let clipText = null;
function openClipText(text) {
  if (!text || !text.trim()) { toast('The clipboard is empty'); return; }
  const first = (text.match(/^#{1,6}\s+(.+)$/m) || [])[1];
  const safe = first ? first.replace(/[\\/:*?"<>|#`*_]/g, '').trim().slice(0, 40) : '';
  addTab({ path: null, name: (safe || 'Pasted Markdown') + '.md', text, scroll: 0, dirty: true });
}
window.api.onClipDetected(({ text, words }) => {
  clipText = text;
  $('#clip-text').textContent = `Markdown detected on your clipboard (${words.toLocaleString()} words).`;
  $('#clipbar').hidden = false;
});
$('#clip-open').onclick = () => { openClipText(clipText); $('#clipbar').hidden = true; clipText = null; };
$('#clip-dismiss').onclick = () => { $('#clipbar').hidden = true; clipText = null; };
$('#clip-off').onclick = () => { window.api.disableClipDetect(); $('#clipbar').hidden = true; clipText = null; toast('Clipboard detection turned off. Re-enable it under File.'); };
const openFromClipboard = () => window.api.readClipboard().then(openClipText);
window.api.onOpenClip(openFromClipboard);

/* ---------- focus mode ---------- */
$('#btn-focus').onclick = () => {
  const on = document.body.classList.toggle('focus');
  $('#btn-focus').classList.toggle('on', on);
};

showEmpty();
updateChrome();
