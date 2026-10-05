const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { Marked } = require('marked');
const { markedHighlight } = require('marked-highlight');
const markedKatex = require('marked-katex-extension');
const hljs = require('highlight.js');

const marked = new Marked(
  markedHighlight({
    emptyLangClass: 'hljs',
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : null;
      return language ? hljs.highlight(code, { language }).value : hljs.highlightAuto(code).value;
    },
  }),
  { gfm: true, breaks: false }
);
marked.use(markedKatex({ throwOnError: false }));

// split markdown into top-level blocks (raw source + rendered html) for diffing
function blocks(md) {
  try {
    const tokens = marked.lexer(md);
    marked.walkTokens(tokens, marked.defaults.walkTokens || (() => {}));
    return tokens
      .filter((t) => t.type !== 'space')
      .map((t) => ({ raw: t.raw.trim(), html: marked.parser([t]) }));
  } catch {
    return [{ raw: md.trim(), html: marked.parse(md) }];
  }
}

const on = (ch, cb) => ipcRenderer.on(ch, (_e, p) => cb(p));

contextBridge.exposeInMainWorld('api', {
  render: (md) => marked.parse(md),
  blocks,
  exportText: (payload) => ipcRenderer.invoke('export:text', payload),
  openClaude: () => ipcRenderer.invoke('open:claude'),
  openDialog: () => ipcRenderer.invoke('dialog:open'),
  openPath: (p) => ipcRenderer.invoke('file:open-path', p),
  unwatch: (p) => ipcRenderer.invoke('file:unwatch', p),
  save: (payload) => ipcRenderer.invoke('file:save', payload),
  setDirty: (d) => ipcRenderer.send('app:dirty', d),
  onNew: (cb) => on('ui:new', cb),
  onSave: (cb) => on('ui:save', cb),
  onToggleEdit: (cb) => on('ui:toggle-edit', cb),
  getRecent: () => ipcRenderer.invoke('recent:get'),
  exportPdf: (name) => ipcRenderer.invoke('export:pdf', name),
  exportHtml: (payload) => ipcRenderer.invoke('export:html', payload),
  pathFor: (file) => webUtils.getPathForFile(file),
  onLoaded: (cb) => on('file:loaded', cb),
  onChanged: (cb) => on('file:changed', cb),
  onRecent: (cb) => on('recent:list', cb),
  onFind: (cb) => on('ui:find', cb),
  onToggleToc: (cb) => on('ui:toggle-toc', cb),
  onToggleTheme: (cb) => on('ui:toggle-theme', cb),
  onToggleSource: (cb) => on('ui:toggle-source', cb),
  onToggleWide: (cb) => on('ui:toggle-wide', cb),
  onCloseTab: (cb) => on('ui:close-tab', cb),
  onNextTab: (cb) => on('ui:next-tab', cb),
  onExport: (cb) => on('ui:export', cb),
});
