'use strict';
// Начальная страница «Моего браузера».

const $ = id => document.getElementById(id);
// Данные от браузера: частые сайты и курсы валют.
// На компьютере их даёт preload, на Android приложение подставляет их в window.__mb после загрузки.
const bridge = window.startPage ||
  (location.href.startsWith('file:///android_asset/') ? androidBridge() : null);

function androidBridge() {
  const wait = key => new Promise(resolve => {
    const started = Date.now();
    (function check() {
      if (window.__mb && key in window.__mb) resolve(window.__mb[key]);
      else if (Date.now() - started > 15000) resolve(null);
      else setTimeout(check, 100);
    })();
  });
  return { topSites: () => wait('topSites').then(x => x || []), rates: () => wait('rates') };
}

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('mb.' + key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('mb.' + key, JSON.stringify(value)); return true; }
    catch { return false; }
  },
};

const svg = path => `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
const ICON_CLOSE = svg('<path d="M6 6l12 12M18 6L6 18"/>');
const ICON_PLUS = svg('<path d="M12 5v14M5 12h14"/>');

// ───────────────────────────── Часы и факт дня ─────────────────────────────

function tickClock() {
  const now = new Date();
  $('clock').textContent = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  $('date').textContent = now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
}

// Факты идут в случайном порядке без повторов, пока не закончится весь список.
function nextFact() {
  const facts = window.FACTS || [];
  if (!facts.length) return null;
  let order = store.get('factOrder', []);
  let pos = store.get('factPos', 0);
  if (!Array.isArray(order) || order.length !== facts.length || pos >= order.length) {
    const last = order[order.length - 1];
    order = facts.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    if (order[0] === last && order.length > 1) [order[0], order[1]] = [order[1], order[0]];
    pos = 0;
  }
  store.set('factOrder', order);
  store.set('factPos', pos + 1);
  return facts[order[pos]];
}

function showFact(animate) {
  const fact = nextFact();
  if (!fact) { $('fact').hidden = true; return; }
  const apply = () => {
    $('fact-cat').textContent = fact.c;
    $('fact-text').textContent = fact.f;
    $('fact').classList.remove('fading');
  };
  if (!animate) { apply(); return; }
  $('fact').classList.add('fading');
  setTimeout(apply, 180);
}

$('fact').addEventListener('click', () => showFact(true));

// ───────────────────────────── Поиск ─────────────────────────────

function toUrl(text) {
  if (/^https?:\/\//i.test(text)) return text;
  if (!/\s/.test(text) && /^[^\s/?#]+\.[a-zа-яё][a-zа-яё0-9-]+(:\d+)?([/?#].*)?$/i.test(text)) return 'https://' + text;
  return 'https://www.google.com/search?q=' + encodeURIComponent(text);
}

$('search').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('q').value.trim();
  if (text) location.href = toUrl(text);
});

// ───────────────────────────── Плитки сайтов ─────────────────────────────

const DEFAULT_SITES = [
  { title: 'YouTube', url: 'https://www.youtube.com/' },
  { title: 'Kaspi.kz', url: 'https://kaspi.kz/' },
  { title: 'Krisha.kz', url: 'https://krisha.kz/' },
  { title: '2ГИС', url: 'https://2gis.kz/astana' },
  { title: 'eGov.kz', url: 'https://egov.kz/' },
  { title: 'Gmail', url: 'https://mail.google.com/' },
  { title: 'Переводчик', url: 'https://translate.google.com/' },
  { title: 'Википедия', url: 'https://ru.wikipedia.org/' },
];
const MAX_TILES = 8;

const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

async function renderTiles() {
  const pinned = store.get('pinned', []);
  const hidden = new Set(store.get('hidden', []));
  let frequent = [];
  try { frequent = bridge ? await bridge.topSites() : []; } catch { /* нет данных */ }

  const seen = new Set();
  const list = [];
  const push = (site, isPinned) => {
    const host = hostOf(site.url);
    if (!host || seen.has(host) || (!isPinned && hidden.has(host)) || list.length >= MAX_TILES) return;
    seen.add(host);
    list.push({ ...site, host, pinned: isPinned });
  };
  pinned.forEach(s => push(s, true));
  frequent.forEach(s => push(s, false));
  if (list.length < 8) DEFAULT_SITES.forEach(s => push(s, false));

  const box = $('tiles');
  box.replaceChildren(...list.map(tileElement));
  box.append(addTileElement());
}

function tileElement(site) {
  const a = document.createElement('a');
  a.className = 'tile';
  a.href = site.url;
  a.title = `${site.title}\n${site.url}`;

  const ico = document.createElement('span');
  ico.className = 'ico';
  const img = new Image();
  img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(site.host)}&sz=64`;
  img.onerror = () => { ico.textContent = (site.title || site.host).trim()[0]?.toUpperCase() || '•'; };
  ico.append(img);

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = site.title || site.host;

  const remove = document.createElement('button');
  remove.className = 'remove';
  remove.title = 'Убрать с начальной страницы';
  remove.innerHTML = ICON_CLOSE;
  const removeTile = () => {
    if (site.pinned) store.set('pinned', store.get('pinned', []).filter(p => hostOf(p.url) !== site.host));
    else store.set('hidden', [...new Set([...store.get('hidden', []), site.host])]);
    renderTiles();
  };
  remove.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    removeTile();
  });
  // На телефоне наведения нет — убираем плитку долгим нажатием
  a.addEventListener('contextmenu', e => {
    if (!matchMedia('(hover: none)').matches) return;
    e.preventDefault();
    if (confirm(`Убрать «${site.title || site.host}» с начальной страницы?`)) removeTile();
  });

  a.append(ico, name, remove);
  return a;
}

function addTileElement() {
  const b = document.createElement('button');
  b.className = 'tile add';
  b.title = 'Добавить свой сайт';
  b.innerHTML = `<span class="ico">${ICON_PLUS}</span><span class="name">Добавить</span>`;
  b.addEventListener('click', openAddDialog);
  return b;
}

function openAddDialog() {
  $('site-name').value = '';
  $('site-url').value = '';
  $('dialog').hidden = false;
  $('site-url').focus();
}
const closeDialog = () => { $('dialog').hidden = true; };
$('dialog-cancel').addEventListener('click', closeDialog);
$('dialog').addEventListener('mousedown', e => { if (e.target.id === 'dialog') closeDialog(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeDialog(); $('theme-panel').hidden = true; } });
$('dialog-form').addEventListener('submit', e => {
  e.preventDefault();
  let url = $('site-url').value.trim();
  if (!url) { $('site-url').focus(); return; }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const host = hostOf(url);
  if (!host) { $('site-url').focus(); return; }
  const title = $('site-name').value.trim() || host;
  const pinned = store.get('pinned', []).filter(p => hostOf(p.url) !== host);
  pinned.push({ title, url });
  store.set('pinned', pinned);
  store.set('hidden', store.get('hidden', []).filter(h => h !== host));
  closeDialog();
  renderTiles();
});

// ───────────────────────────── Погода (Open-Meteo, без ключа) ─────────────────────────────

const DEFAULT_CITY = { name: 'Астана', lat: 51.1694, lon: 71.4491 };

const WEATHER = {
  0: ['Ясно', '☀️', '🌙'], 1: ['Преимущественно ясно', '🌤️', '🌙'], 2: ['Переменная облачность', '⛅', '☁️'],
  3: ['Пасмурно', '☁️'], 45: ['Туман', '🌫️'], 48: ['Изморозь, туман', '🌫️'],
  51: ['Слабая морось', '🌦️'], 53: ['Морось', '🌦️'], 55: ['Сильная морось', '🌧️'],
  56: ['Ледяная морось', '🌧️'], 57: ['Ледяная морось', '🌧️'],
  61: ['Небольшой дождь', '🌦️'], 63: ['Дождь', '🌧️'], 65: ['Сильный дождь', '🌧️'],
  66: ['Ледяной дождь', '🌧️'], 67: ['Ледяной дождь', '🌧️'],
  71: ['Небольшой снег', '🌨️'], 73: ['Снег', '🌨️'], 75: ['Сильный снег', '❄️'], 77: ['Снежная крупа', '🌨️'],
  80: ['Ливень', '🌦️'], 81: ['Ливень', '🌧️'], 82: ['Сильный ливень', '⛈️'],
  85: ['Снегопад', '🌨️'], 86: ['Сильный снегопад', '❄️'],
  95: ['Гроза', '⛈️'], 96: ['Гроза с градом', '⛈️'], 99: ['Гроза с градом', '⛈️'],
};
const weatherInfo = (code, isDay = 1) => {
  const w = WEATHER[code] || ['—', '🌡️'];
  return { text: w[0], emoji: !isDay && w[2] ? w[2] : w[1] };
};
const deg = t => `${Math.round(t) > 0 ? '+' : ''}${Math.round(t)}°`;

async function loadWeather(force = false) {
  const city = store.get('city', DEFAULT_CITY);
  $('city').textContent = city.name;
  const key = `${city.lat},${city.lon}`;
  const cached = store.get('weather', null);
  if (!force && cached && cached.key === key && Date.now() - cached.time < 30 * 60 * 1000) {
    renderWeather(cached.data, cached.time);
    return;
  }
  try {
    const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
      latitude: city.lat, longitude: city.lon, timezone: 'auto', forecast_days: '4', wind_speed_unit: 'ms',
      current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min',
    });
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    store.set('weather', { key, time: Date.now(), data });
    renderWeather(data, Date.now());
  } catch {
    if (cached && cached.key === key) renderWeather(cached.data, cached.time);
    else $('weather-body').textContent = 'Не удалось загрузить погоду. Проверьте подключение к интернету.';
  }
}

function renderWeather(data, time) {
  const c = data.current;
  const now = weatherInfo(c.weather_code, c.is_day);
  const d = data.daily;
  const days = d.time.slice(1, 4).map((iso, i) => {
    const w = weatherInfo(d.weather_code[i + 1]);
    const label = new Date(iso + 'T12:00').toLocaleDateString('ru-RU', { weekday: 'short' });
    return `<div><div>${label}</div><div class="emoji" title="${w.text}">${w.emoji}</div>
      <div>${deg(d.temperature_2m_max[i + 1])} <span class="min">${deg(d.temperature_2m_min[i + 1])}</span></div></div>`;
  }).join('');

  $('weather-body').className = '';
  $('weather-body').innerHTML = `
    <div class="now">
      <div class="emoji">${now.emoji}</div>
      <div>
        <div class="temp">${deg(c.temperature_2m)}</div>
      </div>
      <div class="desc">
        <div>${now.text}</div>
        <div class="muted">Ощущается как ${deg(c.apparent_temperature)} · ветер ${Math.round(c.wind_speed_10m)} м/с</div>
      </div>
    </div>
    <div class="days">${days}</div>`;
  $('weather-updated').textContent = 'обновлено в ' + new Date(time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

$('city').addEventListener('click', () => {
  const btn = $('city');
  const input = document.createElement('input');
  input.id = 'city-input';
  input.placeholder = 'Город';
  input.value = btn.textContent;
  btn.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async save => {
    if (done) return;
    done = true;
    const query = input.value.trim();
    input.replaceWith(btn);
    if (!save || !query || query === btn.textContent) return;
    btn.textContent = 'Ищу…';
    try {
      const res = await fetch('https://geocoding-api.open-meteo.com/v1/search?' +
        new URLSearchParams({ name: query, count: '1', language: 'ru', format: 'json' }));
      const place = (await res.json()).results?.[0];
      if (!place) throw new Error('not found');
      store.set('city', { name: place.name, lat: place.latitude, lon: place.longitude });
      loadWeather(true);
    } catch {
      btn.textContent = store.get('city', DEFAULT_CITY).name;
      $('weather-updated').textContent = `Город «${query}» не найден`;
    }
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
});

// ───────────────────────────── Курсы валют ─────────────────────────────

const CURRENCIES = [
  ['USD', 'Доллар США'], ['EUR', 'Евро'], ['RUB', 'Российский рубль'], ['CNY', 'Китайский юань'],
];

async function loadRates() {
  if (!bridge) { $('rates-body').textContent = 'Курсы доступны только в «Моём браузере».'; return; }
  try {
    const r = await bridge.rates();
    if (!r || !r.rates) throw new Error('empty');
    $('rates-source').textContent = r.source;
    $('rates-body').className = '';
    $('rates-body').innerHTML = CURRENCIES.filter(([code]) => r.rates[code]).map(([code, name]) => {
      const x = r.rates[code];
      const value = x.value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const chg = typeof x.change === 'number' && x.change !== 0
        ? `<span class="chg ${x.change > 0 ? 'up' : 'down'}">${x.change > 0 ? '▲' : '▼'} ${Math.abs(x.change).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`
        : '';
      return `<div class="rate"><span class="code">${code}</span><span class="name">${name}</span>
        <span class="value">${value}${chg}</span></div>`;
    }).join('');
  } catch {
    $('rates-body').textContent = 'Не удалось загрузить курсы. Проверьте подключение к интернету.';
  }
}

// ───────────────────────────── Оформление ─────────────────────────────

const THEMES = [
  { id: 'steppe', name: 'Закат в степи', bg: 'radial-gradient(circle at 20% 15%, #ffcf7a 0, transparent 40%), linear-gradient(140deg, #f2994a 0%, #d94f70 45%, #4b2c83 100%)' },
  { id: 'night', name: 'Ночной город', bg: 'radial-gradient(circle at 75% 20%, #3a6db5 0, transparent 45%), linear-gradient(160deg, #0b1324 0%, #15284a 55%, #233b66 100%)' },
  { id: 'aurora', name: 'Северное сияние', bg: 'radial-gradient(ellipse at 30% 10%, #2ee59d55 0, transparent 50%), radial-gradient(ellipse at 80% 30%, #7b5cff66 0, transparent 50%), linear-gradient(170deg, #071a24 0%, #0e2f3a 60%, #10202e 100%)' },
  { id: 'caspian', name: 'Каспий', bg: 'radial-gradient(circle at 80% 85%, #4fd1c544 0, transparent 45%), linear-gradient(150deg, #0f4c81 0%, #1a6fa3 50%, #23a6c5 100%)' },
  { id: 'altai', name: 'Алтай', bg: 'radial-gradient(circle at 15% 20%, #c6f6d533 0, transparent 40%), linear-gradient(150deg, #134e3a 0%, #2f7a4f 50%, #6b9e5a 100%)' },
  { id: 'graphite', name: 'Графит', bg: 'radial-gradient(circle at 50% 0%, #4a4f5c 0, transparent 60%), linear-gradient(180deg, #2a2d34 0%, #1b1d22 100%)' },
];

function applyTheme() {
  const id = store.get('theme', 'night');
  const bg = $('bg');
  if (id === 'photo') {
    const photo = store.get('photo', null);
    if (photo) { bg.style.background = `center / cover no-repeat url("${photo}")`; markTheme(id); return; }
  }
  const theme = THEMES.find(t => t.id === id) || THEMES[1];
  bg.style.background = theme.bg;
  markTheme(theme.id);
}

function markTheme(id) {
  document.querySelectorAll('.theme').forEach(el => el.classList.toggle('on', el.dataset.id === id));
}

function renderThemePicker() {
  const box = $('themes');
  box.replaceChildren(...THEMES.map(t => {
    const b = document.createElement('button');
    b.className = 'theme';
    b.dataset.id = t.id;
    b.style.background = t.bg;
    b.innerHTML = `<span>${t.name}</span>`;
    b.addEventListener('click', () => { store.set('theme', t.id); applyTheme(); });
    return b;
  }));
  const photo = store.get('photo', null);
  if (photo) {
    const b = document.createElement('button');
    b.className = 'theme';
    b.dataset.id = 'photo';
    b.style.background = `center / cover url("${photo}")`;
    b.innerHTML = '<span>Моё фото</span>';
    b.addEventListener('click', () => { store.set('theme', 'photo'); applyTheme(); });
    box.append(b);
  }
}

$('theme-btn').addEventListener('click', e => {
  e.stopPropagation();
  $('theme-panel').hidden = !$('theme-panel').hidden;
});
document.addEventListener('click', e => {
  if (!$('theme-panel').hidden && !e.target.closest('#theme-panel')) $('theme-panel').hidden = true;
});

// Своё фото: уменьшаем до 1920 px и сохраняем на компьютере
$('photo').addEventListener('change', e => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    const scale = Math.min(1, 1920 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(img.src);
    let data = canvas.toDataURL('image/jpeg', 0.82);
    if (!store.set('photo', data)) {
      data = canvas.toDataURL('image/jpeg', 0.6);
      if (!store.set('photo', data)) { alert('Фото слишком большое. Выберите изображение поменьше.'); return; }
    }
    store.set('theme', 'photo');
    renderThemePicker();
    applyTheme();
  };
  img.onerror = () => alert('Не удалось открыть это изображение.');
  img.src = URL.createObjectURL(file);
});

// ───────────────────────────── Запуск ─────────────────────────────

applyTheme();
renderThemePicker();
tickClock();
showFact(false);
setInterval(tickClock, 10 * 1000);
renderTiles();
loadWeather();
loadRates();
// Обновляем погоду, когда вкладка снова становится видимой
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadWeather(); });
