const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;
let pendingFile = null;
const watchers = new Map();

const isMd = (p) => /\.(md|markdown|mdown|txt)$/i.test(p || '');
const fileFromArgs = (argv) => argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-') && isMd(a) && fs.existsSync(a));
const readText = (f) => fs.readFileSync(f, 'utf8').replace(/^﻿/, '');

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* ---------- recent files ---------- */
const recentFile = () => path.join(app.getPath('userData'), 'recent.json');
function getRecent() {
  try { return JSON.parse(fs.readFileSync(recentFile(), 'utf8')).filter((f) => fs.existsSync(f)); } catch { return []; }
}
function addRecent(file) {
  const list = [file, ...getRecent().filter((f) => f.toLowerCase() !== file.toLowerCase())].slice(0, 12);
  try { fs.writeFileSync(recentFile(), JSON.stringify(list)); } catch {}
  app.addRecentDocument(file);
  buildMenu();
  send('recent:list', list);
}
function clearRecent() {
  try { fs.writeFileSync(recentFile(), '[]'); } catch {}
  buildMenu();
  send('recent:list', []);
}

/* ---------- opening / watching ---------- */
function watch(file) {
  if (watchers.has(file)) return;
  let t;
  try {
    const w = fs.watch(file, () => {
      clearTimeout(t);
      t = setTimeout(() => { try { send('file:changed', { path: file, text: readText(file) }); } catch {} }, 150);
    });
    watchers.set(file, w);
  } catch {}
}
function unwatch(file) {
  const w = watchers.get(file);
  if (w) { w.close(); watchers.delete(file); }
}

function openFile(file) {
  if (!file) return;
  let text;
  try { text = readText(file); }
  catch (e) { dialog.showErrorBox('Cannot open file', String(e.message)); return; }
  send('file:loaded', { path: file, name: path.basename(file), text });
  watch(file);
  addRecent(file);
}

async function pickFile() {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'txt'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (!r.canceled) r.filePaths.forEach(openFile);
}

/* ---------- saving ---------- */
let dirty = false;
async function saveFile({ path: file, text, name }) {
  let target = file;
  if (!target) {
    const r = await dialog.showSaveDialog(win, { defaultPath: name || 'Untitled.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (r.canceled) return null;
    target = r.filePath;
  }
  try {
    fs.writeFileSync(target, text, 'utf8');
  } catch (e) { dialog.showErrorBox('Cannot save file', String(e.message)); return null; }
  watch(target);
  addRecent(target);
  return { path: target, name: path.basename(target) };
}

/* ---------- export ---------- */
async function exportPdf(suggested) {
  const r = await dialog.showSaveDialog(win, { defaultPath: suggested.replace(/\.\w+$/, '') + '.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (r.canceled) return;
  try {
    const data = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } });
    fs.writeFileSync(r.filePath, data);
    shell.showItemInFolder(r.filePath);
  } catch (e) { dialog.showErrorBox('Export failed', String(e.message)); }
}
async function exportHtml({ name, title, html }) {
  const r = await dialog.showSaveDialog(win, { defaultPath: name.replace(/\.\w+$/, '') + '.html', filters: [{ name: 'HTML', extensions: ['html'] }] });
  if (r.canceled) return;
  const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${css}
body{display:block;overflow:auto;height:auto}.copy-btn,.h-tools,.table-tools{display:none}.md{max-width:780px;margin:0 auto;padding:36px 24px 80px}</style></head><body><article class="md">${html}</article></body></html>`;
  try { fs.writeFileSync(r.filePath, page, 'utf8'); shell.showItemInFolder(r.filePath); }
  catch (e) { dialog.showErrorBox('Export failed', String(e.message)); }
}

/* ---------- window / menu ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 800, minWidth: 600, minHeight: 400,
    backgroundColor: '#faf9f5', title: 'MD Reader',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url); }
  });
  win.webContents.once('did-finish-load', () => {
    send('recent:list', getRecent());
    if (pendingFile) { openFile(pendingFile); pendingFile = null; }
  });
  win.on('close', (e) => {
    if (!dirty) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Cancel', 'Discard changes'], defaultId: 0, cancelId: 0,
      title: 'Unsaved changes', message: 'You have unsaved changes.', detail: 'Close anyway and discard them?',
    });
    if (choice === 0) e.preventDefault();
  });
  win.on('closed', () => { win = null; watchers.forEach((w) => w.close()); watchers.clear(); });
}

function showAbout() {
  const pkg = require('../package.json');
  const author = typeof pkg.author === 'string' ? pkg.author : (pkg.author && pkg.author.name) || '';
  dialog.showMessageBox(win, {
    type: 'info', title: 'About MD Reader', message: `MD Reader ${app.getVersion()}`,
    detail: `A Markdown reader and editor built for AI-generated documents.\n\nCreated by ${author}\n© ${new Date().getFullYear()} ${author}. All rights reserved.`,
    buttons: ['OK'],
  });
}

function buildMenu() {
  const recent = getRecent();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'New', accelerator: 'CmdOrCtrl+N', click: () => send('ui:new') },
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: pickFile },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('ui:save', false) },
      { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('ui:save', true) },
      { label: 'Open Recent', submenu: recent.length
        ? [...recent.map((f) => ({ label: f, click: () => openFile(f) })), { type: 'separator' }, { label: 'Clear Recent', click: clearRecent }]
        : [{ label: 'No recent files', enabled: false }] },
      { type: 'separator' },
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('ui:close-tab') },
      { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => send('ui:next-tab', 1) },
      { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => send('ui:next-tab', -1) },
      { type: 'separator' },
      { label: 'Export as PDF…', click: () => send('ui:export', 'pdf') },
      { label: 'Export as HTML…', click: () => send('ui:export', 'html') },
      { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => win && win.webContents.print() },
      { type: 'separator' },
      { role: 'quit' },
    ] },
    { label: 'Help', submenu: [{ label: 'About MD Reader', click: showAbout }] },
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'selectAll' }, { type: 'separator' },
      { label: 'Find', accelerator: 'CmdOrCtrl+F', click: () => send('ui:find') }] },
    { label: 'View', submenu: [
      { label: 'Edit Mode (editor + live preview)', accelerator: 'CmdOrCtrl+E', click: () => send('ui:toggle-edit') },
      { label: 'Toggle Contents', accelerator: 'CmdOrCtrl+\\', click: () => send('ui:toggle-toc') },
      { label: 'Toggle Source View', accelerator: 'CmdOrCtrl+/', click: () => send('ui:toggle-source') },
      { label: 'Toggle Dark Mode', accelerator: 'CmdOrCtrl+D', click: () => send('ui:toggle-theme') },
      { label: 'Toggle Wide Layout', accelerator: 'CmdOrCtrl+Shift+W', click: () => send('ui:toggle-wide') },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { role: 'toggleDevTools' },
    ] },
  ]));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    openFile(fileFromArgs(argv));
  });
  app.on('open-file', (e, p) => { e.preventDefault(); if (win) openFile(p); else pendingFile = p; });
  app.whenReady().then(() => {
    pendingFile = fileFromArgs(process.argv);
    buildMenu();
    createWindow();
    ipcMain.handle('dialog:open', pickFile);
    ipcMain.handle('file:open-path', (_e, p) => { if (isMd(p) && fs.existsSync(p)) openFile(p); });
    ipcMain.handle('file:unwatch', (_e, p) => unwatch(p));
    ipcMain.handle('recent:get', getRecent);
    ipcMain.handle('file:save', (_e, payload) => saveFile(payload));
    ipcMain.on('app:dirty', (_e, d) => { dirty = !!d; });
    ipcMain.handle('export:text', async (_e, { name, ext, text }) => {
      const r = await dialog.showSaveDialog(win, { defaultPath: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
      if (r.canceled) return false;
      try { fs.writeFileSync(r.filePath, '﻿' + text, 'utf8'); shell.showItemInFolder(r.filePath); return true; }
      catch (e) { dialog.showErrorBox('Export failed', String(e.message)); return false; }
    });
    ipcMain.handle('open:claude', () => shell.openExternal('https://claude.ai/new'));
    ipcMain.handle('export:pdf', (_e, name) => exportPdf(name));
    ipcMain.handle('export:html', (_e, payload) => exportHtml(payload));
  });
  app.on('window-all-closed', () => app.quit());
}
