'use strict';

const api = window.browser;
const $ = id => document.getElementById(id);

const ICONS = {
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  forward: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  reload: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 9.5V20h4.5v-5.5h4V20h4.5V9.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  menu: '<circle cx="12" cy="5.5" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.7" fill="currentColor" stroke="none"/>',
  more: '<path d="M6 7l5 5-5 5M13 7l5 5-5 5"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.4-4.4"/>',
  lock: '<rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.1"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
};
const svg = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
const setIcon = (el, name) => { el.dataset.icon = name; el.innerHTML = svg(name); };

document.querySelectorAll('[data-icon]').forEach(el => {
  if (el.id === 'downloads') el.insertAdjacentHTML('afterbegin', svg('download'));
  else el.innerHTML = svg(el.dataset.icon);
});

const address = $('address');
const findInput = $('find-input');
let state = null;
let bookmarks = [];
let lastActiveId = null;
let dirty = false;           // пользователь начал редактировать адрес
let renamingIndex = null;

// ───────────────────────────── Состояние от главного процесса ─────────────────────────────

api.on('state', s => { state = s; render(); });
api.on('bookmarks', list => { bookmarks = list || []; renamingIndex = null; renderBookmarks(); });
api.on('focus-address', () => { dirty = false; address.focus(); address.select(); });
api.on('find-open', () => {
  $('findbar').hidden = false;
  findInput.focus();
  findInput.select();
  if (findInput.value) api.send('find', findInput.value, true, true);
});
api.on('find-close', () => { $('findbar').hidden = true; $('find-count').textContent = ''; });
api.on('find-result', r => {
  $('find-count').textContent = r.total ? `${r.active} из ${r.total}` : (findInput.value ? 'Нет совпадений' : '');
});
api.on('popup', which => openPopup(which === 'downloads' ? $('downloads') : $('menu'), which));
api.on('rename-bookmark', i => { renamingIndex = i; renderBookmarks(); });
api.on('download-started', () => {
  const b = $('downloads');
  b.classList.remove('pulse');
  void b.offsetWidth;
  b.classList.add('pulse');
});

function openPopup(anchor, which) {
  const r = anchor.getBoundingClientRect();
  api.send('popup', which, Math.round(r.left), Math.round(r.bottom + 2));
}

function render() {
  if (!state) return;
  renderTabs();

  $('back').disabled = !state.canBack;
  $('forward').disabled = !state.canForward;

  const reload = $('reload');
  if (state.loading && reload.dataset.icon !== 'close') { setIcon(reload, 'close'); reload.title = 'Остановить загрузку (Esc)'; }
  if (!state.loading && reload.dataset.icon !== 'reload') { setIcon(reload, 'reload'); reload.title = 'Обновить (F5)'; }

  const tabSwitched = state.activeId !== lastActiveId;
  if (tabSwitched) dirty = false;
  if (!dirty) address.value = state.url;
  lastActiveId = state.activeId;

  const site = $('site-icon');
  const siteIcon = !state.url ? 'search' : state.secure ? 'lock' : 'info';
  if (site.dataset.icon !== siteIcon) setIcon(site, siteIcon);
  site.title = siteIcon === 'lock' ? 'Подключение защищено' : siteIcon === 'info' ? 'Подключение не защищено' : '';

  const star = $('star');
  star.classList.toggle('on', !!state.bookmarked);
  star.title = state.bookmarked ? 'Удалить из закладок (Ctrl+D)' : 'Добавить в закладки (Ctrl+D)';

  const zoom = $('zoom');
  zoom.hidden = state.zoom === 100;
  zoom.textContent = `${state.zoom}%`;

  const badge = $('dl-badge');
  badge.hidden = !state.downloadsActive;
  badge.textContent = state.downloadsProgress != null ? `${state.downloadsProgress}` : String(state.downloadsActive);
  $('downloads').title = state.downloadsActive
    ? `Загружается файлов: ${state.downloadsActive}${state.downloadsProgress != null ? ` (${state.downloadsProgress}%)` : ''}`
    : 'Загрузки (Ctrl+J)';
}

// ───────────────────────────── Вкладки ─────────────────────────────

function renderTabs() {
  const box = $('tabs');
  const existing = new Map([...box.children].map(el => [Number(el.dataset.id), el]));

  state.tabs.forEach((t, i) => {
    let el = existing.get(t.id);
    if (!el) el = createTabElement(t.id);
    existing.delete(t.id);
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);

    el.classList.toggle('active', t.id === state.activeId);
    el.title = t.title;
    const title = el.querySelector('.title');
    if (title.textContent !== t.title) title.textContent = t.title;

    const fav = el.querySelector('.fav');
    const key = t.loading ? 'loading' : t.favicon || 'globe';
    if (fav.dataset.key !== key) {
      fav.dataset.key = key;
      if (t.loading) fav.innerHTML = '<div class="spinner"></div>';
      else if (t.favicon) {
        const img = new Image();
        img.src = t.favicon;
        img.onerror = () => { fav.innerHTML = svg('globe'); };
        fav.replaceChildren(img);
      } else fav.innerHTML = svg('globe');
    }
  });
  existing.forEach(el => el.remove());

  // Узкие вкладки показывают только значок
  requestAnimationFrame(() => {
    for (const el of box.children) el.classList.toggle('narrow', el.getBoundingClientRect().width < 90);
  });
}

function createTabElement(id) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.dataset.id = id;
  el.setAttribute('role', 'tab');
  el.innerHTML = `<span class="fav"></span><span class="title"></span><button class="close" title="Закрыть вкладку (Ctrl+W)">${svg('close')}</button>`;

  el.addEventListener('mousedown', e => {
    if (e.button === 0 && !e.target.closest('.close')) api.send('activate', id);
    if (e.button === 1) e.preventDefault();
  });
  el.addEventListener('auxclick', e => { if (e.button === 1) api.send('closeTab', id); });
  el.querySelector('.close').addEventListener('click', e => { e.stopPropagation(); api.send('closeTab', id); });
  el.addEventListener('contextmenu', e => { e.preventDefault(); api.send('tabMenu', id, e.clientX, e.clientY); });
  return el;
}

$('newtab').addEventListener('click', () => api.send('newTab'));
$('strip-space').addEventListener('dblclick', () => api.send('newTab'));

// ───────────────────────────── Кнопки и адресная строка ─────────────────────────────

$('back').addEventListener('click', () => api.send('back'));
$('forward').addEventListener('click', () => api.send('forward'));
$('reload').addEventListener('click', () => api.send(state?.loading ? 'stop' : 'reload'));
$('home').addEventListener('click', () => api.send('home'));
$('star').addEventListener('click', () => api.send('toggleBookmark'));
$('zoom').addEventListener('click', () => api.send('resetZoom'));
$('menu').addEventListener('click', e => openPopup(e.currentTarget, 'menu'));
$('downloads').addEventListener('click', e => openPopup(e.currentTarget, 'downloads'));

address.addEventListener('input', () => { dirty = true; });
address.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const text = address.value.trim();
    if (!text) return;
    dirty = false;
    address.blur();
    api.send('navigate', text);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    dirty = false;
    address.value = state?.url || '';
    api.send('focusPage');
  }
});
// Первый щелчок выделяет весь адрес, как в обычных браузерах
let selectOnMouseUp = false;
address.addEventListener('mousedown', () => { selectOnMouseUp = document.activeElement !== address; });
address.addEventListener('mouseup', e => {
  if (selectOnMouseUp && address.selectionStart === address.selectionEnd) { e.preventDefault(); address.select(); }
  selectOnMouseUp = false;
});
address.addEventListener('blur', () => { if (!dirty && state) address.value = state.url; });

// ───────────────────────────── Закладки ─────────────────────────────

function renderBookmarks() {
  const list = $('bookmark-list');
  list.replaceChildren();

  if (!bookmarks.length) {
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'Нажмите ☆ в адресной строке или Ctrl+D, чтобы добавить сайт в закладки';
    list.append(hint);
    $('bookmark-more').hidden = true;
    return;
  }

  bookmarks.forEach((b, i) => {
    const el = document.createElement(i === renamingIndex ? 'div' : 'button');
    el.className = 'bm';
    el.title = `${b.title}\n${b.url}`;

    if (i === renamingIndex) {
      const input = document.createElement('input');
      input.value = b.title;
      const finish = save => {
        if (renamingIndex !== i) return;
        renamingIndex = null;
        if (save) api.send('renameBookmark', i, input.value);
        else renderBookmarks();
      };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
        e.stopPropagation();
      });
      input.addEventListener('blur', () => finish(true));
      el.append(input);
      list.append(el);
      requestAnimationFrame(() => { input.focus(); input.select(); });
      return;
    }

    if (b.favicon) {
      const img = new Image();
      img.src = b.favicon;
      img.onerror = () => img.replaceWith(globeIcon());
      el.append(img);
    } else el.append(globeIcon());
    const label = document.createElement('span');
    label.textContent = b.title;
    el.append(label);

    el.addEventListener('click', () => api.send('openBookmark', i, false));
    el.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
    el.addEventListener('auxclick', e => { if (e.button === 1) api.send('openBookmark', i, true); });
    el.addEventListener('contextmenu', e => { e.preventDefault(); api.send('bookmarkMenu', i, e.clientX, e.clientY); });
    list.append(el);
  });
  requestAnimationFrame(updateOverflow);
}

function globeIcon() {
  const span = document.createElement('span');
  span.innerHTML = svg('globe');
  return span.firstChild;
}

// Закладки, которые не поместились, — в меню «»»
function updateOverflow() {
  const list = $('bookmark-list');
  const limit = list.getBoundingClientRect().right;
  const items = [...list.querySelectorAll('.bm')];
  const firstHidden = items.findIndex(el => el.getBoundingClientRect().right > limit + 1);
  const more = $('bookmark-more');
  more.hidden = firstHidden < 0;
  more.dataset.start = firstHidden;
}
$('bookmark-more').addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect();
  api.send('bookmarksOverflow', Number(e.currentTarget.dataset.start), Math.round(r.left), Math.round(r.bottom + 2));
});
window.addEventListener('resize', () => {
  requestAnimationFrame(updateOverflow);
  if (state) renderTabs();
});

// ───────────────────────────── Поиск по странице ─────────────────────────────

findInput.addEventListener('input', () => api.send('find', findInput.value, true, true));
findInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); if (findInput.value) api.send('find', findInput.value, !e.shiftKey, false); }
  if (e.key === 'Escape') { e.preventDefault(); api.send('findClose'); }
});
$('find-next').addEventListener('click', () => findInput.value && api.send('find', findInput.value, true, false));
$('find-prev').addEventListener('click', () => findInput.value && api.send('find', findInput.value, false, false));
$('find-close').addEventListener('click', () => api.send('findClose'));

renderBookmarks();
