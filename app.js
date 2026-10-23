/* XyP Launcher: логика мобильного лаунчера (Capacitor, без сборщика).
   Скачивание, файловая система, установка и запуск идут через нативные плагины. */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- Платформа и плагины ---------- */
const Cap = window.Capacitor;
const PLATFORM = (Cap && Cap.getPlatform && Cap.getPlatform()) || 'web';
const NATIVE = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const PL = (Cap && Cap.Plugins) || {};
const FS = PL.Filesystem, AL = PL.AppLauncher, FO = PL.FileOpener;
const DIR = 'EXTERNAL';                       // папка приложения: Android/data/<id>/files
const MC_PACKAGE = 'com.mojang.minecraftpe';  // пакет Minecraft Bedrock на Android
const MC_SCHEME = 'minecraft://';             // схема для iOS и для запуска с сервером
const APK_MIME = 'application/vnd.android.package-archive';
const CAN_DOWNLOAD = NATIVE && PLATFORM === 'android' && !!FS;

const pathFinal = id => 'xyp/versions/' + id + '.apk';
const pathPart = id => 'xyp/versions/' + id + '.apk.part';

/* ---------- Состояние ---------- */
const KEY = 'xyp-launcher-app-v1';
const DEF = { selected: null, installedId: null, nick: 'Игрок', h: 150, theme: 'auto', filter: 'all', manifestUrl: '', host: '', port: '', list: [] };
let S = { ...DEF };
try { const raw = JSON.parse(localStorage.getItem(KEY) || 'null'); if (raw && typeof raw === 'object') S = { ...DEF, ...raw }; } catch (e) {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} };

const ACCENTS = [{ n: 'Шалфей', h: 150 }, { n: 'Небо', h: 205 }, { n: 'Лаванда', h: 262 }, { n: 'Роза', h: 340 }, { n: 'Янтарь', h: 30 }];
if (!ACCENTS.some(a => a.h === S.h)) S.h = DEF.h;
if (!['auto', 'light', 'dark'].includes(S.theme)) S.theme = 'auto';
if (!['all', 'done', 'todo'].includes(S.filter)) S.filter = 'all';
if (typeof S.nick !== 'string' || !S.nick.trim()) S.nick = DEF.nick;
if (!Array.isArray(S.list)) S.list = [];

const ID_RE = /^[0-9A-Za-z._-]{1,32}$/;
function sanitizeList(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set(), out = [];
  for (const v of arr) {
    if (!v || typeof v !== 'object' || !ID_RE.test(String(v.id)) || seen.has(String(v.id))) continue;
    let url; try { url = new URL(String(v.url)); } catch (e) { continue; }
    if (url.protocol !== 'https:') continue;
    const size = Number.isFinite(+v.size) && +v.size > 0 ? Math.floor(+v.size) : 0;
    const type = ['release', 'beta', 'old'].includes(v.type) ? v.type : 'release';
    seen.add(String(v.id));
    out.push({ id: String(v.id), type, size, url: url.href, note: typeof v.note === 'string' ? v.note.slice(0, 80) : '' });
  }
  return out;
}
S.list = sanitizeList(S.list);
const ver = id => S.list.find(v => v.id === id);
if (S.selected && !ver(S.selected)) S.selected = null;

const FILES = {};   // id -> размер файла на диске (только проверенные)
const DL = {};      // активные скачивания: id -> { got, total, speed, t, last }
const URL2ID = {};
let armedDel = null, armedDelT = 0, armedReset = false, armedResetT = 0;

const fmtB = b => b >= 1073741824 ? (b / 1073741824).toFixed(2).replace('.', ',') + ' ГБ' : (b / 1048576 >= 10 ? Math.round(b / 1048576) : (b / 1048576).toFixed(1).replace('.', ',')) + ' МБ';
const tagLabel = t => t === 'beta' ? 'Бета' : t === 'old' ? 'Старая' : 'Релиз';
const hasFile = id => FILES[id] != null;

const NEWS = [
  { tag: 'Как это работает', title: 'Скачать, установить, играть', lead: 'Лаунчер скачивает файл версии, проверяет его и открывает установщик Android.',
    items: ['Файлы хранятся в папке приложения на телефоне', 'Кнопка ИГРАТЬ откроет установщик, а после установки запустит Minecraft', 'Список версий берётся из вашего versions.json'] },
  { tag: 'Важно', title: 'Ограничения Android', lead: 'Система не даёт поставить старую версию поверх новой без удаления.',
    items: ['Сначала удалите установленный Minecraft, затем ставьте нужную версию', 'Сделайте копию мира заранее: удаление приложения стирает его данные', 'Подпись файла должна совпадать с установленной игрой'] },
  { tag: 'iOS', title: 'Что умеет лаунчер на iPhone', lead: 'iOS не устанавливает файлы .apk.',
    items: ['Версии скачать нельзя', 'Кнопка ИГРАТЬ открывает уже установленный Minecraft'] }
];

const ICON = {
  dl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12.5a1 1 0 0 0 1 .9h8a1 1 0 0 0 1-.9L18 7M9 7V4.5h6V7"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>'
};

/* ---------- Оформление ---------- */
function applyLook() {
  const r = document.documentElement;
  r.style.setProperty('--h', S.h);
  if (S.theme === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', S.theme);
}
let toastT = 0;
function toast(msg, ms = 2800) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms);
}
const errText = e => (e && (e.message || e.errorMessage)) ? String(e.message || e.errorMessage) : String(e || 'неизвестная ошибка');

/* ---------- Вкладки ---------- */
function setTab(name) {
  ['home', 'versions', 'settings'].forEach(n => { $('#tab-' + n).hidden = n !== name; });
  $$('.nav').forEach(b => { if (b.dataset.tab === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  window.scrollTo(0, 0);
}
$$('.nav').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
$('#chipPlayer').addEventListener('click', () => { setTab('settings'); setTimeout(() => $('#nick').focus(), 60); });
$('#heroChange').addEventListener('click', () => setTab('versions'));

function renderPlayer() {
  const n = S.nick.trim() || DEF.nick;
  $('#chipName').textContent = n;
  $('#chipAvatar').textContent = [...n][0].toUpperCase();
}

function renderNotice() {
  const box = $('#notice');
  if (!NATIVE) {
    box.hidden = false;
    box.innerHTML = '<b>Нужно приложение</b><span>В браузере нет доступа к файлам и запуску игр. Соберите APK (инструкция в README) и откройте лаунчер как приложение.</span>';
  } else if (PLATFORM === 'ios') {
    box.hidden = false;
    box.innerHTML = '<b>iPhone и iPad</b><span>iOS не устанавливает .apk. Здесь лаунчер только открывает уже установленный Minecraft.</span>';
  } else if (!FS || !AL || !FO) {
    box.hidden = false;
    box.innerHTML = '<b>Не хватает плагинов</b><span>Пересоберите приложение по README: нужны Filesystem, AppLauncher и FileOpener.</span>';
  } else box.hidden = true;
}

/* ---------- Главная ---------- */
const playBtn = $('#playBtn');
function canPlayNow(v) {
  if (PLATFORM === 'ios' && NATIVE) return !!AL;
  if (!CAN_DOWNLOAD || !AL) return false;
  return !!v && (hasFile(v.id) || S.installedId === v.id);
}
function renderHero() {
  const v = ver(S.selected);
  const pill = $('#heroPill'), hint = $('#heroHint'), dlb = $('#heroDl'), re = $('#heroReinstall');
  dlb.hidden = true; re.hidden = true;
  if (PLATFORM === 'ios' && NATIVE) {
    $('#heroVer').textContent = 'iOS';
    $('#heroMeta').textContent = 'Запуск установленной игры';
    pill.className = 'pill off'; pill.textContent = 'Без загрузки';
    playBtn.disabled = !AL; hint.textContent = 'ИГРАТЬ откроет Minecraft Bedrock';
    return;
  }
  if (!v) {
    $('#heroVer').textContent = '—';
    $('#heroMeta').textContent = S.list.length ? 'Версия не выбрана' : 'Список версий пуст';
    pill.className = 'pill off'; pill.textContent = 'Нет выбора';
    playBtn.disabled = true;
    hint.textContent = S.list.length ? 'Выберите версию на вкладке «Версии»' : 'Укажите адрес versions.json в настройках';
    return;
  }
  const d = DL[v.id], has = hasFile(v.id), inst = S.installedId === v.id;
  $('#heroVer').textContent = v.id;
  $('#heroMeta').textContent = tagLabel(v.type) + (v.size ? ' · ' + fmtB(v.size) : '');
  if (inst) { pill.className = 'pill ok'; pill.innerHTML = ICON.check + 'Установлено'; }
  else if (has) { pill.className = 'pill ok'; pill.innerHTML = ICON.check + 'Скачано'; }
  else if (d) { pill.className = 'pill busy'; pill.textContent = 'Скачивается' + (d.total ? ' ' + Math.floor(d.got / d.total * 100) + '%' : ''); }
  else { pill.className = 'pill off'; pill.textContent = 'Не скачано'; }
  playBtn.disabled = !canPlayNow(v);
  if (!NATIVE) hint.textContent = 'Откройте лаунчер как приложение на телефоне';
  else if (inst) hint.textContent = 'ИГРАТЬ откроет Minecraft Bedrock';
  else if (has) hint.textContent = 'ИГРАТЬ откроет установщик Android для этой версии';
  else if (d) hint.textContent = 'Дождитесь окончания скачивания';
  else hint.textContent = 'Скачайте версию, затем нажмите ИГРАТЬ';
  if (!has && !d && CAN_DOWNLOAD) { dlb.hidden = false; dlb.innerHTML = ICON.dl + 'Скачать ' + esc(v.id); dlb.dataset.id = v.id; }
  re.hidden = !(inst && has);
}
$('#heroDl').addEventListener('click', e => startDl(e.currentTarget.dataset.id));
$('#heroReinstall').addEventListener('click', () => { S.installedId = null; save(); play(); });

function renderNews() {
  $('#news').innerHTML = NEWS.map((n, i) => `
    <article class="news-item glass" data-open="0" data-i="${i}">
      <button class="head" type="button" aria-expanded="false">
        <span class="tag">${esc(n.tag)}</span><h3>${esc(n.title)}</h3><span class="lead">${esc(n.lead)}</span>
        <span class="more"><span>Подробнее</span>${ICON.chev}</span>
      </button>
      <ul hidden>${n.items.map(x => '<li>' + esc(x) + '</li>').join('')}</ul>
    </article>`).join('');
}
$('#news').addEventListener('click', e => {
  const head = e.target.closest('button.head'); if (!head) return;
  const art = head.closest('.news-item'), ul = $('ul', art), open = art.dataset.open !== '1';
  art.dataset.open = open ? '1' : '0'; head.setAttribute('aria-expanded', open); ul.hidden = !open;
  $('.more span', art).textContent = open ? 'Свернуть' : 'Подробнее';
});

/* ---------- Версии ---------- */
function verCard(v) {
  const has = hasFile(v.id), d = DL[v.id], sel = S.selected === v.id, inst = S.installedId === v.id;
  let pill;
  if (inst) pill = `<span class="pill ok">${ICON.check}Установлено</span>`;
  else if (has) pill = `<span class="pill ok">${ICON.check}Скачано</span>`;
  else if (d) pill = '<span class="pill busy">Скачивается</span>';
  else pill = '<span class="pill off">Доступно</span>';
  let act;
  if (d) {
    const pct = d.total ? Math.floor(d.got / d.total * 100) : 0;
    act = `<div class="prog" data-prog="${esc(v.id)}">
      <div class="bar ${d.total ? '' : 'unk'}"><i style="width:${d.total ? d.got / d.total * 100 : 35}%"></i></div>
      <div class="prog-row"><span class="pct">${d.total ? pct + '%' : '…'}</span><span class="mb">${progText(d)}</span></div>
    </div>`;
  } else if (has) {
    const armed = armedDel === v.id;
    act = `<div class="ver-act">
      <button class="btn ${sel ? 'soft' : 'primary'}" type="button" data-act="pick" data-id="${esc(v.id)}">${sel ? ICON.check + 'Выбрано' : 'Выбрать'}</button>
      <button class="btn ${armed ? 'danger' : 'ghost'}" type="button" data-act="del" data-id="${esc(v.id)}">${ICON.trash}${armed ? 'Точно удалить?' : 'Удалить файл'}</button>
    </div>`;
  } else if (CAN_DOWNLOAD) {
    act = `<div class="ver-act"><button class="btn primary" type="button" data-act="dl" data-id="${esc(v.id)}">${ICON.dl}Скачать${v.size ? ' · ' + fmtB(v.size) : ''}</button></div>`;
  } else act = '';
  return `<article class="ver glass" data-id="${esc(v.id)}" data-sel="${sel ? 1 : 0}">
    <button class="ver-main" type="button" data-act="select" data-id="${esc(v.id)}" aria-pressed="${sel}" aria-label="Выбрать версию ${esc(v.id)}">
      <span style="min-width:0"><h3>${esc(v.id)}${sel ? '<span class="tick">' + ICON.check + '</span>' : ''}</h3>
      <div class="ver-sub">${tagLabel(v.type)}${v.note ? ' · ' + esc(v.note) : ''}${v.size ? ' · ' + fmtB(v.size) : ''}</div></span>
      ${pill}
    </button>${act}
  </article>`;
}
function progText(d) {
  const sp = d.speed ? ' · ' + fmtB(d.speed) + '/с' : '';
  return fmtB(d.got) + (d.total ? ' / ' + fmtB(d.total) : '') + sp;
}
function renderVersions() {
  $$('.fchip').forEach(b => b.setAttribute('aria-pressed', b.dataset.f === S.filter));
  const list = S.list.filter(v => S.filter === 'all' || (S.filter === 'done' ? hasFile(v.id) : !hasFile(v.id)));
  const done = S.list.filter(v => hasFile(v.id)).length;
  $('#verCount').textContent = S.list.length ? done + ' из ' + S.list.length + ' скачано' : '';
  let used = 0; S.list.forEach(v => { if (hasFile(v.id)) used += FILES[v.id]; });
  $('#meterTxt').textContent = fmtB(used);
  if (!S.list.length) {
    $('#verList').innerHTML = '<div class="empty glass"><span>Список версий пуст. Укажите адрес versions.json в настройках и обновите список.</span><button class="btn primary" type="button" data-act="goset">Открыть настройки</button></div>';
  } else if (!list.length) {
    $('#verList').innerHTML = `<div class="empty glass"><span>${S.filter === 'done' ? 'Скачанных версий пока нет.' : 'Все версии уже скачаны.'}</span></div>`;
  } else $('#verList').innerHTML = list.map(verCard).join('');
}
$$('.fchip').forEach(b => b.addEventListener('click', () => { S.filter = b.dataset.f; save(); renderVersions(); }));
function refreshAll() { renderHero(); renderVersions(); }

/* ---------- Файловая система ---------- */
async function statFile(path) {
  try { const r = await FS.stat({ path, directory: DIR }); return r && typeof r.size === 'number' ? r.size : null; } catch (e) { return null; }
}
async function verifyFile(v) {
  const size = await statFile(pathFinal(v.id));
  const ok = size != null && size > 0 && (!v.size || size === v.size);
  if (ok) FILES[v.id] = size; else delete FILES[v.id];
  return ok;
}
async function scanFiles() {
  if (!CAN_DOWNLOAD) return;
  await Promise.all(S.list.map(v => verifyFile(v)));
  refreshAll();
}
async function removeQuiet(path) { try { await FS.deleteFile({ path, directory: DIR }); } catch (e) {} }

/* ---------- Скачивание ---------- */
if (CAN_DOWNLOAD) {
  try {
    FS.addListener('progress', ev => {
      const id = URL2ID[ev && ev.url]; const d = id && DL[id]; if (!d) return;
      const now = performance.now();
      d.got = ev.bytes || 0;
      if (ev.contentLength > 0) d.total = ev.contentLength;
      const dt = (now - d.t) / 1000;
      if (dt >= 0.5) { const inst = (d.got - d.last) / dt; d.speed = d.speed ? d.speed * .6 + inst * .4 : inst; d.t = now; d.last = d.got; }
      paintProgress(id);
    });
  } catch (e) {}
}
let paintLock = 0;
function paintProgress(id) {
  const now = performance.now(); if (now - paintLock < 150) return; paintLock = now;
  const d = DL[id], card = $('[data-prog="' + id + '"]');
  if (card && d) {
    const bar = $('.bar', card);
    if (d.total && bar.classList.contains('unk')) { bar.classList.remove('unk'); }
    $('.bar i', card).style.width = (d.total ? d.got / d.total * 100 : 35) + '%';
    $('.pct', card).textContent = d.total ? Math.floor(d.got / d.total * 100) + '%' : '…';
    $('.mb', card).textContent = progText(d);
  }
  renderHero();
}
async function startDl(id) {
  const v = ver(id);
  if (!v || DL[id] || hasFile(id)) return;
  if (!CAN_DOWNLOAD) { toast('Скачивание работает только в приложении на Android'); return; }
  DL[id] = { got: 0, total: v.size || 0, speed: 0, t: performance.now(), last: 0 };
  URL2ID[v.url] = id;
  if (!S.selected) S.selected = id;
  save(); refreshAll();
  toast('Скачивание ' + id + ' началось');
  try {
    await removeQuiet(pathPart(id));
    await FS.downloadFile({ url: v.url, path: pathPart(id), directory: DIR, progress: true, recursive: true });
    const size = await statFile(pathPart(id));
    if (size == null || size <= 0) throw new Error('файл не сохранён');
    if (v.size && size !== v.size) { await removeQuiet(pathPart(id)); throw new Error('размер не совпал: ' + fmtB(size) + ' вместо ' + fmtB(v.size)); }
    await removeQuiet(pathFinal(id));
    await FS.rename({ from: pathPart(id), to: pathFinal(id), directory: DIR, toDirectory: DIR });
    FILES[id] = size;
    toast('Версия ' + id + ' скачана');
  } catch (e) {
    await removeQuiet(pathPart(id));
    toast('Не удалось скачать ' + id + ': ' + errText(e), 5000);
  } finally {
    delete DL[id];
    refreshAll();
  }
}

/* ---------- Установка и запуск ---------- */
function serverUrl() {
  const host = S.host.trim(); if (!host) return null;
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) return null;
  const port = parseInt(S.port, 10);
  return MC_SCHEME + 'connect?serverUrl=' + encodeURIComponent(host) + '&serverPort=' + (port > 0 && port < 65536 ? port : 19132);
}
async function openMinecraft() {
  if (!AL) { toast('Плагин AppLauncher не найден'); return; }
  const target = serverUrl() || (PLATFORM === 'android' ? MC_PACKAGE : MC_SCHEME);
  try {
    const probe = await AL.canOpenUrl({ url: PLATFORM === 'android' ? MC_PACKAGE : MC_SCHEME });
    if (probe && probe.value === false) { toast('Minecraft Bedrock не установлен на этом устройстве', 4500); return; }
    await AL.openUrl({ url: target });
  } catch (e) { toast('Не удалось открыть Minecraft: ' + errText(e), 5000); }
}
async function installVersion(v) {
  if (!FO || !FS) { toast('Плагины установки не найдены'); return false; }
  if (!(await verifyFile(v))) { refreshAll(); toast('Файл версии повреждён или удалён. Скачайте его заново.', 4500); return false; }
  try {
    const { uri } = await FS.getUri({ path: pathFinal(v.id), directory: DIR });
    await FO.open({ filePath: uri, contentType: APK_MIME, openWithDefault: true });
    return true;
  } catch (e) { toast('Не удалось открыть установщик: ' + errText(e), 5000); return false; }
}
async function play() {
  if (!NATIVE) { toast('Откройте лаунчер как приложение на телефоне'); return; }
  if (PLATFORM === 'ios') { openMinecraft(); return; }
  const v = ver(S.selected); if (!v) return;
  if (S.installedId === v.id) { openMinecraft(); return; }
  if (await installVersion(v)) {
    S.installedId = v.id; save(); renderHero(); renderVersions();
    toast('Завершите установку, вернитесь в лаунчер и нажмите ИГРАТЬ', 5500);
  }
}
playBtn.addEventListener('click', () => { if (!playBtn.disabled) play(); });

/* ---------- Действия в списке версий ---------- */
$('#verList').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const id = b.dataset.id, act = b.dataset.act;
  if (act === 'goset') { setTab('settings'); return; }
  if (act === 'select' || act === 'pick') { S.selected = id; save(); refreshAll(); }
  else if (act === 'dl') { S.selected = id; save(); startDl(id); }
  else if (act === 'del') {
    if (armedDel === id) {
      clearTimeout(armedDelT); armedDel = null;
      await removeQuiet(pathFinal(id)); delete FILES[id];
      toast('Файл версии ' + id + ' удалён');
      refreshAll();
    } else {
      armedDel = id; clearTimeout(armedDelT);
      armedDelT = setTimeout(() => { armedDel = null; renderVersions(); }, 3000);
      renderVersions();
    }
  }
});

/* ---------- Список версий (манифест) ---------- */
async function loadManifest(showToast) {
  const url = S.manifestUrl.trim();
  const st = $('#manifestStatus');
  if (!url) { st.textContent = 'Адрес не указан.'; if (showToast) toast('Сначала укажите адрес versions.json'); return; }
  let u; try { u = new URL(url); } catch (e) { st.textContent = 'Неверный адрес.'; if (showToast) toast('Неверный адрес'); return; }
  if (u.protocol !== 'https:') { st.textContent = 'Нужен адрес с https://.'; if (showToast) toast('Адрес должен начинаться с https://'); return; }
  st.textContent = 'Загружаю…';
  $('#manifestBtn').disabled = true;
  try {
    const res = await fetch(u.href, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const list = sanitizeList(data && data.versions);
    if (!list.length) throw new Error('в файле нет подходящих версий');
    S.list = list;
    if (S.selected && !ver(S.selected)) S.selected = null;
    save();
    st.textContent = 'Загружено версий: ' + list.length;
    await scanFiles(); refreshAll();
    if (showToast) toast('Список обновлён: ' + list.length + ' версий');
  } catch (e) {
    st.textContent = 'Ошибка: ' + errText(e) + (S.list.length ? '. Показан сохранённый список.' : '');
    if (showToast) toast('Не удалось загрузить список: ' + errText(e), 4500);
  } finally { $('#manifestBtn').disabled = false; }
}
$('#manifestBtn').addEventListener('click', () => loadManifest(true));

/* ---------- Настройки ---------- */
const nickIn = $('#nick'), manIn = $('#manifest'), hostIn = $('#host'), portIn = $('#port');
nickIn.value = S.nick; manIn.value = S.manifestUrl; hostIn.value = S.host; portIn.value = S.port;
nickIn.addEventListener('input', () => { S.nick = nickIn.value.replace(/[\u0000-\u001f<>]/g, ''); renderPlayer(); save(); });
nickIn.addEventListener('blur', () => { S.nick = S.nick.trim() || DEF.nick; nickIn.value = S.nick; renderPlayer(); save(); });
manIn.addEventListener('change', () => { S.manifestUrl = manIn.value.trim(); save(); });
hostIn.addEventListener('change', () => { S.host = hostIn.value.trim(); save(); });
portIn.addEventListener('input', () => { portIn.value = portIn.value.replace(/\D/g, '').slice(0, 5); S.port = portIn.value; save(); });
function renderSwatches() {
  $('#swatches').innerHTML = ACCENTS.map(a => `<button class="sw" type="button" role="radio" aria-checked="${a.h === S.h}" aria-label="${a.n}" data-h="${a.h}" style="background:hsl(${a.h} 52% 44%)">${ICON.check}</button>`).join('');
}
$('#swatches').addEventListener('click', e => { const b = e.target.closest('.sw'); if (!b) return; S.h = +b.dataset.h; save(); applyLook(); renderSwatches(); });
function renderSegs() { $$('#themeSeg button').forEach(b => b.setAttribute('aria-checked', b.dataset.v === S.theme)); }
$('#themeSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.theme = b.dataset.v; save(); applyLook(); renderSegs(); });
$('#resetBtn').addEventListener('click', e => {
  const btn = e.currentTarget;
  if (armedReset) {
    clearTimeout(armedResetT); armedReset = false;
    S = { ...DEF, list: S.list, manifestUrl: S.manifestUrl };   // скачанные файлы и список не трогаем
    save(); applyLook();
    nickIn.value = S.nick; hostIn.value = ''; portIn.value = '';
    renderPlayer(); renderSwatches(); renderSegs(); refreshAll();
    btn.textContent = 'Сбросить настройки лаунчера'; toast('Настройки сброшены');
  } else {
    armedReset = true; btn.textContent = 'Нажмите ещё раз для сброса';
    armedResetT = setTimeout(() => { armedReset = false; btn.textContent = 'Сбросить настройки лаунчера'; }, 3000);
  }
});
$('#about').textContent = 'XyP Launcher 2.0 · ' + (NATIVE ? PLATFORM : 'браузер') + ' · Файлы версий не входят в приложение. Игра запускается через оригинальный Minecraft Bedrock.';

/* ---------- Старт ---------- */
applyLook(); renderPlayer(); renderNews(); renderSwatches(); renderSegs(); renderNotice(); refreshAll();
(async () => {
  if (CAN_DOWNLOAD) await scanFiles();
  if (NATIVE && S.manifestUrl) loadManifest(false);
})();
document.addEventListener('visibilitychange', () => { if (!document.hidden && CAN_DOWNLOAD && !Object.keys(DL).length) scanFiles(); });
})();
