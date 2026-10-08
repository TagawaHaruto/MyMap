// MyMap 画面ロジック。純粋な計算は lib.js（Lib）に置く。
const GENRES = { play: '🎡遊び', sightseeing: '📷観光', shopping: '🛍買い物', vehicle: '🚗乗り物', museum: '🏛博物館',
  garden: '🌿植物園', temple: '⛩寺社', onsen: '♨温泉', scenic: '🏔絶景', simulator: '🎮シミュレーター' };
const MODES = { train: '🚃電車', car: '🚗車', bike: '🏍バイク', bicycle: '🚲自転車' };
const GMAP_MODE = { train: 'transit', car: 'driving', bike: 'driving', bicycle: 'bicycling' };
const TIMES = [[30, '30分'], [60, '60分'], [90, '90分'], [120, '2時間'], [180, '3時間'], [null, '制限なし']];
const PREFS = ['東京', '神奈川', '埼玉', '千葉', '山梨', 'その他'];
const DIR_NAMES = { N: '北', NE: '北東', E: '東', SE: '南東', S: '南', SW: '南西', W: '西', NW: '北西' };
const POI_KIND = { michinoeki: '道の駅', onsen: '温泉', viewpoint: '展望台', waterfall: '滝', peak: '山', gorge: '渓谷', lake: '湖', coast: '海岸' };
const SCENIC_KINDS = ['viewpoint', 'waterfall', 'peak', 'gorge', 'lake', 'coast'];
const MAX_WAYPOINTS = 9; // Google マップの URL で渡せる経由地の上限

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('mymap:' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('mymap:' + k, JSON.stringify(v)); } catch { /* 保存できなくても動かす */ } },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel) => document.querySelector(sel);
const buzz = () => { try { navigator.vibrate?.(15); } catch { /* 振動できない端末は無視 */ } };

const saved = store.get('filters') || {};
const state = {
  mode: saved.mode || 'train', maxMin: saved.maxMin === undefined ? 60 : saved.maxMin,
  prefs: new Set(saved.prefs || []), genres: new Set(saved.genres || []), dirs: new Set(saved.dirs || []),
  q: '', limit: 300, rainOverride: null, weatherRainy: false, tab: store.get('tab') || 'spots', period: 'weekend',
  showNotices: false,
  favGenres: new Set(store.get('favGenres') || ['vehicle', 'museum', 'garden', 'temple', 'onsen']),
  favs: new Set(store.get('favs') || []), visited: new Set(store.get('visited') || []),
};
const DATA = { cfg: null, spots: [], osm: [], pois: [], events: [], status: null, touring: [], ver: 0, eventsLoaded: false };
const FAILED = new Set();

const rainy = () => (state.rainOverride ?? state.weatherRainy);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const noticeRe = () => {
  const words = (DATA.cfg && DATA.cfg.eventExcludeWords) || [];
  return words.length ? new RegExp(words.map(escRe).join('|')) : null;
};
const filterState = () => ({ mode: state.mode, maxMin: state.maxMin, prefs: state.prefs, genres: state.genres, dirs: state.dirs,
  favs: state.favs, rainy: rainy(), exclude: state.showNotices ? null : noticeRe() });
function saveFilters() {
  store.set('filters', { mode: state.mode, maxMin: state.maxMin, prefs: [...state.prefs], genres: [...state.genres], dirs: [...state.dirs] });
}
const icon = (label) => [...label][0]; // 先頭の絵文字（コードポイント単位）
const fmtMin = (m) => (m == null ? '' : m < 60 ? `約${m}分` : `約${Math.floor(m / 60)}時間${m % 60 ? (m % 60) + '分' : ''}`);
const dirName = (d) => (DATA.cfg && DATA.cfg.directionLabels && DATA.cfg.directionLabels[d]) || DIR_NAMES[d];
const fmtStamp = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };

// 週 1 回しか変わらないデータは 'no-cache'（ETag で再検証し、変わっていなければ 304 でほぼ通信しない）
async function getJSON(url, fallback, cache = 'no-cache') {
  try {
    const r = await fetch(url, { cache });
    if (r.ok) { FAILED.delete(url); return await r.json(); }
  } catch { /* 下で失敗として扱う */ }
  FAILED.add(url);
  return fallback;
}
function renderLoadMsg() {
  const el = $('#load-msg');
  el.hidden = !FAILED.size;
  if (FAILED.size) {
    el.innerHTML = '一部のデータを読み込めませんでした。電波の良い場所で開き直してください。<button type="button" class="btn" id="reload">再読み込み</button>';
    $('#reload').onclick = () => location.reload();
  }
}

// ---- 屋外モード（日なた・グローブ向け表示） ----
function setOutdoor(on, save = true) {
  document.documentElement.toggleAttribute('data-outdoor', on);
  $('#outdoor').setAttribute('aria-pressed', on);
  if (save) store.set('outdoor', on);
  if (map) setTimeout(() => map.invalidateSize(), 0);
}
$('#outdoor').onclick = () => { buzz(); setOutdoor(!document.documentElement.hasAttribute('data-outdoor')); };

// ---- 絞り込みチップ ----
function chips(el, options, isOn, onClick) {
  el.innerHTML = options.map(([v, label], i) =>
    `<button type="button" class="chip" data-i="${i}" aria-pressed="${isOn(v)}">${esc(label)}</button>`).join('');
  el.onclick = (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    buzz(); onClick(options[+b.dataset.i][0]); state.limit = 300; saveFilters(); renderAll();
  };
}
const toggle = (set, v) => (set.has(v) ? set.delete(v) : set.add(v));
function renderFilters() {
  chips($('#f-mode'), Object.entries(MODES), (v) => v === state.mode, (v) => { state.mode = v; });
  chips($('#f-time'), TIMES, (v) => v === state.maxMin, (v) => { state.maxMin = v; });
  chips($('#f-pref'), PREFS.map((p) => [p, p]), (v) => state.prefs.has(v), (v) => toggle(state.prefs, v));
  chips($('#f-dir'), Lib.DIRS.map((d) => [d, dirName(d)]), (v) => state.dirs.has(v), (v) => toggle(state.dirs, v));
  chips($('#f-genre'), Object.entries(GENRES), (v) => state.genres.has(v), (v) => toggle(state.genres, v));
  const time = TIMES.find(([v]) => v === state.maxMin)[1];
  const parts = [MODES[state.mode], state.maxMin == null ? '時間制限なし' : `${time}以内`,
    state.prefs.size ? [...state.prefs].join('/') : '全都県',
    state.dirs.size ? [...state.dirs].map((d) => DIR_NAMES[d]).join('/') : '全方面'];
  if (state.tab !== 'events') parts.push(state.genres.size ? [...state.genres].map((g) => icon(GENRES[g])).join('') : '全種類');
  $('#f-sum').textContent = parts.join('・');
}
const setCount = (n) => { $('#f-count').textContent = n == null ? '' : `（${n.toLocaleString()}件）`; };
$('#filters').addEventListener('toggle', (e) => store.set('filtersOpen', e.target.open));
$('#rec').addEventListener('toggle', (e) => store.set('recOpen', e.target.open));

// ---- スポット ----
function poiAsSpot(p) {
  return { id: `poi:${p.kind}:${p.name}:${p.lat}`, name: p.name, lat: p.lat, lon: p.lon, pref: null,
    genres: SCENIC_KINDS.includes(p.kind) ? ['scenic'] : p.kind === 'onsen' ? ['onsen'] : ['sightseeing'],
    indoor: false, fee: '', parking: null, tags: [], url: p.wikipedia || '', note: POI_KIND[p.kind] || '', poi: true, kind: p.kind };
}
function spotCandidates() {
  // 絶景を選んだときだけ滝・山・湖などの POI を混ぜる（展望台は osm_spots 側にある）
  const extra = state.genres.has('scenic')
    ? DATA.pois.filter((p) => SCENIC_KINDS.includes(p.kind) && p.kind !== 'viewpoint').map(poiAsSpot) : [];
  return DATA.spots.concat(DATA.osm, extra);
}
const isCurated = (s) => !s.poi && !String(s.id).startsWith('osm:');
const parkText = (s) => (s.parking ? [s.parking.car ? '🅿車' : '', s.parking.bike ? '🅿二輪' : ''].filter(Boolean).join(' ') : '');
function spotCard(s) {
  const sns = Lib.snsLinks(s);
  const icons = s.genres.map((g) => icon(GENRES[g] || '・')).join('');
  const park = parkText(s);
  return `<article class="card">
    <h3>${isCurated(s) ? '<span title="厳選スポット">★</span> ' : ''}${icons} ${esc(s.name)}</h3>
    <p class="meta">${s.indoor ? '<span class="badge rain">☔雨OK</span> ' : ''}${icon(MODES[state.mode])}<strong>${fmtMin(s.minutes)}</strong>${s.fee ? '・' + esc(s.fee) : ''}${park ? '・' + park : ''}</p>
    ${s.note ? `<p>${esc(s.note)}</p>` : ''}
    <div class="actions">
      <a class="btn" href="${esc(Lib.gmapsDirUrl(DATA.cfg.origin, s, [], GMAP_MODE[state.mode]))}" target="_blank" rel="noopener">地図で経路</a>
      ${s.poi ? '' : `<a class="btn" href="${esc(sns.instagram)}" target="_blank" rel="noopener">#Instagram</a>
      <a class="btn" href="${esc(sns.x)}" target="_blank" rel="noopener">#X</a>`}
      ${s.url ? `<a class="btn" href="${esc(s.url)}" target="_blank" rel="noopener">${s.url.includes('wikipedia.org') ? 'Wikipedia' : '公式'}</a>` : ''}
      ${s.poi ? '' : `<button type="button" class="icon" data-fav="${esc(s.id)}" aria-pressed="${state.favs.has(s.id)}" aria-label="お気に入り">⭐</button>
      <button type="button" class="icon" data-visited="${esc(s.id)}" aria-pressed="${state.visited.has(s.id)}">行った</button>`}
    </div></article>`;
}
function renderSpots() {
  // 検索欄は作り直さない（入力中にほかの更新が来てもフォーカスを失わないように）
  if (!$('#q')) {
    $('#view').innerHTML = `<input id="q" type="search" enterkeyhint="search" autocomplete="off" placeholder="名前で探す（例：じんだいじ、JAXA）" aria-label="名前で探す">
      <div id="spot-list"></div>`;
    $('#q').value = state.q;
    let frame = 0;
    $('#q').addEventListener('input', (e) => {
      state.q = e.target.value; state.limit = 300;
      cancelAnimationFrame(frame); frame = requestAnimationFrame(renderSpotList);
    });
  }
  renderSpotList();
}
function renderSpotList() {
  const box = $('#spot-list'); if (!box) return;
  if (state.q.trim()) {
    const all = DATA.spots.concat(DATA.osm, DATA.pois.map(poiAsSpot));
    const hits = Lib.searchSpots(all, state.q, DATA.cfg, state.favs, state.mode);
    setCount(null);
    box.innerHTML = `<p class="status">「${esc(state.q.trim())}」の検索結果 ${hits.length}件（絞り込み条件を外して検索・上位50件）</p>`
      + (hits.length ? hits.map(spotCard).join('') : '<p class="empty">見つかりませんでした。ひらがなや別の呼び方でも試してください。</p>');
    return;
  }
  const list = Lib.filterSpots(spotCandidates(), filterState(), DATA.cfg);
  setCount(list.length);
  const failed = FAILED.has('data/spots.json');
  const head = `<p class="status">${list.length.toLocaleString()}件・★厳選と⭐を先頭に表示${rainy() ? '（雨の日モード：屋内のみ）' : ''}</p>`;
  const more = list.length > state.limit ? `<button type="button" class="btn" id="more">もっと見る（残り${(list.length - state.limit).toLocaleString()}件）</button>` : '';
  box.innerHTML = head + (list.length ? list.slice(0, state.limit).map(spotCard).join('') + more
    : `<p class="empty">${failed ? 'スポットのデータを読み込めていません。電波の良い場所で開き直してください。' : '条件に合うスポットがありません。条件を広げてみてください。'}</p>`);
  if (more) $('#more').onclick = () => { state.limit += 300; renderSpotList(); };
}
document.addEventListener('click', (e) => {
  const fav = e.target.closest('[data-fav]'), vis = e.target.closest('[data-visited]');
  if (fav) { buzz(); toggle(state.favs, fav.dataset.fav); store.set('favs', [...state.favs]); fav.setAttribute('aria-pressed', state.favs.has(fav.dataset.fav)); }
  if (vis) { buzz(); toggle(state.visited, vis.dataset.visited); store.set('visited', [...state.visited]); vis.setAttribute('aria-pressed', state.visited.has(vis.dataset.visited)); }
});

// ---- 今週末のおすすめ ----
function renderRecommend() {
  const cands = Lib.filterSpots(DATA.spots, { ...filterState(), genres: new Set() }, DATA.cfg);
  const ctx = { favGenres: state.favGenres, rainy: rainy(), visited: state.visited };
  const rec = Lib.pickRecommendations(cands, ctx, Lib.weekSeed(new Date()));
  $('#recommend').innerHTML = rec.map(spotCard).join('');
  $('#rec').hidden = !rec.length;
}

// ---- 天気（Open-Meteo, 登録不要） ----
async function loadWeather() {
  const { lat, lon } = DATA.cfg.origin;
  const btn = $('#weather');
  const [sat, sun] = Lib.weekend(new Date());
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=precipitation_probability_max&timezone=Asia%2FTokyo&forecast_days=10`,
      { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const pick = (d) => j.daily.precipitation_probability_max[j.daily.time.indexOf(d)];
    const ps = [['土', pick(sat)], ['日', pick(sun)]].filter(([, p]) => p != null);
    state.weatherRainy = ps.some(([, p]) => p >= DATA.cfg.rainThreshold);
    btn.dataset.text = ps.map(([d, p]) => `${d}${p >= DATA.cfg.rainThreshold ? '☔' : '☀'}${p}%`).join(' ');
    store.set('weather', { text: btn.dataset.text, rainy: state.weatherRainy, sat });
  } catch {
    // 同じ週末の予報を前に取れていれば、それを「前回取得」として出す
    const w = store.get('weather');
    if (w && w.sat === sat) { state.weatherRainy = w.rainy; btn.dataset.text = `${w.text}（前回取得）`; } else btn.dataset.text = '天気を取得できません';
  }
  renderAll();
}
function renderWeather() {
  const btn = $('#weather');
  btn.textContent = `${btn.dataset.text || '天気を確認中…'}${rainy() ? ' ☔雨モード' : ''}`;
  btn.setAttribute('aria-pressed', rainy());
}
$('#weather').onclick = () => { buzz(); state.rainOverride = !rainy(); renderAll(); };

// ---- イベント ----
const PERIODS = [['weekend', '今週末'], ['next', '来週末'], ['month', '今月'], ['3m', '3か月']];
const fmtDate = (d) => { const [, m, day] = d.split('-'); return `${+m}/${+day}`; };
function eventCard(e, from) {
  const long = Lib.spanDays(e) > 3;
  const when = e.start === e.end ? fmtDate(e.start) : long && e.start < from ? `〜${fmtDate(e.end)} 開催中` : `${fmtDate(e.start)}〜${fmtDate(e.end)}`;
  const inout = e.indoor === true ? '<span class="badge rain">☔屋内</span> ' : e.indoor == null ? '<span class="badge unk">屋内外?</span> ' : '';
  return `<article class="card">
    <p class="meta">${inout}<strong>${esc(when)}</strong>${e.minutes != null ? '・' + icon(MODES[state.mode]) + fmtMin(e.minutes) : '・位置不明'}</p>
    <h3>${esc(e.title)}</h3>
    ${e.place ? `<p>${esc(e.place)}</p>` : ''}
    <div class="actions">
      <a class="btn" href="${esc(e.url)}" target="_blank" rel="noopener">詳細</a>
      ${e.lat != null ? `<a class="btn" href="${esc(Lib.gmapsDirUrl(DATA.cfg.origin, e, [], GMAP_MODE[state.mode]))}" target="_blank" rel="noopener">地図で経路</a>` : ''}
      <a class="btn" href="https://x.com/search?q=${encodeURIComponent(e.title)}" target="_blank" rel="noopener">Xで検索</a>
    </div></article>`;
}
function statusHtml() {
  const st = DATA.status;
  if (!st || !st.updated_at) return '<p class="status">イベントはまだ収集されていません。</p>';
  const old = (iso) => Lib.isStale(iso, Date.now(), 72);
  const rows = Object.entries(st.sources || {}).map(([id, s]) =>
    `<li>${old(s.ok_at) || s.error ? '<span class="badge warn">⚠</span>' : ''}${esc(id)}: ${s.ok_at ? esc(s.ok_at.slice(0, 16).replace('T', ' ')) : '未取得'}（${s.count}件）</li>`);
  if (st.spots_error) rows.push(`<li><span class="badge warn">⚠</span>自動収集スポット: 一部の種類を取得できず前回分を表示中（${esc(st.spots_error.slice(0, 80))}）</li>`);
  if (st.pois_error) rows.push(`<li><span class="badge warn">⚠</span>立ち寄り候補: 一部の種類を取得できず前回分を表示中（${esc(st.pois_error.slice(0, 80))}）</li>`);
  return `<details class="status"><summary>最終更新 ${esc(st.updated_at.slice(0, 16).replace('T', ' '))}</summary><ul>${rows.join('')}</ul></details>`;
}
function renderEvents() {
  if (!DATA.eventsLoaded) { setCount(null); $('#view').innerHTML = '<p class="status">イベントを読み込み中…</p>'; return; }
  const [from, to] = Lib.periodRange(state.period, new Date());
  const list = Lib.filterEvents(DATA.events, filterState(), DATA.cfg, from, to);
  const all = Lib.filterEvents(DATA.events, { ...filterState(), exclude: null }, DATA.cfg, from, to).length;
  const hidden = all - list.length;
  setCount(list.length);
  $('#view').innerHTML = `<div id="periods" class="chips"></div>
    <p class="status">${list.length}件・その日だけ／短期のものを先頭に表示${rainy() ? '（雨の日モード：屋外を除外）' : ''}</p>
    ${hidden || state.showNotices ? `<button type="button" class="btn" id="notices">${state.showNotices ? '募集・講座などの告知を隠す' : `募集・講座などの告知${hidden}件を非表示中（表示する）`}</button>` : ''}
    ${list.length ? list.slice(0, 300).map((e) => eventCard(e, from)).join('') : '<p class="empty">この期間・条件のイベントはありません。</p>'}
    ${statusHtml()}`;
  chips($('#periods'), PERIODS, (v) => v === state.period, (v) => { state.period = v; });
  const nb = $('#notices'); if (nb) nb.onclick = () => { buzz(); state.showNotices = !state.showNotices; renderEvents(); };
}

// ---- データ更新の依頼（方式 C：古いときだけ GitHub Actions を起動。トークンは端末内のみ） ----
function setUpdateMsg(text) { const el = $('#update-msg'); el.hidden = !text; el.textContent = text || ''; }
async function requestUpdate(force = false) {
  const st = DATA.status;
  if (!force && !Lib.isStale(st && st.updated_at, Date.now(), DATA.cfg.staleHours)) return;
  const token = store.get('token');
  if (!token) { setUpdateMsg('データが古くなっています。設定タブでトークンを登録すると自動で更新できます。'); return; }
  const prev = st && st.updated_at;
  if (!force && Date.now() - (store.get('lastDispatch') || 0) < 10 * 60e3) { pollStatus(prev); return; }
  const { owner, repo, workflow, branch } = DATA.cfg.github;
  try {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      body: JSON.stringify({ ref: branch || 'main' }),
    });
    if (!r.ok) { setUpdateMsg(`更新の依頼に失敗しました（${r.status}）。トークンの権限と有効期限を確認してください。`); return; }
  } catch {
    setUpdateMsg('更新の依頼を送れませんでした（通信エラー）。'); return;
  }
  store.set('lastDispatch', Date.now());
  pollStatus(prev);
}
async function pollStatus(prev) {
  setUpdateMsg('データを更新中です…（数分かかります。前回のデータを表示しています）');
  for (let i = 0; i < 20; i++) { // 30 秒ごとに最大 10 分
    await new Promise((ok) => setTimeout(ok, 30e3));
    const st = await getJSON('data/status.json', null, 'no-store');
    if (st && st.updated_at && st.updated_at !== prev) {
      DATA.status = st;
      [DATA.events, DATA.pois, DATA.osm] = await Promise.all([getJSON('data/events.json', DATA.events),
        getJSON('data/pois.json', DATA.pois), getJSON('data/osm_spots.json', DATA.osm)]);
      DATA.ver++; tour.stops = null;
      setUpdateMsg(''); renderAll(); return;
    }
  }
  setUpdateMsg('更新に時間がかかっています。しばらくしてから開き直してください。');
}

// ---- ツーリング（ルート：OSRM 公開サーバー／地図：OSM。どちらも登録不要） ----
const savedTour = store.get('tour') || {};
const tour = { destId: savedTour.destId || null, custom: savedTour.custom || null, avoid: !!savedTour.avoid, radius: savedTour.radius || 3,
  route: savedTour.route || null, restored: !!savedTour.route, picked: new Set(savedTour.picked || []), error: '', busy: false,
  awake: store.get('awake') !== false, stops: null, key: '' };
let map = null, markers = new Map();
const saveTour = () => store.set('tour', { destId: tour.destId, custom: tour.custom, avoid: tour.avoid, radius: tour.radius,
  route: tour.route, picked: [...tour.picked] });
const keyColor = () => getComputedStyle(document.documentElement).getPropertyValue('--key').trim() || '#0017c1';

async function fetchRoute(dest, avoid) {
  const pts = [DATA.cfg.origin, ...(dest.waypoints || []).map(([lat, lon]) => ({ lat, lon })), dest];
  const base = `https://router.project-osrm.org/route/v1/driving/${pts.map((p) => `${p.lon},${p.lat}`).join(';')}?overview=full&geometries=geojson`;
  const get = (u) => fetch(u, { signal: AbortSignal.timeout(15000) });
  let r = null, note = '';
  if (avoid) {
    r = await get(base + '&exclude=motorway').catch(() => null);
    if (!r || !r.ok) { note = '公開ルートサーバーが高速回避に未対応のため、通常のルートです。'; r = null; }
  }
  r = r || await get(base);
  if (r.status === 429) throw new Error('ルートサーバーが混雑しています。少し待ってから再検索してください。');
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.code !== 'Ok' || !j.routes || !j.routes.length) throw new Error('この地点までの車のルートが見つかりませんでした。');
  const rt = j.routes[0];
  return { line: rt.geometry.coordinates, km: rt.distance / 1000, min: rt.duration / 60, note, at: Date.now() };
}

const currentDest = () => tour.custom || DATA.touring.find((t) => t.id === tour.destId) || null;
const room = () => MAX_WAYPOINTS - ((currentDest() || {}).waypoints || []).length;
function getStops() {
  if (!tour.route) return [];
  if (!tour.stops) {
    // 山頂は車・バイクで寄れないことが多いので除く
    const items = DATA.spots.concat(DATA.pois.filter((p) => p.kind !== 'peak').map(poiAsSpot));
    tour.stops = Lib.stopsAlongRoute(items, tour.route.line, tour.radius).filter((s) => s.alongKm > 1);
  }
  return tour.stops;
}
function navUrl() {
  const dest = currentDest();
  const picked = getStops().filter((s) => tour.picked.has(s.id)).map((s) => ({ ...s, along: s.alongKm }));
  // 経由地は「ルート上の順番」に並べる（コースの経由地も含めて最大 9 件）
  const wps = [...(dest.waypoints || []).map(([lat, lon]) => ({ lat, lon, along: Lib.distToRoute({ lat, lon }, tour.route.line).along })), ...picked]
    .sort((a, b) => a.along - b.along);
  return Lib.gmapsDirUrl(DATA.cfg.origin, dest, wps, 'driving');
}
function pickedCount() { return getStops().filter((s) => tour.picked.has(s.id)).length; }
function updateTourSelection() {
  const n = pickedCount(), full = n >= room();
  document.querySelectorAll('[data-stop]').forEach((cb) => { cb.disabled = !cb.checked && full; });
  const nav = $('#nav');
  if (nav) {
    nav.href = tour.route ? navUrl() : Lib.gmapsDirUrl(DATA.cfg.origin, currentDest(), [], 'driving');
    nav.textContent = `ナビ開始（経由 ${n}/${room()}）`;
  }
  const lim = $('#limit-msg'); if (lim) lim.hidden = !full;
  styleMarkers();
}
function styleMarkers() {
  const key = keyColor();
  let i = 0;
  for (const s of getStops()) {
    const m = markers.get(s.id); if (!m) continue;
    if (tour.picked.has(s.id)) {
      i++;
      m.setStyle({ radius: 11, color: '#fff', weight: 3, fillColor: key, fillOpacity: 1 });
      m.unbindTooltip().bindTooltip(String(i), { permanent: true, direction: 'center', className: 'num' });
    } else {
      m.setStyle({ radius: 8, color: '#000', weight: 2, fillColor: '#fff', fillOpacity: 1 });
      m.unbindTooltip();
    }
  }
}

function renderTouring() {
  const dest = currentDest();
  const key = JSON.stringify([tour.destId, tour.custom, tour.route && tour.route.at, tour.radius, tour.error, tour.busy, DATA.ver, !!DATA.touring.length]);
  // 変化がなければ作り直さない（地図のズームと位置、スクロール位置を保つ）
  if (key === tour.key && $('#map')) { if (map) map.invalidateSize(); updateTourSelection(); return; }
  tour.key = key;
  const stops = getStops();
  const offline = navigator.onLine === false;
  const sns = dest && !tour.custom ? Lib.snsLinks({ name: dest.name, tags: dest.tags }) : null;
  $('#view').innerHTML = `
    <label for="dest"><strong>目的地</strong></label>
    <select id="dest"><option value="">選んでください</option>${DATA.touring.map((t) =>
      `<option value="${esc(t.id)}" ${t.id === tour.destId && !tour.custom ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
      ${tour.custom ? '<option selected>地図で指定した地点</option>' : ''}</select>
    <p class="hint">地図を長押しして目的地を指定することもできます</p>
    ${dest && dest.note ? `<p class="notice">⚠ ${esc(dest.note)}</p>` : ''}
    ${sns ? `<div class="actions"><a class="btn" href="${esc(sns.x)}" target="_blank" rel="noopener">#X で最新情報</a><a class="btn" href="${esc(sns.instagram)}" target="_blank" rel="noopener">#Instagram</a></div>` : ''}
    <label class="check"><input type="checkbox" id="avoid" ${tour.avoid ? 'checked' : ''}>高速を使わない（下道）</label>
    ${tour.avoid ? '<p class="hint">Google マップ側でも「ルートオプション → 高速道路を使わない」をオンにしてください。</p>' : ''}
    <label class="check"><input type="checkbox" id="awake" ${tour.awake ? 'checked' : ''}>このタブを開いている間は画面を消さない</label>
    <div class="row"><span class="label">立寄</span><div id="radius" class="chips"></div></div>
    <div class="actions"><button type="button" class="btn primary" id="route-go" ${dest && !tour.busy ? '' : 'disabled'}>${tour.busy ? '検索中…' : dest ? 'ルート検索' : '目的地を選ぶと押せます'}</button></div>
    <div id="map"></div>
    ${tour.error ? `<p class="notice">${esc(tour.error)}</p>` : ''}
    ${tour.route && (tour.restored || offline) ? `<p class="notice">${offline ? '📴 圏外のため、' : ''}${fmtStamp(tour.route.at || 0)} に検索して保存したルートを表示しています${offline ? '' : '（再検索で更新）'}。</p>` : ''}
    ${tour.route ? `<p class="route-sum">約${Math.round(tour.route.km)}km・${fmtMin(Math.round(tour.route.min))}</p><p class="hint">OSRM による推定${tour.route.note ? '。' + esc(tour.route.note) : ''}</p>` : ''}
    ${tour.route ? `<h2>立ち寄り候補（${stops.length}件・走る順）</h2>
      <p id="limit-msg" class="notice" hidden>経由地は Google マップの上限（${room()}件）に達しました。ほかを外すと選べます。</p>`
      + (stops.length ? stops.slice(0, 100).map((s) => `
      <label class="card stop"><input type="checkbox" data-stop="${esc(s.id)}" ${tour.picked.has(s.id) ? 'checked' : ''}>
        <span class="km">${Math.round(s.alongKm)}<small>km</small></span>
        <span class="name">${s.genres.map((g) => icon(GENRES[g] || '・')).join('')} ${esc(s.name)}${parkText(s) ? ` <strong>${parkText(s)}</strong>` : ''}
          <span class="sub">道から${s.offKm.toFixed(1)}km${s.note ? '・' + esc(s.note) : ''}</span></span></label>`).join('')
        : '<p class="empty">この範囲に立ち寄り候補はありません。範囲を広げてみてください。</p>') : ''}
    ${dest ? `<div class="tour-bar"><a class="btn primary" id="nav" target="_blank" rel="noopener" href="#">ナビ開始</a></div>` : ''}`;

  chips($('#radius'), [[1, '1km'], [3, '3km'], [5, '5km']], (v) => v === tour.radius, (v) => { tour.radius = v; tour.stops = null; saveTour(); });
  $('#dest').onchange = (e) => {
    tour.destId = e.target.value || null; tour.custom = null; tour.route = null; tour.stops = null; tour.restored = false;
    tour.picked.clear(); tour.error = ''; saveTour(); renderTouring();
  };
  $('#avoid').onchange = (e) => { tour.avoid = e.target.checked; saveTour(); tour.key = ''; renderTouring(); };
  $('#awake').onchange = (e) => { tour.awake = e.target.checked; store.set('awake', tour.awake); keepAwake(tour.awake); };
  $('#route-go').onclick = async () => {
    buzz(); tour.error = ''; tour.busy = true; renderTouring();
    try {
      tour.route = await fetchRoute(currentDest(), tour.avoid);
      tour.restored = false; tour.stops = null; saveTour();
    } catch (err) {
      tour.error = err.name === 'TimeoutError' ? 'ルートサーバーから時間内に応答がありませんでした。電波の良い場所で再検索してください。'
        : err.message && !err.message.startsWith('Failed') ? err.message : 'ルートを取得できませんでした。Google マップのボタンから確認してください。';
    }
    tour.busy = false; renderTouring();
  };
  // チェックの変更では地図も一覧も作り直さない（マーカーとナビボタンだけ更新）
  $('#view').onchange = (e) => {
    const cb = e.target.closest('[data-stop]'); if (!cb) return;
    buzz();
    cb.checked ? tour.picked.add(cb.dataset.stop) : tour.picked.delete(cb.dataset.stop);
    saveTour(); updateTourSelection();
  };
  drawMap(dest, stops);
  updateTourSelection();
}

function drawMap(dest, stops) {
  if (typeof L === 'undefined') { $('#map').textContent = '地図を読み込めませんでした（圏外の可能性があります）。'; return; }
  if (map) map.remove();
  markers = new Map();
  map = L.map('map', { renderer: L.canvas({ tolerance: 8 }) }).setView([DATA.cfg.origin.lat, DATA.cfg.origin.lon], 9);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> / ルート: OSRM' }).addTo(map);
  L.marker([DATA.cfg.origin.lat, DATA.cfg.origin.lon], { bubblingMouseEvents: false }).addTo(map).bindPopup(esc(DATA.cfg.origin.name));
  if (dest) L.marker([dest.lat, dest.lon], { bubblingMouseEvents: false }).addTo(map).bindPopup(esc(dest.name));
  if (tour.route) {
    const latlngs = tour.route.line.map(([lon, lat]) => [lat, lon]);
    // 白い縁取りの上に濃い線を重ね、色の多い地図の上でも浮き上がらせる
    L.polyline(latlngs, { color: '#fff', weight: 12, opacity: 1, bubblingMouseEvents: false }).addTo(map);
    const line = L.polyline(latlngs, { color: keyColor(), weight: 7, opacity: 1, bubblingMouseEvents: false }).addTo(map);
    stops.forEach((s) => markers.set(s.id, L.circleMarker([s.lat, s.lon], { bubblingMouseEvents: false })
      .addTo(map).bindPopup(esc(s.name))));
    map.fitBounds(line.getBounds(), { padding: [16, 16] });
  }
  // 誤操作を防ぐため、目的地の指定は長押し（スマホでは contextmenu として届く）だけにする
  map.on('contextmenu', (e) => {
    buzz();
    tour.custom = { id: 'custom', name: '地図で指定した地点', lat: +e.latlng.lat.toFixed(5), lon: +e.latlng.lng.toFixed(5), waypoints: [] };
    tour.route = null; tour.stops = null; tour.restored = false; tour.picked.clear(); tour.error = ''; saveTour(); renderTouring();
  });
}

// ---- 画面を消さない（ツーリングタブを開いている間だけ） ----
let wake = null;
async function keepAwake(on) {
  try {
    if (on && !wake && 'wakeLock' in navigator) { wake = await navigator.wakeLock.request('screen'); wake.onrelease = () => { wake = null; }; }
    else if (!on && wake) await wake.release();
  } catch { /* 低電力モードなどで断られても動かす */ }
}
document.addEventListener('visibilitychange', () => {
  // Google マップから戻ってきたときに取り直す（切り替え時にブラウザが自動で解除するため）
  if (document.visibilityState === 'visible') keepAwake(state.tab === 'touring' && tour.awake);
});
window.addEventListener('online', () => renderAll());
window.addEventListener('offline', () => renderAll());

// ---- 設定 ----
function renderSettings() {
  setCount(null);
  const has = !!store.get('token');
  $('#view').innerHTML = `<h2>表示</h2>
    <label class="check"><input type="checkbox" id="set-outdoor" ${document.documentElement.hasAttribute('data-outdoor') ? 'checked' : ''}>屋外モード（日なた・グローブ向けに大きく太く表示）</label>
    <p class="hint">画面上の「☀屋外」でも切り替えられます。ツーリングタブを開くと自動でオンになります。</p>
    <h2>好きなジャンル</h2><p class="hint">今週末のおすすめに優先して出します。</p><div id="fav-genres" class="chips" style="flex-wrap:wrap"></div>
    <h2>データの自動更新（管理者向け）</h2>
    <p>GitHub の Fine-grained トークン（対象リポジトリ：このアプリのリポジトリだけ／権限：Actions の Read and write だけ）を貼ってください。トークンはこの端末の中にだけ保存されます。</p>
    <p class="status">状態：${has ? '登録済み' : '未登録'}</p>
    <input id="token" type="password" autocomplete="off" placeholder="github_pat_..." aria-label="GitHub トークン">
    <div class="actions">
      <button type="button" class="btn primary" id="token-save">保存</button>
      <button type="button" class="btn" id="token-del">削除</button>
      <button type="button" class="btn" id="update-now">今すぐ更新</button>
    </div>
    <h2>収集状況</h2>${statusHtml()}`;
  const el = $('#fav-genres');
  el.innerHTML = Object.entries(GENRES).map(([g, l]) => `<button type="button" class="chip" data-g="${g}" aria-pressed="${state.favGenres.has(g)}">${l}</button>`).join('');
  el.onclick = (e) => { const b = e.target.closest('.chip'); if (b) { buzz(); toggle(state.favGenres, b.dataset.g); store.set('favGenres', [...state.favGenres]); renderAll(); } };
  $('#set-outdoor').onchange = (e) => setOutdoor(e.target.checked);
  $('#token-save').onclick = () => { const v = $('#token').value.trim(); if (v) { store.set('token', v); renderSettings(); } };
  $('#token-del').onclick = () => { store.set('token', null); renderSettings(); };
  $('#update-now').onclick = () => { buzz(); requestUpdate(true); };
}

// ---- タブと全体描画 ----
const RENDER = { spots: renderSpots, events: renderEvents, touring: renderTouring, settings: renderSettings };
function goTab(t) {
  // ツーリングタブを開いたら屋外モードを自動でオン（手動で切った後も、次に開いたときは再びオン）
  if (t === 'touring' && state.tab !== 'touring') setOutdoor(true);
  state.tab = t; store.set('tab', t); window.scrollTo(0, 0); renderAll();
}
document.querySelector('.tabs').onclick = (e) => {
  const b = e.target.closest('[data-tab]'); if (!b) return;
  buzz(); goTab(b.dataset.tab);
};
function renderAll() {
  document.body.dataset.tab = state.tab;
  renderFilters(); renderWeather(); renderRecommend(); renderLoadMsg();
  document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === state.tab));
  if (state.tab !== 'spots' && $('#q')) $('#view').innerHTML = ''; // 検索欄は スポット タブ専用
  (RENDER[state.tab] || renderSpots)();
  keepAwake(state.tab === 'touring' && tour.awake);
}

async function init() {
  const outdoor = store.get('outdoor');
  // 初回は端末の「コントラストを上げる」設定に合わせる
  setOutdoor(outdoor ?? matchMedia('(prefers-contrast: more)').matches, outdoor != null);
  if (state.tab === 'touring') setOutdoor(true);
  $('#filters').open = !!store.get('filtersOpen');
  $('#rec').open = store.get('recOpen') !== false;
  DATA.cfg = await getJSON('config.json', null);
  if (!DATA.cfg) { renderLoadMsg(); $('#view').innerHTML = '<p class="empty">config.json を読み込めません。電波の良い場所で開き直してください。</p>'; return; }
  // 先にスポットを出し、イベントなどは後から読み込む
  [DATA.spots, DATA.touring, DATA.status] = await Promise.all([
    getJSON('data/spots.json', []), getJSON('data/touring.json', []), getJSON('data/status.json', null, 'no-store')]);
  renderAll();
  loadWeather();
  requestUpdate();
  [DATA.pois, DATA.events] = await Promise.all([getJSON('data/pois.json', []), getJSON('data/events.json', [])]);
  DATA.eventsLoaded = true; DATA.ver++; tour.stops = null;
  renderAll();
  // 自動収集スポットは大きい（数 MB）ので最後に読み込む
  DATA.osm = await getJSON('data/osm_spots.json', []);
  renderAll();
}
init();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* 非対応でも動く */ });
