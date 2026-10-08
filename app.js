// MyMap 画面ロジック。純粋な計算は lib.js（Lib）に置く。
const GENRES = { play: '🎡遊び', sightseeing: '📷観光', shopping: '🛍買い物', vehicle: '🚗乗り物', museum: '🏛博物館',
  garden: '🌿植物園', temple: '⛩寺社', onsen: '♨温泉', scenic: '🏔絶景' };
const MODES = { train: '🚃電車', car: '🚗車', bike: '🏍バイク', bicycle: '🚲自転車' };
const GMAP_MODE = { train: 'transit', car: 'driving', bike: 'driving', bicycle: 'bicycling' };
const TIMES = [[30, '30分'], [60, '60分'], [90, '90分'], [120, '2時間'], [180, '3時間'], [null, '制限なし']];
const PREFS = ['東京', '神奈川', '埼玉', '千葉', '山梨', 'その他'];
const POI_KIND = { michinoeki: '道の駅', onsen: '温泉', viewpoint: '展望台', waterfall: '滝', peak: '山', gorge: '渓谷', lake: '湖', coast: '海岸' };
const SCENIC_KINDS = ['viewpoint', 'waterfall', 'peak', 'gorge', 'lake', 'coast'];

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('mymap:' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('mymap:' + k, JSON.stringify(v)); } catch { /* 保存できなくても動かす */ } },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel) => document.querySelector(sel);

const saved = store.get('filters') || {};
const state = {
  mode: saved.mode || 'train', maxMin: saved.maxMin === undefined ? 60 : saved.maxMin,
  prefs: new Set(saved.prefs || []), genres: new Set(saved.genres || []),
  rainOverride: null, weatherRainy: false, tab: store.get('tab') || 'spots', period: 'weekend',
  favGenres: new Set(store.get('favGenres') || ['vehicle', 'museum', 'garden', 'temple', 'onsen']),
  favs: new Set(store.get('favs') || []), visited: new Set(store.get('visited') || []),
};
const DATA = { cfg: null, spots: [], pois: [], events: [], status: null, touring: [] };

const rainy = () => (state.rainOverride ?? state.weatherRainy);
const filterState = () => ({ mode: state.mode, maxMin: state.maxMin, prefs: state.prefs, genres: state.genres, rainy: rainy() });
function saveFilters() {
  store.set('filters', { mode: state.mode, maxMin: state.maxMin, prefs: [...state.prefs], genres: [...state.genres] });
}
const icon = (label) => [...label][0]; // 先頭の絵文字（コードポイント単位）
const fmtMin = (m) => (m == null ? '' : m < 60 ? `約${m}分` : `約${Math.floor(m / 60)}時間${m % 60 ? (m % 60) + '分' : ''}`);

async function getJSON(url, fallback) {
  try { const r = await fetch(url, { cache: 'no-store' }); return r.ok ? await r.json() : fallback; } catch { return fallback; }
}

// ---- 絞り込みチップ ----
function chips(el, options, isOn, onClick) {
  el.innerHTML = options.map(([v, label], i) =>
    `<button type="button" class="chip" data-i="${i}" aria-pressed="${isOn(v)}">${esc(label)}</button>`).join('');
  el.onclick = (e) => { const b = e.target.closest('.chip'); if (b) { onClick(options[+b.dataset.i][0]); saveFilters(); renderAll(); } };
}
const toggle = (set, v) => (set.has(v) ? set.delete(v) : set.add(v));
function renderFilters() {
  chips($('#f-mode'), Object.entries(MODES), (v) => v === state.mode, (v) => { state.mode = v; });
  chips($('#f-time'), TIMES, (v) => v === state.maxMin, (v) => { state.maxMin = v; });
  chips($('#f-pref'), PREFS.map((p) => [p, p]), (v) => state.prefs.has(v), (v) => toggle(state.prefs, v));
  chips($('#f-genre'), Object.entries(GENRES), (v) => state.genres.has(v), (v) => toggle(state.genres, v));
}

// ---- スポット ----
function poiAsSpot(p) {
  return { id: `poi:${p.kind}:${p.name}:${p.lat}`, name: p.name, lat: p.lat, lon: p.lon, pref: null,
    genres: SCENIC_KINDS.includes(p.kind) ? ['scenic'] : p.kind === 'onsen' ? ['onsen'] : ['sightseeing'],
    indoor: false, fee: '', parking: null, tags: [], url: p.wikipedia || '', note: POI_KIND[p.kind] || '', poi: true };
}
function spotCandidates() {
  // 絶景を選んだときだけ OSM の絶景 POI を混ぜる（数が多いため）
  const extra = state.genres.has('scenic') ? DATA.pois.filter((p) => SCENIC_KINDS.includes(p.kind)).map(poiAsSpot) : [];
  return DATA.spots.concat(extra);
}
function spotCard(s) {
  const sns = Lib.snsLinks(s);
  const icons = s.genres.map((g) => icon(GENRES[g])).join('');
  const park = s.parking ? [s.parking.car ? '🅿車' : '', s.parking.bike ? '🅿二輪' : ''].filter(Boolean).join(' ') : '';
  return `<article class="card">
    <h3>${icons} ${esc(s.name)}</h3>
    <p class="meta">${s.indoor ? '<span class="badge rain">☔OK</span> ' : ''}${icon(MODES[state.mode])}${fmtMin(s.minutes)}${s.fee ? '・' + esc(s.fee) : ''}${park ? '・' + park : ''}</p>
    ${s.note ? `<p>${esc(s.note)}</p>` : ''}
    <div class="actions">
      <a class="btn" href="${esc(Lib.gmapsDirUrl(DATA.cfg.origin, s, [], GMAP_MODE[state.mode]))}" target="_blank" rel="noopener">地図で経路</a>
      ${s.poi ? '' : `<a class="btn" href="${esc(sns.instagram)}" target="_blank" rel="noopener">#Instagram</a>
      <a class="btn" href="${esc(sns.x)}" target="_blank" rel="noopener">#X</a>`}
      ${s.url ? `<a class="btn" href="${esc(s.url)}" target="_blank" rel="noopener">${s.poi ? 'Wikipedia' : '公式'}</a>` : ''}
      ${s.poi ? '' : `<button type="button" class="icon" data-fav="${esc(s.id)}" aria-pressed="${state.favs.has(s.id)}" aria-label="お気に入り">⭐</button>
      <button type="button" class="icon" data-visited="${esc(s.id)}" aria-pressed="${state.visited.has(s.id)}">✓行った</button>`}
    </div></article>`;
}
function renderSpots() {
  const list = Lib.filterSpots(spotCandidates(), filterState(), DATA.cfg);
  const head = `<p class="status">${list.length}件${rainy() ? '（雨の日モード：屋内のみ）' : ''}</p>`;
  // ponytail: 全件描画。数千件で重くなったら先頭 N 件＋「もっと見る」にする
  $('#view').innerHTML = head + (list.length ? list.slice(0, 300).map(spotCard).join('') : '<p class="empty">条件に合うスポットがありません。条件を広げてみてください。</p>');
}
document.addEventListener('click', (e) => {
  const fav = e.target.closest('[data-fav]'), vis = e.target.closest('[data-visited]');
  if (fav) { toggle(state.favs, fav.dataset.fav); store.set('favs', [...state.favs]); fav.setAttribute('aria-pressed', state.favs.has(fav.dataset.fav)); }
  if (vis) { toggle(state.visited, vis.dataset.visited); store.set('visited', [...state.visited]); vis.setAttribute('aria-pressed', state.visited.has(vis.dataset.visited)); }
});

// ---- 今週末のおすすめ ----
function renderRecommend() {
  const cands = Lib.filterSpots(DATA.spots, { ...filterState(), genres: new Set() }, DATA.cfg);
  const ctx = { favGenres: state.favGenres, rainy: rainy(), visited: state.visited };
  const rec = Lib.pickRecommendations(cands, ctx, Lib.weekSeed(new Date()));
  $('#recommend').innerHTML = rec.length
    ? `<h2>今週末のおすすめ</h2><div class="cards">${rec.map(spotCard).join('')}</div>` : '';
}

// ---- 天気（Open-Meteo, 登録不要） ----
async function loadWeather() {
  const { lat, lon } = DATA.cfg.origin;
  const btn = $('#weather');
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=precipitation_probability_max&timezone=Asia%2FTokyo&forecast_days=10`);
    const j = await r.json();
    const [sat, sun] = Lib.weekend(new Date());
    const pick = (d) => j.daily.precipitation_probability_max[j.daily.time.indexOf(d)];
    const ps = [['土', pick(sat)], ['日', pick(sun)]].filter(([, p]) => p != null);
    state.weatherRainy = ps.some(([, p]) => p >= DATA.cfg.rainThreshold);
    btn.dataset.text = ps.map(([d, p]) => `${d}${p >= DATA.cfg.rainThreshold ? '☔' : '☀'}${p}%`).join(' ');
  } catch {
    btn.dataset.text = '天気を取得できません';
  }
  renderAll();
}
function renderWeather() {
  const btn = $('#weather');
  btn.textContent = `${btn.dataset.text || '天気を確認中…'} ${rainy() ? '雨の日モードON' : ''}`;
  btn.setAttribute('aria-pressed', rainy());
}
$('#weather').onclick = () => { state.rainOverride = !rainy(); renderAll(); };

// ---- イベント ----
const PERIODS = [['weekend', '今週末'], ['next', '来週末'], ['month', '今月'], ['3m', '3か月']];
const fmtDate = (d) => { const [, m, day] = d.split('-'); return `${+m}/${+day}`; };
function eventCard(e) {
  const when = e.start === e.end ? fmtDate(e.start) : `${fmtDate(e.start)}〜${fmtDate(e.end)}`;
  const inout = e.indoor === true ? '<span class="badge rain">☔屋内</span> ' : e.indoor == null ? '<span class="badge">?</span> ' : '';
  return `<article class="card">
    <p class="meta">${inout}${esc(when)}${e.minutes != null ? '・' + icon(MODES[state.mode]) + fmtMin(e.minutes) : '・位置不明'}</p>
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
    `<li>${old(s.ok_at) || s.error ? '<span class="badge warn">⚠</span>' : ''}${esc(id)}: ${s.ok_at ? esc(s.ok_at.slice(0, 16).replace('T', ' ')) : '未取得'}（${s.count}件）</li>`).join('');
  return `<details class="status"><summary>最終更新 ${esc(st.updated_at.slice(0, 16).replace('T', ' '))}</summary><ul>${rows}</ul></details>`;
}
function renderEvents() {
  const [from, to] = Lib.periodRange(state.period, new Date());
  const list = Lib.filterEvents(DATA.events, filterState(), DATA.cfg, from, to);
  $('#view').innerHTML = `<div id="periods" class="chips"></div>
    <p class="status">${list.length}件${rainy() ? '（雨の日モード：屋外を除外、?は屋内外不明）' : ''}</p>
    ${list.length ? list.slice(0, 300).map(eventCard).join('') : '<p class="empty">この期間・条件のイベントはありません。</p>'}
    ${statusHtml()}`;
  chips($('#periods'), PERIODS, (v) => v === state.period, (v) => { state.period = v; });
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
    const st = await getJSON('data/status.json', null);
    if (st && st.updated_at && st.updated_at !== prev) {
      DATA.status = st;
      [DATA.events, DATA.pois] = await Promise.all([getJSON('data/events.json', DATA.events), getJSON('data/pois.json', DATA.pois)]);
      setUpdateMsg(''); renderAll(); return;
    }
  }
  setUpdateMsg('更新に時間がかかっています。しばらくしてから開き直してください。');
}

// ---- 設定 ----
function renderSettings() {
  const has = !!store.get('token');
  $('#view').innerHTML = `<h2>好きなジャンル</h2><div id="fav-genres" class="chips" style="flex-wrap:wrap"></div>
    <h2>データの自動更新</h2>
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
  el.onclick = (e) => { const b = e.target.closest('.chip'); if (b) { toggle(state.favGenres, b.dataset.g); store.set('favGenres', [...state.favGenres]); renderAll(); } };
  $('#token-save').onclick = () => { const v = $('#token').value.trim(); if (v) { store.set('token', v); renderSettings(); } };
  $('#token-del').onclick = () => { store.set('token', null); renderSettings(); };
  $('#update-now').onclick = () => requestUpdate(true);
}

// ---- タブと全体描画 ----
const RENDER = { spots: renderSpots, events: renderEvents, settings: renderSettings };
document.querySelector('.tabs').onclick = (e) => {
  const b = e.target.closest('[data-tab]'); if (!b) return;
  state.tab = b.dataset.tab; store.set('tab', state.tab); renderAll();
};
function renderAll() {
  renderFilters(); renderWeather(); renderRecommend();
  document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === state.tab));
  (RENDER[state.tab] || renderSpots)();
}

async function init() {
  DATA.cfg = await getJSON('config.json', null);
  if (!DATA.cfg) { $('#view').innerHTML = '<p class="empty">config.json を読み込めません。</p>'; return; }
  [DATA.spots, DATA.pois, DATA.events, DATA.touring, DATA.status] = await Promise.all([
    getJSON('data/spots.json', []), getJSON('data/pois.json', []), getJSON('data/events.json', []),
    getJSON('data/touring.json', []), getJSON('data/status.json', null)]);
  renderAll();
  loadWeather();
  requestUpdate();
}
init();
