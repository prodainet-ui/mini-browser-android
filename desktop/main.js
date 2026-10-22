'use strict';

const {
  app, BaseWindow, WebContentsView, ipcMain, Menu, shell, clipboard,
  session, nativeTheme, screen, dialog, net,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const APP_NAME = 'Мой браузер';
const START_URL = pathToFileURL(path.join(__dirname, 'ui', 'start.html')).href;
const HOME = START_URL;
const isStartUrl = u => typeof u === 'string' && u.split(/[?#]/)[0] === START_URL;
const SEARCH = 'https://www.google.com/search?q=';
const CHROME_HEIGHT = 112;   // полоса вкладок 38 + адресная строка 44 + закладки 30
const FIND_HEIGHT = 40;
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

// Убираем «Electron» из User-Agent — некоторые сайты иначе считают браузер устаревшим.
app.userAgentFallback = app.userAgentFallback
  .replace(/\sElectron\/\S+/i, '')
  .replace(/\sminibrowser\/\S+/i, '');

// ───────────────────────────── Хранение данных ─────────────────────────────

const dataPath = name => path.join(app.getPath('userData'), name);

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(dataPath(name), 'utf8')); } catch { return fallback; }
}

function writeJson(name, value) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(dataPath(name), JSON.stringify(value, null, 2));
  } catch { /* не мешаем работе, если запись не удалась */ }
}

const pendingWrites = new Map();
function saveLater(name, value, delay = 1500) {
  clearTimeout(pendingWrites.get(name)?.timer);
  const timer = setTimeout(() => { pendingWrites.delete(name); writeJson(name, value); }, delay);
  pendingWrites.set(name, { timer, value });
}
function flushWrites() {
  for (const [name, { timer, value }] of pendingWrites) { clearTimeout(timer); writeJson(name, value); }
  pendingWrites.clear();
}

// ───────────────────────────── Состояние ─────────────────────────────

let win = null;
let chrome = null;          // панель браузера (вкладки, адресная строка, закладки)
const tabs = [];
let activeId = null;
let nextId = 1;
let findOpen = false;
let fullscreen = false;
let bookmarks = [];
let settings = { theme: 'system' };
let history = [];
const closedTabs = [];
const downloads = [];

const activeTab = () => tabs.find(t => t.id === activeId) || null;
const canGoBack = wc => !!wc && !wc.isDestroyed() && wc.navigationHistory.canGoBack();
const canGoForward = wc => !!wc && !wc.isDestroyed() && wc.navigationHistory.canGoForward();
const escMenu = s => String(s).replace(/&/g, '&&');
const shorten = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

function chromeSend(channel, ...args) {
  if (chrome && !chrome.webContents.isDestroyed()) chrome.webContents.send(channel, ...args);
}

// ───────────────────────────── Запуск ─────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const url = argv.find(a => /^https?:\/\//i.test(a));
    if (url) createTab(url);
  });
  app.whenReady().then(start);
}
app.on('window-all-closed', () => app.quit());

function savedBoundsAreVisible(b) {
  if (b.x == null || b.y == null) return false;
  return screen.getAllDisplays().some(({ workArea: w }) =>
    b.x < w.x + w.width - 100 && b.x + b.width > w.x + 100 && b.y >= w.y - 10 && b.y < w.y + w.height - 100);
}

function start() {
  Menu.setApplicationMenu(null);
  bookmarks = readJson('bookmarks.json', []);
  settings = { theme: 'system', ...readJson('settings.json', {}) };
  nativeTheme.themeSource = ['light', 'dark'].includes(settings.theme) ? settings.theme : 'system';
  nativeTheme.on('updated', applyThemeColors);
  history = readJson('history.json', []);

  const ws = readJson('window.json', {});
  const bounds = { width: ws.width || 1280, height: ws.height || 820 };
  if (savedBoundsAreVisible(ws)) Object.assign(bounds, { x: ws.x, y: ws.y });

  win = new BaseWindow({
    ...bounds,
    minWidth: 600,
    minHeight: 400,
    title: APP_NAME,
    icon: path.join(__dirname, 'ui', 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#202124' : '#ffffff',
  });
  if (ws.maximized) win.maximize();

  chrome = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.contentView.addChildView(chrome);
  chrome.webContents.loadFile(path.join(__dirname, 'ui', 'index.html'));
  chrome.webContents.on('did-finish-load', () => { chromeSend('bookmarks', bookmarks); sendState(); });
  chrome.webContents.on('before-input-event', (e, input) => { if (handleShortcut(input)) e.preventDefault(); });

  for (const ev of ['resize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen'])
    win.on(ev, layout);
  win.on('leave-full-screen', () => { fullscreen = false; layout(); });
  win.on('close', saveAll);
  win.on('closed', () => { win = null; });

  setupSession();
  restoreSession();
  layout();
}

function setupSession() {
  const ses = session.defaultSession;
  try { ses.setSpellCheckerLanguages(['ru', 'en-US']); } catch { /* словари недоступны */ }

  ses.on('will-download', (_e, item) => {
    const file = uniquePath(app.getPath('downloads'), item.getFilename() || 'download');
    item.setSavePath(file);
    const d = { name: path.basename(file), path: file, state: 'progressing', received: 0, total: item.getTotalBytes(), item };
    downloads.unshift(d);
    if (downloads.length > 30) downloads.pop();

    item.on('updated', (_ev, state) => {
      d.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      d.received = item.getReceivedBytes();
      d.total = item.getTotalBytes();
      scheduleState();
    });
    item.once('done', (_ev, state) => {
      d.state = state;          // completed | cancelled | interrupted
      d.item = null;
      sendState();
      if (state === 'completed' && win && !win.isFocused()) win.flashFrame(true);
    });
    chromeSend('download-started');
    sendState();
  });
}

function uniquePath(dir, filename) {
  const safe = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  const ext = path.extname(safe);
  const base = path.basename(safe, ext);
  let candidate = path.join(dir, safe);
  for (let n = 1; fs.existsSync(candidate); n++) candidate = path.join(dir, `${base} (${n})${ext}`);
  return candidate;
}

// ───────────────────────────── Сессия ─────────────────────────────

function restoreSession() {
  const saved = readJson('session.json', null);
  const list = (saved?.tabs || []).filter(t => t && typeof t.url === 'string' && t.url);
  if (!list.length) {
    createTab(HOME);
    return;
  }
  // Загружаем только активную вкладку, остальные — при первом открытии.
  const active = Math.min(Math.max(saved.active || 0, 0), list.length - 1);
  list.forEach((t, i) => createTab(t.url === 'start' ? START_URL : t.url,
    { activate: false, lazy: i !== active, title: t.url === 'start' ? 'Новая вкладка' : t.title }));
  activateTab(tabs[active].id);
}

function saveAll() {
  if (!win) return;
  writeJson('session.json', {
    active: Math.max(0, tabs.findIndex(t => t.id === activeId)),
    tabs: tabs.map(t => ({ url: isStartUrl(t.pendingUrl || t.wc.getURL()) ? 'start' : displayUrl(t), title: t.title }))
      .filter(t => t.url),
  });
  const b = win.getNormalBounds();
  writeJson('window.json', { ...b, maximized: win.isMaximized() });
  flushWrites();
}

// ───────────────────────────── Вкладки ─────────────────────────────

function createTab(url, opts = {}) {
  const { activate = true, lazy = false, title, index } = opts;
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true,
      preload: path.join(__dirname, 'start-preload.js'),
    },
  });
  view.setBackgroundColor(pageBackground());
  view.setVisible(false);

  const tab = {
    id: nextId++, view, wc: view.webContents,
    title: title || 'Новая вкладка', favicon: null, loading: false, errorUrl: null, pendingUrl: null,
  };
  if (index != null && index >= 0 && index <= tabs.length) tabs.splice(index, 0, tab);
  else tabs.push(tab);
  win.contentView.addChildView(view);
  wireTab(tab);

  if (url) {
    if (lazy) tab.pendingUrl = url;
    else loadInTab(tab, url);
  }
  if (activate || activeId == null) activateTab(tab.id);
  else { layout(); sendState(); }
  return tab;
}

function loadInTab(tab, url) {
  tab.pendingUrl = null;
  tab.errorUrl = null;
  tab.wc.loadURL(url).catch(() => { /* ошибки показывает did-fail-load */ });
}

function displayUrl(tab) {
  if (tab.pendingUrl) return isStartUrl(tab.pendingUrl) ? '' : tab.pendingUrl;
  if (tab.wc.isDestroyed()) return '';
  const u = tab.wc.getURL();
  if (isStartUrl(u)) return '';
  if (tab.errorUrl && u.startsWith('data:')) return tab.errorUrl;
  return u === 'about:blank' ? '' : u;
}

function activateTab(id, focusPage = false) {
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  if (findOpen && activeId !== id) closeFind();
  activeId = id;
  if (tab.pendingUrl) loadInTab(tab, tab.pendingUrl);
  layout();
  sendState();
  if (focusPage) tab.wc.focus();
}

function closeTab(id) {
  const i = tabs.findIndex(t => t.id === id);
  if (i < 0) return;
  const [tab] = tabs.splice(i, 1);
  const url = displayUrl(tab);
  if (url) {
    closedTabs.push({ url, title: tab.title, index: i });
    if (closedTabs.length > 25) closedTabs.shift();
  }
  win.contentView.removeChildView(tab.view);
  try { tab.wc.close(); } catch { /* уже закрыта */ }

  if (!tabs.length) { newTabFocused(); return; }
  if (activeId === id) activateTab(tabs[Math.min(i, tabs.length - 1)].id, true);
  else sendState();
}

function newTabFocused() {
  createTab(HOME);
  focusAddress();
}

function reopenClosedTab() {
  const c = closedTabs.pop();
  if (c) createTab(c.url, { index: c.index, title: c.title });
}

function switchTab(delta) {
  if (tabs.length < 2) return;
  const i = tabs.findIndex(t => t.id === activeId);
  activateTab(tabs[(i + delta + tabs.length) % tabs.length].id, true);
}

function wireTab(tab) {
  const { wc } = tab;

  wc.on('page-title-updated', (_e, title) => {
    tab.title = title;
    const last = history[history.length - 1];
    if (last && last.url === wc.getURL()) { last.title = title; saveLater('history.json', history); }
    sendState();
  });
  wc.on('page-favicon-updated', (_e, favicons) => { tab.favicon = favicons[0] || null; sendState(); });
  wc.on('did-start-loading', () => { tab.loading = true; sendState(); });
  wc.on('did-stop-loading', () => { tab.loading = false; sendState(); });
  wc.on('did-navigate', (_e, url) => {
    if (!url.startsWith('data:')) {
      tab.errorUrl = null;
      tab.favicon = null;
      addHistory(url, wc.getTitle());
    }
    sendState();
  });
  wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => { if (isMainFrame) sendState(); });
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 — загрузка прервана (это не ошибка)
    tab.errorUrl = url;
    wc.loadURL(errorPage(url, code, desc)).catch(() => {});
  });

  // Ссылки «в новой вкладке» открываем вкладкой; всплывающие окна входа (OAuth) — отдельным окном.
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (disposition === 'new-window') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 900, height: 700, autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, sandbox: true },
        },
      };
    }
    createTab(url, { activate: disposition !== 'background-tab', index: tabs.indexOf(tab) + 1 });
    return { action: 'deny' };
  });

  wc.on('context-menu', (_e, params) => showContextMenu(tab, params));
  wc.on('before-input-event', (e, input) => { if (handleShortcut(input)) e.preventDefault(); });
  wc.on('enter-html-full-screen', () => setFullscreen(true));
  wc.on('leave-html-full-screen', () => setFullscreen(false));
  wc.on('found-in-page', (_e, r) => {
    if (tab.id === activeId) chromeSend('find-result', { active: r.activeMatchOrdinal, total: r.matches });
  });
  wc.on('zoom-changed', (_e, direction) => zoom(tab, direction === 'in' ? 1 : -1));
  wc.on('render-process-gone', () => { tab.title = 'Страница не отвечает — обновите'; tab.loading = false; sendState(); });
}

function errorPage(url, code, desc) {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hints = {
    '-105': 'Сайт с таким адресом не найден. Проверьте, нет ли опечатки.',
    '-106': 'Нет подключения к интернету. Проверьте сеть или Wi-Fi.',
    '-109': 'Адрес недоступен.',
    '-102': 'Сайт отклонил подключение.',
    '-118': 'Сайт слишком долго не отвечает.',
    '-137': 'Не удалось определить адрес сайта. Проверьте подключение к интернету.',
    '-200': 'У сайта проблема с сертификатом безопасности. Подключение может быть небезопасным.',
    '-201': 'У сертификата сайта истёк срок действия или неверная дата на компьютере.',
    '-202': 'Сертификат сайта выдан ненадёжным центром.',
  };
  const hint = hints[String(code)] || (code <= -200 && code > -300
    ? 'Проблема с сертификатом безопасности сайта.'
    : 'Сайт не открылся. Попробуйте ещё раз чуть позже.');
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Не удаётся открыть сайт</title>
<style>
  body{font-family:"Segoe UI",system-ui,sans-serif;color:#3c4043;background:#fff;margin:0;display:flex;justify-content:center}
  .box{max-width:560px;margin:12vh 24px 0}
  h1{font-weight:500;font-size:26px;color:#202124;margin:0 0 12px}
  .url{color:#5f6368;word-break:break-all;margin:0 0 20px}
  .code{color:#80868b;font-size:13px;margin-top:20px}
  a.btn{display:inline-block;margin-top:24px;background:#1a73e8;color:#fff;text-decoration:none;padding:9px 22px;border-radius:6px;font-weight:500}
  a.btn:hover{background:#1765cc}
  @media (prefers-color-scheme:dark){body{background:#202124;color:#bdc1c6}h1{color:#e8eaed}}
</style></head><body><div class="box">
  <h1>Не удаётся открыть сайт</h1>
  <p class="url">${esc(url)}</p>
  <p>${esc(hint)}</p>
  <a class="btn" href="${esc(url)}">Повторить</a>
  <p class="code">${esc(desc)} (${code})</p>
</div></body></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

// ───────────────────────────── Тема оформления ─────────────────────────────

const pageBackground = () => (nativeTheme.shouldUseDarkColors ? '#202124' : '#ffffff');

function setTheme(theme) {
  settings.theme = theme;
  writeJson('settings.json', settings);
  nativeTheme.themeSource = theme; // system | light | dark — сайты тоже получают prefers-color-scheme
}

function applyThemeColors() {
  if (!win) return;
  win.setBackgroundColor(pageBackground());
  for (const t of tabs) t.view.setBackgroundColor(pageBackground());
}

// ───────────────────────────── Раскладка окна ─────────────────────────────

function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  const top = fullscreen ? 0 : CHROME_HEIGHT + (findOpen ? FIND_HEIGHT : 0);
  chrome.setVisible(!fullscreen);
  chrome.setBounds({ x: 0, y: 0, width, height: top });
  for (const t of tabs) {
    t.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
    t.view.setVisible(t.id === activeId);
  }
}

function setFullscreen(on) {
  if (fullscreen === on) return;
  fullscreen = on;
  win.setFullScreen(on);
  layout();
}

// ───────────────────────────── Состояние для панели ─────────────────────────────

let stateTimer = null;
function scheduleState() {
  if (!stateTimer) stateTimer = setTimeout(() => { stateTimer = null; sendState(); }, 300);
}

function sendState() {
  if (!win) return;
  const t = activeTab();
  const url = t ? displayUrl(t) : '';
  const active = downloads.filter(d => d.state === 'progressing');
  const total = active.reduce((s, d) => s + (d.total || 0), 0);
  const received = active.reduce((s, d) => s + (d.received || 0), 0);

  chromeSend('state', {
    tabs: tabs.map(x => ({ id: x.id, title: x.title, favicon: x.favicon, loading: x.loading && !x.pendingUrl })),
    activeId,
    url,
    secure: url.startsWith('https://'),
    canBack: !!t && canGoBack(t.wc),
    canForward: !!t && canGoForward(t.wc),
    loading: !!t?.loading,
    bookmarked: !!url && bookmarks.some(b => b.url === url),
    zoom: t && !t.wc.isDestroyed() ? Math.round(t.wc.getZoomFactor() * 100) : 100,
    downloadsActive: active.length,
    downloadsProgress: total ? Math.round((received / total) * 100) : null,
    hasDownloads: downloads.length > 0,
  });
  win.setTitle(t && t.title && !t.pendingUrl ? `${t.title} — ${APP_NAME}` : APP_NAME);
}

function focusAddress() {
  chrome.webContents.focus();
  chromeSend('focus-address');
}

// ───────────────────────────── Навигация ─────────────────────────────

/** Превращает ввод в адресной строке в URL: адрес открываем, всё остальное ищем в Google. */
function toUrl(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  if (/^(https?|file|about|data):/i.test(text)) return text;
  if (/^[a-z]:[\\/]/i.test(text)) return 'file:///' + text.replace(/\\/g, '/');

  const hostLike = !/\s/.test(text) && (
    /^[^\s/?#]+\.[a-zа-яё][a-zа-яё0-9-]+(:\d+)?([/?#].*)?$/i.test(text) ||
    /^localhost(:\d+)?([/?#].*)?$/i.test(text) ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#].*)?$/.test(text)
  );
  if (hostLike) {
    try { return new URL((/^localhost|^\d/.test(text) ? 'http://' : 'https://') + text).href; } catch { /* ищем */ }
  }
  return SEARCH + encodeURIComponent(text);
}

function navigateActive(input) {
  const t = activeTab();
  const url = toUrl(input);
  if (!t || !url) return;
  loadInTab(t, url);
  t.wc.focus();
}

function zoom(tab, step) {
  if (!tab || tab.wc.isDestroyed()) return;
  const cur = tab.wc.getZoomFactor();
  let next = 1;
  if (step > 0) next = ZOOM_STEPS.find(z => z > cur + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  if (step < 0) next = [...ZOOM_STEPS].reverse().find(z => z < cur - 0.001) ?? ZOOM_STEPS[0];
  tab.wc.setZoomFactor(next);
  sendState();
}

// ───────────────────────────── Поиск по странице ─────────────────────────────

function openFind() {
  if (!activeTab()) return;
  if (!findOpen) { findOpen = true; layout(); }
  chrome.webContents.focus();
  chromeSend('find-open');
}

function closeFind() {
  if (!findOpen) return;
  findOpen = false;
  const t = activeTab();
  if (t && !t.wc.isDestroyed()) { t.wc.stopFindInPage('clearSelection'); t.wc.focus(); }
  layout();
  chromeSend('find-close');
}

// ───────────────────────────── Закладки и история ─────────────────────────────

function toggleBookmark() {
  const t = activeTab();
  const url = t ? displayUrl(t) : '';
  if (!/^https?:/i.test(url)) return;
  const i = bookmarks.findIndex(b => b.url === url);
  if (i >= 0) bookmarks.splice(i, 1);
  else bookmarks.push({ title: t.title || url, url, favicon: t.favicon });
  bookmarksChanged();
}

function bookmarksChanged() {
  saveLater('bookmarks.json', bookmarks, 200);
  chromeSend('bookmarks', bookmarks);
  sendState();
}

function addHistory(url, title) {
  if (!/^https?:/i.test(url)) return;
  const last = history[history.length - 1];
  if (last && last.url === url) last.time = Date.now();
  else history.push({ url, title: title || url, time: Date.now() });
  if (history.length > 2000) history.splice(0, history.length - 2000);
  saveLater('history.json', history);
}

function formatTime(ms) {
  const d = new Date(ms);
  const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${hm}`;
}

function historyItems() {
  const seen = new Set();
  const items = [];
  for (let i = history.length - 1; i >= 0 && items.length < 25; i--) {
    const h = history[i];
    if (seen.has(h.url)) continue;
    seen.add(h.url);
    items.push({ label: escMenu(`${formatTime(h.time)}    ${shorten(h.title || h.url, 60)}`), click: () => navigateActive(h.url) });
  }
  if (!items.length) items.push({ label: 'История пуста', enabled: false });
  items.push({ type: 'separator' }, {
    label: 'Очистить историю…', enabled: history.length > 0,
    click: async () => {
      if (await confirm('Удалить всю историю посещений?', 'Закладки и открытые вкладки сохранятся.')) {
        history = [];
        saveLater('history.json', history, 0);
      }
    },
  });
  return items;
}

function downloadItems() {
  const fmt = n => (n > 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);
  const items = downloads.map(d => {
    let status = 'загружено';
    let submenu;
    if (d.state === 'progressing') {
      status = d.total ? `${Math.round((d.received / d.total) * 100)}% из ${fmt(d.total)}` : `${fmt(d.received)}…`;
      submenu = [{ label: 'Отменить загрузку', click: () => d.item?.cancel() }];
    } else if (d.state === 'completed') {
      submenu = [
        { label: 'Открыть', click: () => shell.openPath(d.path) },
        { label: 'Показать в папке', click: () => shell.showItemInFolder(d.path) },
      ];
    } else {
      status = d.state === 'cancelled' ? 'отменено' : 'ошибка';
      submenu = [{ label: 'Удалить из списка', click: () => { downloads.splice(downloads.indexOf(d), 1); sendState(); } }];
    }
    return { label: escMenu(`${shorten(d.name, 50)} — ${status}`), submenu };
  });
  if (!items.length) items.push({ label: 'Загрузок пока нет', enabled: false });
  items.push({ type: 'separator' }, { label: 'Открыть папку «Загрузки»', click: () => shell.openPath(app.getPath('downloads')) });
  return items;
}

// ───────────────────────────── Меню ─────────────────────────────

function popup(template, x, y) {
  const opts = { window: win };
  if (Number.isFinite(x) && Number.isFinite(y)) Object.assign(opts, { x: Math.round(x), y: Math.round(y) });
  Menu.buildFromTemplate(template).popup(opts);
}

async function confirm(message, detail) {
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Да', 'Отмена'], defaultId: 0, cancelId: 1, title: APP_NAME, message, detail,
  });
  return response === 0;
}

function mainMenuTemplate() {
  const t = activeTab();
  const z = t ? Math.round(t.wc.getZoomFactor() * 100) : 100;
  return [
    { label: 'Новая вкладка', accelerator: 'Ctrl+T', click: newTabFocused },
    { label: 'Восстановить закрытую вкладку', accelerator: 'Ctrl+Shift+T', enabled: closedTabs.length > 0, click: reopenClosedTab },
    { type: 'separator' },
    { label: 'История', accelerator: 'Ctrl+H', submenu: historyItems() },
    { label: 'Загрузки', accelerator: 'Ctrl+J', submenu: downloadItems() },
    { type: 'separator' },
    {
      label: `Масштаб: ${z}%`, submenu: [
        { label: 'Увеличить', accelerator: 'Ctrl+=', click: () => zoom(activeTab(), 1) },
        { label: 'Уменьшить', accelerator: 'Ctrl+-', click: () => zoom(activeTab(), -1) },
        { label: 'Обычный (100%)', accelerator: 'Ctrl+0', click: () => zoom(activeTab(), 0) },
      ],
    },
    { label: 'Найти на странице…', accelerator: 'Ctrl+F', click: openFind },
    { label: 'Печать…', accelerator: 'Ctrl+P', click: () => activeTab()?.wc.print() },
    { label: 'Во весь экран', accelerator: 'F11', click: () => setFullscreen(!fullscreen) },
    {
      label: 'Тема оформления', submenu: [
        ['system', 'Как в Windows'], ['light', 'Светлая'], ['dark', 'Тёмная'],
      ].map(([id, label]) => ({ label, type: 'radio', checked: settings.theme === id, click: () => setTheme(id) })),
    },
    { type: 'separator' },
    { label: 'Очистить данные браузера…', click: clearBrowsingData },
    { label: 'Инструменты разработчика', accelerator: 'F12', click: () => activeTab()?.wc.openDevTools() },
    { label: 'О программе', click: showAbout },
    { type: 'separator' },
    { label: 'Выход', click: () => win?.close() },
  ];
}

async function clearBrowsingData() {
  if (!(await confirm('Удалить историю, кэш и файлы cookie?', 'На сайтах придётся заново войти в аккаунт. Закладки сохранятся.'))) return;
  history = [];
  saveLater('history.json', history, 0);
  await session.defaultSession.clearStorageData();
  await session.defaultSession.clearCache();
  dialog.showMessageBox(win, { type: 'info', title: APP_NAME, message: 'Данные браузера очищены.' });
}

function showAbout() {
  dialog.showMessageBox(win, {
    type: 'info', title: APP_NAME, message: `${APP_NAME} ${app.getVersion()}`,
    detail: `Движок: Chromium ${process.versions.chrome}\nДанные хранятся в:\n${app.getPath('userData')}`,
  });
}

function showContextMenu(tab, p) {
  const wc = tab.wc;
  const nextIndex = () => tabs.indexOf(tab) + 1;
  const items = [];
  const sep = () => { if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' }); };
  const selection = (p.selectionText || '').trim();

  if (p.misspelledWord) {
    p.dictionarySuggestions.slice(0, 5).forEach(s => items.push({ label: escMenu(s), click: () => wc.replaceMisspelling(s) }));
    items.push({ label: 'Добавить в словарь', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
    sep();
  }
  if (p.linkURL) {
    items.push(
      { label: 'Открыть ссылку в новой вкладке', click: () => createTab(p.linkURL, { activate: false, index: nextIndex() }) },
      { label: 'Копировать адрес ссылки', click: () => clipboard.writeText(p.linkURL) },
    );
    sep();
  }
  if (p.mediaType === 'image' && p.srcURL) {
    items.push(
      { label: 'Открыть изображение в новой вкладке', click: () => createTab(p.srcURL, { activate: false, index: nextIndex() }) },
      { label: 'Сохранить изображение', click: () => wc.downloadURL(p.srcURL) },
      { label: 'Копировать изображение', click: () => wc.copyImageAt(p.x, p.y) },
      { label: 'Копировать адрес изображения', click: () => clipboard.writeText(p.srcURL) },
    );
    sep();
  }
  if (p.isEditable) {
    const f = p.editFlags;
    items.push(
      { label: 'Отменить', role: 'undo', enabled: f.canUndo },
      { label: 'Повторить', role: 'redo', enabled: f.canRedo },
      { type: 'separator' },
      { label: 'Вырезать', role: 'cut', enabled: f.canCut },
      { label: 'Копировать', role: 'copy', enabled: f.canCopy },
      { label: 'Вставить', role: 'paste', enabled: f.canPaste },
      { label: 'Выделить всё', role: 'selectAll' },
    );
    sep();
  } else if (selection) {
    items.push(
      { label: 'Копировать', role: 'copy' },
      { label: escMenu(`Найти в Google «${shorten(selection.replace(/\s+/g, ' '), 30)}»`), click: () => createTab(SEARCH + encodeURIComponent(selection), { index: nextIndex() }) },
    );
    sep();
  }
  if (!p.linkURL && p.mediaType === 'none' && !p.isEditable && !selection) {
    items.push(
      { label: 'Назад', enabled: canGoBack(wc), click: () => wc.navigationHistory.goBack() },
      { label: 'Вперёд', enabled: canGoForward(wc), click: () => wc.navigationHistory.goForward() },
      { label: 'Обновить', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Печать…', click: () => wc.print() },
    );
    sep();
  }
  items.push({ label: 'Просмотреть код элемента', click: () => wc.inspectElement(p.x, p.y) });
  popup(items);
}

// ───────────────────────────── Горячие клавиши ─────────────────────────────
// Используем physical-код клавиши, чтобы сочетания работали и в русской раскладке.

function handleShortcut(input) {
  if (input.type !== 'keyDown') return false;
  const t = activeTab();
  const ctrl = input.control || input.meta;
  const { shift, alt, code } = input;

  if (ctrl && !alt) {
    switch (code) {
      case 'KeyT': shift ? reopenClosedTab() : newTabFocused(); return true;
      case 'KeyW': case 'F4': if (t) closeTab(t.id); return true;
      case 'KeyL': focusAddress(); return true;
      case 'KeyR': if (t) shift ? t.wc.reloadIgnoringCache() : t.wc.reload(); return true;
      case 'F5': t?.wc.reloadIgnoringCache(); return true;
      case 'KeyD': toggleBookmark(); return true;
      case 'KeyF': openFind(); return true;
      case 'KeyP': t?.wc.print(); return true;
      case 'KeyH': chromeSend('popup', 'history'); return true;
      case 'KeyJ': chromeSend('popup', 'downloads'); return true;
      case 'KeyI': if (shift) { t?.wc.openDevTools(); return true; } return false;
      case 'Tab': case 'PageDown': if (code === 'Tab' && shift) switchTab(-1); else switchTab(1); return true;
      case 'PageUp': switchTab(-1); return true;
      case 'Equal': case 'NumpadAdd': zoom(t, 1); return true;
      case 'Minus': case 'NumpadSubtract': zoom(t, -1); return true;
      case 'Digit0': case 'Numpad0': zoom(t, 0); return true;
    }
    const digit = /^Digit([1-9])$/.exec(code);
    if (digit && tabs.length) {
      const n = Number(digit[1]);
      activateTab((n === 9 ? tabs[tabs.length - 1] : tabs[Math.min(n, tabs.length) - 1]).id, true);
      return true;
    }
    return false;
  }

  if (alt && !ctrl) {
    switch (code) {
      case 'ArrowLeft': if (t && canGoBack(t.wc)) t.wc.navigationHistory.goBack(); return true;
      case 'ArrowRight': if (t && canGoForward(t.wc)) t.wc.navigationHistory.goForward(); return true;
      case 'Home': navigateActive(HOME); return true;
      case 'KeyD': focusAddress(); return true;
    }
    return false;
  }

  switch (code) {
    case 'F5': t?.wc.reload(); return true;
    case 'F6': focusAddress(); return true;
    case 'F11': setFullscreen(!fullscreen); return true;
    case 'F12': t?.wc.toggleDevTools(); return true;
    case 'Escape':
      if (findOpen) { closeFind(); return true; }
      if (fullscreen) setFullscreen(false); // страница тоже получит Esc и выйдет из своего полноэкранного режима
      return false;
  }
  return false;
}

// ───────────────────────────── Команды от панели ─────────────────────────────

const commands = {
  navigate: text => navigateActive(text),
  back: () => { const t = activeTab(); if (t && canGoBack(t.wc)) t.wc.navigationHistory.goBack(); },
  forward: () => { const t = activeTab(); if (t && canGoForward(t.wc)) t.wc.navigationHistory.goForward(); },
  reload: () => activeTab()?.wc.reload(),
  stop: () => activeTab()?.wc.stop(),
  home: () => navigateActive(HOME),
  newTab: newTabFocused,
  closeTab: id => closeTab(id),
  activate: id => activateTab(id, true),
  focusPage: () => activeTab()?.wc.focus(),
  resetZoom: () => zoom(activeTab(), 0),
  toggleBookmark,

  openBookmark: (i, inNewTab) => {
    const b = bookmarks[i];
    if (!b) return;
    if (inNewTab) createTab(b.url, { activate: false });
    else navigateActive(b.url);
  },
  bookmarkMenu: (i, x, y) => {
    const b = bookmarks[i];
    if (!b) return;
    popup([
      { label: 'Открыть', click: () => navigateActive(b.url) },
      { label: 'Открыть в новой вкладке', click: () => createTab(b.url) },
      { type: 'separator' },
      { label: 'Переименовать…', click: () => chromeSend('rename-bookmark', i) },
      { label: 'Левее', enabled: i > 0, click: () => { bookmarks.splice(i - 1, 0, ...bookmarks.splice(i, 1)); bookmarksChanged(); } },
      { label: 'Правее', enabled: i < bookmarks.length - 1, click: () => { bookmarks.splice(i + 1, 0, ...bookmarks.splice(i, 1)); bookmarksChanged(); } },
      { type: 'separator' },
      { label: 'Удалить', click: () => { bookmarks.splice(i, 1); bookmarksChanged(); } },
    ], x, y);
  },
  bookmarksOverflow: (start, x, y) => {
    popup(bookmarks.slice(start).map(b => ({ label: escMenu(shorten(b.title, 50)), click: () => navigateActive(b.url) })), x, y);
  },
  renameBookmark: (i, name) => {
    if (!bookmarks[i] || !String(name || '').trim()) { chromeSend('bookmarks', bookmarks); return; }
    bookmarks[i].title = String(name).trim();
    bookmarksChanged();
  },

  tabMenu: (id, x, y) => {
    const tab = tabs.find(t => t.id === id);
    if (!tab) return;
    const i = tabs.indexOf(tab);
    popup([
      { label: 'Новая вкладка справа', click: () => { createTab(HOME, { index: i + 1 }); focusAddress(); } },
      { label: 'Обновить', click: () => (tab.pendingUrl ? activateTab(tab.id) : tab.wc.reload()) },
      { label: 'Дублировать', click: () => createTab(displayUrl(tab) || HOME, { index: i + 1 }) },
      { type: 'separator' },
      { label: 'Закрыть', accelerator: 'Ctrl+W', click: () => closeTab(tab.id) },
      { label: 'Закрыть другие вкладки', enabled: tabs.length > 1, click: () => tabs.filter(t => t !== tab).forEach(t => closeTab(t.id)) },
      { label: 'Закрыть вкладки справа', enabled: i < tabs.length - 1, click: () => tabs.slice(i + 1).forEach(t => closeTab(t.id)) },
      { type: 'separator' },
      { label: 'Восстановить закрытую вкладку', accelerator: 'Ctrl+Shift+T', enabled: closedTabs.length > 0, click: reopenClosedTab },
    ], x, y);
  },

  popup: (which, x, y) => {
    if (which === 'history') popup(historyItems(), x, y);
    else if (which === 'downloads') popup(downloadItems(), x, y);
    else popup(mainMenuTemplate(), x, y);
  },

  find: (text, forward = true, isNew = true) => {
    const t = activeTab();
    if (!t) return;
    if (!text) { t.wc.stopFindInPage('clearSelection'); chromeSend('find-result', { active: 0, total: 0 }); return; }
    t.wc.findInPage(text, { forward, findNext: isNew });
  },
  findClose: closeFind,
};

ipcMain.on('cmd', (e, name, ...args) => {
  if (!chrome || e.sender !== chrome.webContents) return; // принимаем команды только от своей панели
  const fn = commands[name];
  if (fn) fn(...args);
});

// ───────────────────────────── Данные для начальной страницы ─────────────────────────────

const fromStartPage = e => { try { return isStartUrl(e.senderFrame?.url); } catch { return false; } };

// Самые посещаемые сайты по истории браузера
ipcMain.handle('start:top-sites', e => {
  if (!fromStartPage(e)) return [];
  const stats = new Map();
  for (const h of history) {
    let u;
    try { u = new URL(h.url); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const s = stats.get(u.host) || { count: 0, last: 0, origin: u.origin };
    s.count++;
    s.last = Math.max(s.last, h.time || 0);
    stats.set(u.host, s);
  }
  return [...stats.entries()]
    .sort((a, b) => b[1].count - a[1].count || b[1].last - a[1].last)
    .slice(0, 12)
    .map(([host, s]) => ({ url: s.origin + '/', title: host.replace(/^www\./, '') }));
});

// Курсы валют: официальные курсы Национального банка РК, запасной вариант — open.er-api.com
let ratesCache = null;
ipcMain.handle('start:rates', async e => {
  if (!fromStartPage(e)) return null;
  if (ratesCache && Date.now() - ratesCache.time < 60 * 60 * 1000) return ratesCache.data;
  const data = (await ratesFromNationalBank().catch(() => null)) || (await ratesFromOpenApi().catch(() => null));
  if (data) ratesCache = { time: Date.now(), data };
  return data;
});

async function fetchText(url) {
  const res = await net.fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function ratesFromNationalBank() {
  const xml = await fetchText('https://nationalbank.kz/rss/rates_all.xml');
  const tag = (s, name) => (new RegExp(`<${name}>([^<]*)</${name}>`).exec(s) || [])[1]?.trim();
  const rates = {};
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const code = tag(item, 'title');
    const value = parseFloat((tag(item, 'description') || '').replace(',', '.'));
    const quant = parseFloat(tag(item, 'quant') || '1') || 1;
    const change = parseFloat((tag(item, 'change') || '').replace(',', '.'));
    if (code && Number.isFinite(value)) {
      rates[code] = { value: value / quant, change: Number.isFinite(change) ? change / quant : null };
    }
  }
  if (!rates.USD) throw new Error('no data');
  const date = tag(xml, 'date') || (/<pubDate>([^<]*)<\/pubDate>/.exec(xml) || [])[1];
  return { source: `Нацбанк РК${date ? ', ' + String(date).trim().slice(0, 16) : ''}`, rates };
}

async function ratesFromOpenApi() {
  const json = JSON.parse(await fetchText('https://open.er-api.com/v6/latest/KZT'));
  const rates = {};
  for (const code of ['USD', 'EUR', 'RUB', 'CNY']) {
    if (json.rates?.[code]) rates[code] = { value: 1 / json.rates[code], change: null };
  }
  if (!rates.USD) throw new Error('no data');
  return { source: 'рыночный курс', rates };
}
