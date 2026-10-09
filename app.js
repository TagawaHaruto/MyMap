// MyMap 画面ロジック。純粋な計算は lib.js（Lib）に置く。
const GENRES = { play: '🎡遊び', sightseeing: '📷観光', shopping: '🛍買い物', vehicle: '🚗乗り物', museum: '🏛博物館',
  garden: '🌿植物園', temple: '⛩寺社', onsen: '♨温泉', scenic: '🏔絶景', simulator: '🎮シミュレーター', factory: '🏭工場見学', experience: '🎨体験',
  food: '🍴グルメ', heritage: '🏯史跡', lodging: '🏨宿', souvenir: '🛍お土産・直売', outdoor: '⚽遊び・アウトドア' };
// これらのジャンルは件数が多いので、升目ごとのファイルを選んだときだけ読み込む（data/cells/<グループ>/<升目>.json）
const GROUP_OF = { food: 'food', heritage: 'heritage', lodging: 'heritage', souvenir: 'local', outdoor: 'local' };
const MODES = { train: '🚃電車', car: '🚗車', bike: '🏍バイク', bicycle: '🚲自転車' };
const GMAP_MODE = { train: 'transit', car: 'driving', bike: 'driving', bicycle: 'bicycling' };
const TIMES = [[30, '30分'], [60, '60分'], [90, '90分'], [120, '2時間'], [180, '3時間'], [240, '4時間'], [300, '5時間'], [null, '制限なし']];
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
// AbortSignal.timeout が無い古い iPhone（iOS 15 以前）でも時間切れを扱えるようにする
const timeoutSignal = (ms) => {
  if (AbortSignal.timeout) return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(new DOMException('timeout', 'TimeoutError')), ms);
  return c.signal;
};
const buzz = () => { try { navigator.vibrate?.(15); } catch { /* 振動できない端末は無視 */ } };

const saved = store.get('filters') || {};
const state = {
  mode: saved.mode || 'train', maxMin: saved.maxMin === undefined ? 60 : saved.maxMin,
  prefs: new Set(saved.prefs || []), genres: new Set(saved.genres || []), dirs: new Set(saved.dirs || []),
  q: '', limit: 300, rainOverride: null, weatherRainy: false, tab: store.get('tab') || 'spots', period: 'weekend',
  showNotices: false, showChains: false, walkinOnly: false,
  favGenres: new Set(store.get('favGenres') || ['vehicle', 'museum', 'garden', 'temple', 'onsen']),
  favs: new Set(store.get('favs') || []), visited: new Set(store.get('visited') || []),
};
const DATA = { cfg: null, spots: [], osm: [], pois: [], events: [], status: null, touring: [], roads: [], ver: 0, eventsLoaded: false, osmLoaded: false };
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
  const cb = $('#set-outdoor'); if (cb) cb.checked = on;
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
let poiSpots = null, poiVer = -1;
function poiSpotList() {
  if (poiVer !== DATA.ver) { poiSpots = DATA.pois.map(poiAsSpot); poiVer = DATA.ver; }
  return poiSpots;
}
// ---- 升目ごとのデータ（飲食・史跡・宿・お土産・遊び） ----
const CELL_DATA = new Map(); // 'グループ/升目' → 項目
const cellLoading = new Set();
let cellIndex = null;
// 読み込む範囲（km）: 移動時間から求めた半径。制限なしは 60km まで
function loadKm() {
  if (state.maxMin == null) return 60;
  const min = state.maxMin - (state.mode === 'train' ? DATA.cfg.trainOverheadMin : 0);
  return Math.min(DATA.cfg.poiRadiusKm, Math.max(0, min) / 60 * DATA.cfg.speedsKmh[state.mode] + 2);
}
async function ensureCells(groups, center, km) {
  if (!cellIndex) return false;
  const need = [];
  for (const g of groups) {
    for (const cid of Lib.cellsInRadius(center, km)) {
      const key = `${g}/${cid}`;
      if (cellIndex[g] && cellIndex[g][cid] && !CELL_DATA.has(key) && !cellLoading.has(key)) need.push(key);
    }
  }
  if (!need.length) return false;
  need.forEach((k) => cellLoading.add(k));
  await Promise.all(need.map(async (k) => { CELL_DATA.set(k, await getJSON(`data/cells/${k}.json`, [])); cellLoading.delete(k); }));
  return true;
}
function cellItems(groups, center, km) {
  const out = [];
  for (const g of groups) for (const cid of Lib.cellsInRadius(center, km)) { const xs = CELL_DATA.get(`${g}/${cid}`); if (xs) out.push(...xs); }
  return out;
}
const selectedGroups = () => [...new Set([...state.genres].map((g) => GROUP_OF[g]).filter(Boolean))];

function spotCandidates() {
  // 絶景を選んだときだけ滝・山・湖などの POI を混ぜる（展望台は osm_spots 側にある）
  const extra = state.genres.has('scenic')
    ? poiSpotList().filter((p) => SCENIC_KINDS.includes(p.kind) && p.kind !== 'viewpoint') : [];
  // グルメなどは、そのジャンルを選んだときだけ（「全種類」には混ぜない）
  const groups = selectedGroups();
  let cellsPart = [];
  if (groups.length) {
    ensureCells(groups, DATA.cfg.origin, loadKm()).then((changed) => { if (changed && state.tab === 'spots') renderSpotList(); });
    cellsPart = cellItems(groups, DATA.cfg.origin, loadKm());
  }
  let all = DATA.spots.concat(DATA.osm, extra, cellsPart);
  if (!state.showChains) all = all.filter((s) => !s.chain);
  if (state.walkinOnly && (state.genres.has('factory') || state.genres.has('experience'))) all = all.filter((s) => s.walkin === true);
  return all;
}
const isCurated = (s) => !s.poi && !String(s.id).startsWith('osm:');
const parkText = (s) => (s.parking ? [s.parking.car ? '🅿車' : '', s.parking.bike ? '🅿二輪' : ''].filter(Boolean).join(' ') : '');
function spotCard(s) {
  const sns = Lib.snsLinks(s);
  const icons = s.genres.map((g) => icon(GENRES[g] || '・')).join('');
  const park = parkText(s);
  // 一覧では名前・時間・短い説明だけ。ボタン類と写真は「▼詳しく」を押してから（1 画面にたくさん並べるため）
  return `<article class="card spot">
    <div class="spot-head"><h3>${isCurated(s) ? '<span title="厳選スポット">★</span> ' : ''}${icons} ${esc(s.name)}</h3>
      <div class="head-btns">${infoButton(s)}${s.poi ? '' : `<button type="button" class="icon fav" data-fav="${esc(s.id)}" aria-pressed="${state.favs.has(s.id)}" aria-label="お気に入り">⭐</button>`}</div></div>
    <p class="meta">${s.indoor ? '<span class="badge rain">☔雨OK</span> ' : ''}${icon(MODES[state.mode])}<strong>${fmtMin(s.minutes)}</strong>${s.fee ? '・' + esc(s.fee) : ''}${park ? '・' + park : ''}${state.visited.has(s.id) ? '・✓行った' : ''}${'walkin' in s ? (s.walkin ? '・<strong>当日参加OK</strong>' : '・要予約') : ''}</p>
    ${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}
    <div class="info" hidden>
      <div class="actions">
        <a class="btn" href="${esc(Lib.gmapsDirUrl(DATA.cfg.origin, s, [], GMAP_MODE[state.mode]))}" target="_blank" rel="noopener">地図で経路</a>
        ${s.poi ? '' : `<a class="btn" href="${esc(sns.instagram)}" target="_blank" rel="noopener">#Instagram</a>
        <a class="btn" href="${esc(sns.x)}" target="_blank" rel="noopener">#X</a>`}
        ${s.url ? `<a class="btn" href="${esc(s.url)}" target="_blank" rel="noopener">${s.url.includes('wikipedia.org') ? 'Wikipedia' : '公式'}</a>` : ''}
        ${s.poi ? '' : `<button type="button" class="icon" data-visited="${esc(s.id)}" aria-pressed="${state.visited.has(s.id)}">行った</button>`}
      </div>
      <div class="info-body"></div>
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
    const all = DATA.spots.concat(DATA.osm, poiSpotList());
    const hits = Lib.searchSpots(all, state.q, DATA.cfg, state.favs, state.mode);
    setCount(null);
    box.innerHTML = `<p class="status">「${esc(state.q.trim())}」の検索結果 ${hits.length}件（絞り込み条件を外して検索・上位50件）</p>`
      + (hits.length ? hits.map(spotCard).join('') : '<p class="empty">見つかりませんでした。ひらがなや別の呼び方でも試してください。</p>');
    return;
  }
  const list = Lib.filterSpots(spotCandidates(), filterState(), DATA.cfg);
  setCount(list.length);
  const failed = FAILED.has('data/spots.json');
  const groups = selectedGroups();
  const toggles = [
    (state.genres.has('factory') || state.genres.has('experience')) ? `<button type="button" class="chip" id="t-walkin" aria-pressed="${state.walkinOnly}">当日参加OKだけ</button>` : '',
    groups.includes('food') ? `<button type="button" class="chip" id="t-chain" aria-pressed="${state.showChains}">チェーン店も表示</button>` : '',
  ].join('');
  const loadingCells = groups.length && cellLoading.size ? '・データを読み込み中…' : '';
  const noCells = groups.length && !cellIndex ? '・グルメなどのデータはまだ収集されていません' : '';
  const head = `<p class="status">${list.length.toLocaleString()}件・★厳選と⭐を先頭に表示${rainy() ? '（雨の日モード：屋内のみ）' : ''}${groups.length && state.maxMin == null ? '・グルメなどは起点から60km以内' : ''}${loadingCells}${noCells}</p>
    ${toggles ? `<div class="chips wrap">${toggles}</div>` : ''}`;
  const more = list.length > state.limit ? `<button type="button" class="btn" id="more">もっと見る（残り${(list.length - state.limit).toLocaleString()}件）</button>` : '';
  box.innerHTML = head + (list.length ? list.slice(0, state.limit).map(spotCard).join('') + more
    : `<p class="empty">${failed ? 'スポットのデータを読み込めていません。電波の良い場所で開き直してください。'
      : !DATA.osmLoaded ? 'スポットを読み込み中…' : '条件に合うスポットがありません。条件を広げてみてください。'}</p>`);
  if (more) $('#more').onclick = () => { state.limit += 300; renderSpotList(); };
  const tw = $('#t-walkin'); if (tw) tw.onclick = () => { buzz(); state.walkinOnly = !state.walkinOnly; renderSpotList(); };
  const tc = $('#t-chain'); if (tc) tc.onclick = () => { buzz(); state.showChains = !state.showChains; renderSpotList(); };
}
// ---- スポットの説明と写真（Wikipedia の要約、なければ Wikimedia Commons の付近の写真） ----
const INFO_ITEMS = new Map(); // 画面に出ている id → スポット
const INFO_CACHE_MAX = 200;
function infoButton(s) {
  INFO_ITEMS.set(s.id, s);
  return `<button type="button" class="btn info-btn" data-info="${esc(s.id)}" aria-expanded="false">▼詳しく</button>`;
}
function infoCache() { return store.get('info') || {}; }
function saveInfo(id, v) {
  const all = infoCache();
  all[id] = { ...v, at: Date.now() };
  // 古いものから消して、端末の保存領域を使いすぎない
  const keys = Object.keys(all).sort((a, b) => all[a].at - all[b].at);
  for (const k of keys.slice(0, Math.max(0, keys.length - INFO_CACHE_MAX))) delete all[k];
  store.set('info', all);
}
async function fetchJSON(url) {
  const r = await fetch(url, { signal: timeoutSignal(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function loadInfo(s) {
  const cached = infoCache()[s.id];
  if (cached) return cached;
  const ref = Lib.wikiRef(s);
  let summary = null, photos = [], failed = false;
  if (ref) {
    try { summary = Lib.parseSummary(await fetchJSON(Lib.summaryUrl(ref))); } catch (err) { if (!/HTTP 404/.test(err.message)) failed = true; }
  }
  if (!summary || !summary.thumb) {
    try { photos = Lib.parseCommons(await fetchJSON(Lib.commonsNearbyUrl(s.lat, s.lon, 300, 3))); } catch { failed = true; }
  }
  const v = { summary, photos };
  if (!failed) saveInfo(s.id, v); // 圏外などで取れなかったときは保存しない（次に開いたときに取り直す）
  return { ...v, failed };
}
// 地図の吹き出し: 名前・距離・写真 1 枚・説明・立ち寄りの追加ボタン
function popupHtml(s, v) {
  const picked = tour.picked.has(s.id);
  const img = v && v.summary && v.summary.thumb ? { src: v.summary.thumb, credit: '写真: Wikipedia', page: v.summary.page }
    : v && v.photos && v.photos.length ? { src: v.photos[0].thumb, credit: `付近の写真${v.photos[0].artist ? '・撮影: ' + v.photos[0].artist : ''}（${v.photos[0].license || 'ライセンスはリンク先'}）`, page: v.photos[0].page } : null;
  const text = v && v.summary ? v.summary.text : s.note || '';
  return `<div class="pop">
    <strong>${s.genres.map((g) => icon(GENRES[g] || '・')).join('')} ${esc(s.name)}</strong>
    <div class="pop-sub">${s.alongKm != null ? `${Math.round(s.alongKm)}km地点・道から${s.offKm.toFixed(1)}km` : ''}${parkText(s) ? '・' + parkText(s) : ''}</div>
    ${img ? `<a href="${esc(img.page)}" target="_blank" rel="noopener"><img class="pop-img" src="${esc(img.src)}" alt="${esc(s.name)}の写真"></a><div class="credit">${esc(img.credit)}</div>` : ''}
    ${text ? `<p>${esc(text)}</p>` : ''}
    ${!v ? '<p class="hint">写真と説明を読み込み中…</p>' : v.failed ? '<p class="hint">写真と説明を読み込めませんでした（圏外の可能性）。</p>' : ''}
    ${v && v.summary && v.summary.page ? `<div class="credit">出典: <a href="${esc(v.summary.page)}" target="_blank" rel="noopener">Wikipedia</a></div>` : ''}
    <a class="btn" href="${esc(Lib.gmapsSearchUrl(s))}" target="_blank" rel="noopener">Googleマップで写真・口コミを見る</a>
    <button type="button" class="btn ${picked ? '' : 'primary'} pop-pick" data-popup-pick="${esc(s.id)}">${picked ? '立ち寄りから外す' : '立ち寄りに追加'}</button>
  </div>`;
}
// 画像が読み込まれて吹き出しの大きさが変わったら、地図の中に収め直す
function refitPopup(m) {
  const el = m.getPopup() && m.getPopup().getElement();
  if (!el) return;
  // 大きさが変わったら吹き出しが地図の中（上のボタンより下）に収まるよう地図を動かす
  const fit = () => { const p = m.getPopup(); p.update(); if (p._adjustPan) p._adjustPan(); };
  el.querySelectorAll('img').forEach((im) => { if (!im.complete) im.addEventListener('load', fit, { once: true }); });
  fit();
}
// 立ち寄りの選択を切り替える（一覧のチェックと地図の吹き出しの両方から使う）
function togglePick(id, on) {
  if (on && !tour.picked.has(id) && pickedCount() >= room()) return false;
  on ? tour.picked.add(id) : tour.picked.delete(id);
  const cb = document.querySelector(`[data-stop="${CSS.escape(id)}"]`);
  if (cb) cb.checked = on;
  saveTour(); updateTourSelection();
  return true;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-popup-pick]'); if (!b) return;
  buzz();
  const id = b.dataset.popupPick, on = !tour.picked.has(id);
  if (!togglePick(id, on)) { b.textContent = `立ち寄りは${room()}件までです`; return; }
  const m = markers.get(id), s = getStops().find((x) => x.id === id);
  if (m && s) { m.setPopupContent(popupHtml(s, infoCache()[id] || { summary: null, photos: [] })); refitPopup(m); }
});

// 似たスポット・周辺のスポット・近くのカフェ・食事（近くの升目の飲食データも読み込む）
async function fillRelated(el, s) {
  const draw = () => {
    const pool = DATA.spots.concat(DATA.osm, poiSpotList(), cellItems(['food', 'heritage', 'local'], s, 2));
    const rel = Lib.relatedSpots(s, pool, { limit: 5, chains: state.showChains });
    const list = (title, xs) => (xs.length ? `<h4>${title}</h4><ul class="rel">${xs.map((x) => `<li>
      <a href="${esc(Lib.gmapsSearchUrl(x))}" target="_blank" rel="noopener">${(x.genres || []).map((g) => icon(GENRES[g] || '・')).join('')} ${esc(x.name)}</a>
      <span class="status">${x.distKm < 1 ? Math.round(x.distKm * 1000) + 'm' : x.distKm.toFixed(1) + 'km'}${x.note ? '・' + esc(x.note) : ''}</span></li>`).join('')}</ul>` : '');
    el.innerHTML = list('似たスポット', rel.similar) + list('周辺のスポット（2km以内）', rel.nearby)
      + list('近くのカフェ・食事（1km以内）', rel.food)
      + (!rel.food.length && cellIndex ? '<p class="hint">1km以内のカフェ・食事は見つかりませんでした。</p>' : '')
      + (!cellIndex ? '<p class="hint">カフェ・食事のデータはまだ収集されていません。</p>' : '');
  };
  draw();
  if (await ensureCells(['food', 'heritage', 'local'], s, 2)) draw();
}

function infoHtml(s, v) {
  const parts = [];
  if (v.summary) {
    if (v.summary.thumb) parts.push(`<img class="info-img" src="${esc(v.summary.thumb)}" alt="${esc(s.name)}の写真" loading="lazy">`);
    parts.push(`<p>${esc(v.summary.text)}</p>`);
    if (v.summary.page) parts.push(`<p class="credit">出典: <a href="${esc(v.summary.page)}" target="_blank" rel="noopener">Wikipedia</a>（文章 CC BY-SA）${v.summary.thumb ? '・写真は記事のページで撮影者とライセンスを確認できます' : ''}</p>`);
  } else if (!isCurated(s)) {
    parts.push('<p class="hint">この場所の説明はまだありません。</p>');
  }
  if (v.photos && v.photos.length) {
    parts.push(`<p class="credit"><strong>付近の写真</strong>（約300m以内で撮られたもの。関係のない写真が含まれることがあります）</p><div class="photos">`
      + v.photos.map((p) => `<a href="${esc(p.page)}" target="_blank" rel="noopener"><img src="${esc(p.thumb)}" alt="付近の写真" loading="lazy">
        <span class="credit">${p.artist ? '撮影: ' + esc(p.artist) + ' / ' : ''}${esc(p.license) || 'ライセンスはリンク先'}</span></a>`).join('') + '</div>');
  } else if (!(v.summary && v.summary.thumb)) {
    parts.push('<p class="hint">写真は見つかりませんでした。</p>');
  }
  if (v.failed) parts.push('<p class="hint">一部を読み込めませんでした（圏外の可能性があります）。電波の良い場所でもう一度開いてください。</p>');
  parts.push(`<div class="actions"><a class="btn" href="${esc(Lib.gmapsSearchUrl(s))}" target="_blank" rel="noopener">Googleマップで写真・口コミを見る</a></div>`);
  return parts.join('');
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-info]'); if (!b) return;
  e.preventDefault(); // 立ち寄りの行（label）の中でもチェックを切り替えない
  buzz();
  const box = b.closest('article.card') ? b.closest('article.card').querySelector('.info') : b.closest('.stop').nextElementSibling;
  const open = b.getAttribute('aria-expanded') !== 'true';
  b.setAttribute('aria-expanded', open);
  b.textContent = open ? '▲閉じる' : '▼詳しく';
  box.hidden = !open;
  if (!open || box.dataset.loaded) return;
  const s = INFO_ITEMS.get(b.dataset.info); if (!s) return;
  const body = box.querySelector('.info-body') || box; // スポットのカードはボタン類を残して、写真と説明だけ入れる
  body.innerHTML = '<p class="hint">読み込み中…</p>';
  const v = await loadInfo(s);
  body.innerHTML = infoHtml(s, v) + `${s.booking ? `<p class="hint">予約: ${esc(s.booking)}</p>` : ''}<div class="related"></div>`;
  if (!v.failed) box.dataset.loaded = '1';
  fillRelated(body.querySelector('.related'), s);
});
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
      { signal: timeoutSignal(8000) });
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
  btn.innerHTML = `${esc(btn.dataset.text || '天気を確認中…')}${rainy() ? '<br>☔雨の日モード' : ''}`;
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
  if (!st || !st.updated_at) return `<p class="status">${FAILED.has('data/status.json') ? '収集状況を読み込めませんでした。' : 'イベントはまだ収集されていません。'}</p>`;
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
  const sortBy = ['month', '3m'].includes(state.period) ? 'date' : 'relevance';
  const list = Lib.filterEvents(DATA.events, { ...filterState(), sortBy }, DATA.cfg, from, to);
  const all = Lib.filterEvents(DATA.events, { ...filterState(), sortBy, exclude: null }, DATA.cfg, from, to).length;
  const evFailed = FAILED.has('data/events.json');
  const hidden = all - list.length;
  setCount(list.length);
  $('#view').innerHTML = `<div id="periods" class="chips"></div>
    <p class="status">${list.length}件・${sortBy === 'date' ? '開始日の早い順（開催中の長期展示は最後）' : 'その日だけ／短期のものを先頭に表示'}${rainy() ? '（雨の日モード：屋外を除外）' : ''}${list.length > 300 ? '・先頭300件を表示' : ''}</p>
    ${hidden || state.showNotices ? `<button type="button" class="btn" id="notices">${state.showNotices ? '募集・講座などの告知を隠す' : `募集・講座などの告知${hidden}件を非表示中（表示する）`}</button>` : ''}
    ${list.length ? list.slice(0, 300).map((e) => eventCard(e, from)).join('')
      : `<p class="empty">${evFailed ? 'イベントのデータを読み込めませんでした。電波の良い場所で開き直してください。' : 'この期間・条件のイベントはありません。'}</p>`}
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

// ---- ツーリング（ルート：Valhalla・OSRM の公開サーバー／地図：OSM。どれも登録不要） ----
const savedTour = store.get('tour') || {};
const tour = { destId: savedTour.destId || null, custom: savedTour.custom || null, roadId: savedTour.roadId || null,
  opts: { noToll: false, fewHighways: !!savedTour.avoid, bike: false, ...(savedTour.opts || {}) }, radius: savedTour.radius || 3,
  cands: savedTour.cands || (savedTour.route ? [{ ...savedTour.route, label: 'ルート' }] : null), sel: savedTour.sel || 0,
  picked: new Set(savedTour.picked || []), error: '', busy: false, awake: store.get('awake') !== false, stops: null, key: '' };
tour.restored = !!tour.cands;
Object.defineProperty(tour, 'route', { get: () => (tour.cands && tour.cands[tour.sel]) || null });
let map = null, markers = new Map();
const saveTour = () => store.set('tour', { destId: tour.destId, custom: tour.custom, roadId: tour.roadId, opts: tour.opts, radius: tour.radius,
  cands: tour.cands, sel: tour.sel, picked: [...tour.picked] });
const keyColor = () => getComputedStyle(document.documentElement).getPropertyValue('--key').trim() || '#0017c1';
const fail = (msg) => Object.assign(new Error(msg), { mine: true });
const roadById = (id) => DATA.roads.find((r) => r.id === id) || null;
const thisMonth = () => new Date().getMonth() + 1;

async function getRoute(url, init) {
  try { return await fetch(url, { ...init, signal: timeoutSignal(15000) }); } catch (err) {
    // 圏外・時間切れはブラウザごとに英語の文言が違うので、ここで日本語にそろえる
    throw fail(err.name === 'TimeoutError' || err.name === 'AbortError'
      ? 'ルートサーバーから時間内に応答がありませんでした。電波の良い場所で再検索してください。'
      : '通信できませんでした（圏外の可能性があります）。電波の良い場所で再検索してください。');
  }
}

// Valhalla（FOSSGIS の公開サーバー）: 有料道路の回避・高速の好み・バイク向け・別ルート候補に対応
async function valhalla(points, opts, alternates = 0) {
  const costing = opts.bike ? 'motorcycle' : 'auto';
  const co = { use_tolls: opts.noToll ? 0 : 0.5, use_highways: opts.fewHighways ? 0 : 1, ...(opts.bike ? { use_trails: 0.8 } : {}) };
  const body = { locations: points.map((p, i) => ({ lat: p.lat, lon: p.lon, type: i === 0 || i === points.length - 1 ? 'break' : 'through' })),
    costing, costing_options: { [costing]: co }, directions_type: 'none', units: 'kilometers', ...(alternates ? { alternates } : {}) };
  const r = await getRoute('https://valhalla1.openstreetmap.de/route', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  if (r.status === 429) throw fail('ルートサーバーが混雑しています。少し待ってから再検索してください。');
  if (r.status >= 500) throw fail(`ルートサーバーが一時的に使えません（${r.status}）。`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.trip) throw fail('この地点までのルートが見つかりませんでした。');
  const toRoute = (trip) => ({
    line: trip.legs.flatMap((leg, i) => Lib.decodePolyline(leg.shape, 6).slice(i ? 1 : 0)),
    km: trip.summary.length, min: trip.summary.time / 60, toll: !!trip.summary.has_toll, highway: !!trip.summary.has_highway, engine: 'Valhalla' });
  return [toRoute(j.trip), ...(j.alternates || []).map((a) => toRoute(a.trip))];
}

// OSRM（予備）: 回避の指定はできない
async function osrm(points) {
  const r = await getRoute(`https://router.project-osrm.org/route/v1/driving/${points.map((p) => `${p.lon},${p.lat}`).join(';')}?overview=full&geometries=geojson`);
  if (r.status === 429) throw fail('ルートサーバーが混雑しています。少し待ってから再検索してください。');
  if (r.status >= 500) throw fail(`ルートサーバーが一時的に使えません（${r.status}）。時間をおいて再検索してください。`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.code !== 'Ok' || !j.routes || !j.routes.length) throw fail('この地点までの車のルートが見つかりませんでした。');
  const rt = j.routes[0];
  return { line: rt.geometry.coordinates, km: rt.distance / 1000, min: rt.duration / 60, toll: null, highway: null, engine: 'OSRM' };
}

// 景色の地点（展望台・湖・滝・渓谷・海岸）
let scenicPts = null, scenicVer = -1;
function scenicPoints() {
  if (scenicVer !== DATA.ver) { scenicPts = DATA.pois.filter((p) => SCENIC_KINDS.includes(p.kind) && p.kind !== 'peak'); scenicVer = DATA.ver; }
  return scenicPts;
}

// 1 回の検索で候補を最大 4 本作る: 標準（＋別ルート）、おすすめの道を寄り道として通すもの
// Google マップに道をそのまま通らせるための地点（入口・途中・出口。最大 4 点）
const roadFix = (points) => (points.length <= 4 ? points
  : [points[0], points[Math.round((points.length - 1) / 3)], points[Math.round(2 * (points.length - 1) / 3)], points[points.length - 1]])
  .map(([lat, lon]) => ({ lat, lon }));

// 1 回の検索で候補を最大 5 本作る: 標準（＋別ルート）、コースの経由地なし、おすすめの道を寄り道として通すもの
async function fetchCandidates(dest) {
  const o = DATA.cfg.origin, optsKey = JSON.stringify(tour.opts);
  const course = (dest.waypoints || []).map(([lat, lon]) => ({ lat, lon }));
  const main = dest.loop ? Lib.loopPoints(o, dest.road) : [o, ...course, dest];
  const baseFix = dest.loop ? roadFix(dest.road.points) : course;
  const pause = () => new Promise((ok) => setTimeout(ok, 800)); // 公開サーバーへの配慮
  const out = [];
  let note = '';
  try {
    const std = await valhalla(main, tour.opts, main.length === 2 ? 2 : 0);
    const baseLabel = dest.loop ? `${dest.road.name}を周回` : course.length ? 'おすすめのコース' : '標準';
    std.forEach((rt, i) => out.push({ ...rt, label: i ? `別ルート${i}` : baseLabel, via: dest.loop ? [dest.road.id] : [], fixed: i ? [] : baseFix }));
    if (!dest.loop) {
      if (course.length) {
        // コースの経由地がある目的地でも、経由地なしの候補と比べられるように
        await pause();
        try {
          (await valhalla([o, dest], tour.opts, 1)).forEach((rt, i) => out.push({ ...rt, label: i ? '経由地なしの別ルート' : '経由地なし', via: [], fixed: [] }));
        } catch { /* 取れなくてもコースは出す */ }
      }
      // 「有料道路を使わない」なら、絞り込む前に有料の道を外す（上位 2 本が有料で候補が 0 にならないように）
      const roads = tour.opts.noToll ? DATA.roads.filter((r) => !r.toll) : DATA.roads;
      for (const d of Lib.detourRoads(o, dest, roads, 1.6, 2)) {
        await pause();
        try {
          const [rt] = await valhalla([o, ...d.points.map(([lat, lon]) => ({ lat, lon })), dest], tour.opts);
          out.push({ ...rt, label: `${d.road.name}経由`, via: [d.road.id], fixed: roadFix(d.points) });
        } catch { /* 寄り道ルートが取れなくても標準ルートは出す */ }
      }
    }
  } catch (err) {
    // 端末が圏外のときだけ止める。サーバー停止・混雑・時間切れなどは予備の OSRM を試す（それも失敗したらその理由を出す）
    if (navigator.onLine === false) throw err;
    out.push({ ...(await osrm(main)), label: dest.loop ? `${dest.road.name}を周回` : '標準', via: dest.loop ? [dest.road.id] : [], fixed: baseFix });
    note = 'メインのルートサーバーが使えなかったため、予備のサーバーで 1 本だけ表示しています（有料道路の回避などは効きません）。';
  }
  // ほぼ同じルートは 1 本にまとめる
  let uniq = out.filter((c, i) => !out.slice(0, i).some((p) => Math.abs(p.km - c.km) < Math.max(0.5, c.km * 0.01) && Math.abs(p.min - c.min) < 2));
  // 「有料道路を使わない」なら、有料道路を含む候補（別ルートは回避の指定が効かないことがある）を外す
  if (tour.opts.noToll) {
    const free = uniq.filter((c) => c.toll !== true);
    if (free.length) uniq = free;
    else note = '有料道路を通らないルートが見つかりませんでした。有料道路を含むルートを表示しています。';
  }
  const scores = uniq.map((c) => Lib.scenicScore(c.line, scenicPoints(), DATA.roads));
  const stars = Lib.scenicStars(scores);
  const fastest = Math.min(...uniq.map((c) => c.min));
  return uniq.map((c, i) => ({ ...c, ...scores[i], stars: stars[i], fastest: uniq.length > 1 && c.min === fastest, note, opts: optsKey, at: Date.now() }));
}

const currentDest = () => {
  if (tour.roadId) {
    const road = roadById(tour.roadId);
    if (!road) return null;
    const pts = Lib.loopPoints(DATA.cfg.origin, road);
    return { id: 'road:' + road.id, name: `${road.name}（周回）`, lat: pts[1].lat, lon: pts[1].lon, loop: true, road, note: road.note, tags: road.tags };
  }
  return tour.custom || DATA.touring.find((t) => t.id === tour.destId) || null;
};
// Google マップへ渡す経由地のうち、決まって使うもの（コースの経由地・周回する道の入口と出口）
function fixedWaypoints() {
  const dest = currentDest(); if (!dest) return [];
  if (tour.route && tour.route.fixed) return tour.route.fixed; // 選んだ候補が通る道・コース
  if (dest.loop) return roadFix(dest.road.points);
  return (dest.waypoints || []).map(([lat, lon]) => ({ lat, lon }));
}
// 候補を作ったあとで走り方を変えたか
const routeStale = () => !!(tour.route && tour.route.opts && tour.route.opts !== JSON.stringify(tour.opts));
const MIN_PINS = 2; // ルート固定用に最低限残す枠
const room = () => Math.max(0, MAX_WAYPOINTS - fixedWaypoints().length - MIN_PINS);
function getStops() {
  if (!tour.route) return [];
  if (!tour.stops) {
    // 山頂は車・バイクで寄れないことが多いので除く
    const items = DATA.spots.concat(poiSpotList().filter((p) => p.kind !== 'peak'));
    const seen = new Set();
    tour.stops = Lib.stopsAlongRoute(items, tour.route.line, tour.radius)
      .filter((s) => s.alongKm > 1 && !seen.has(s.id) && seen.add(s.id));
  }
  return tour.stops;
}
function navUrl() {
  const dest = currentDest(), line = tour.route.line;
  // 並べる順はすべて同じ物差し（distToRoute の進行距離）で測る
  const along = (p) => Lib.distToRoute(p, line).along;
  const picked = getStops().filter((s) => tour.picked.has(s.id)).slice(0, room()).map((s) => ({ ...s, along: s.alongKm }));
  const fixed = fixedWaypoints().map((p) => ({ ...p, along: along(p) }));
  // 残りの枠でルート上の地点を等間隔に足し、Google マップが別の道（有料道路など）を選ばないようにする。
  // 走り方を変えた後は古いルートに沿わせない
  const pins = routeStale() ? [] : Lib.pinWaypoints(line, Math.min(4, MAX_WAYPOINTS - fixed.length - picked.length)).map((p) => ({ ...p, along: along(p) }));
  const wps = [...fixed, ...picked, ...pins].sort((a, b) => a.along - b.along);
  return Lib.gmapsDirUrl(DATA.cfg.origin, dest.loop ? DATA.cfg.origin : dest, wps, 'driving');
}
function pickedCount() { return getStops().filter((s) => tour.picked.has(s.id)).length; }
function updateTourSelection() {
  // 旧版で選んだ立ち寄りが今の上限を超えていたら、走る順に上限まで残す
  if (pickedCount() > room()) {
    tour.picked = new Set(getStops().filter((s) => tour.picked.has(s.id)).slice(0, room()).map((s) => s.id));
    saveTour();
    document.querySelectorAll('[data-stop]').forEach((cb) => { cb.checked = tour.picked.has(cb.dataset.stop); });
  }
  const n = pickedCount(), full = n >= room();
  document.querySelectorAll('[data-stop]').forEach((cb) => {
    cb.disabled = !cb.checked && full;
    const row = cb.closest('.stop');
    row.classList.toggle('is-picked', cb.checked);
    row.classList.toggle('is-disabled', cb.disabled);
  });
  const nav = $('#nav');
  if (nav) {
    const waiting = tour.route && !DATA.eventsLoaded; // 道の駅などの読み込み前に押すと経由地が抜けるため
    const d = currentDest();
    nav.href = waiting ? '#' : tour.route ? navUrl()
      : Lib.gmapsDirUrl(DATA.cfg.origin, d.loop ? DATA.cfg.origin : d, fixedWaypoints(), 'driving'); // ルート未検索でも周回・コースの道を渡す
    nav.textContent = waiting ? '立ち寄り候補を読み込み中…' : `ナビ開始（立ち寄り ${n}/${room()}）`;
    nav.toggleAttribute('aria-disabled', !!waiting);
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
function saveGpx() {
  const dest = currentDest();
  const wpts = getStops().filter((s) => tour.picked.has(s.id)).map((s) => ({ lat: s.lat, lon: s.lon, name: s.name }));
  if (!dest.loop) wpts.push({ lat: dest.lat, lon: dest.lon, name: dest.name });
  const name = `${DATA.cfg.origin.name}→${dest.name}（${tour.route.label}）`;
  const url = URL.createObjectURL(new Blob([Lib.toGpx(name, tour.route.line, wpts)], { type: 'application/gpx+xml' }));
  const a = document.createElement('a');
  a.href = url; a.download = `mymap-${dest.name.replace(/[\\/:*?"<>|（）() ]/g, '')}.gpx`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const candCard = (c, i) => `<button type="button" class="card cand" data-cand="${i}" aria-pressed="${i === tour.sel}">
  <span class="cand-title">${esc(c.label)}${c.fastest ? ' <span class="badge fast">最速</span>' : ''}</span>
  <span class="cand-time">${fmtMin(Math.round(c.min))}・${Math.round(c.km)}km</span>
  <span class="cand-sub">${c.toll === true ? '<span class="badge warn">有料あり</span>' : c.toll === false ? '有料なし' : ''}
    ・景色 ${'★'.repeat(c.stars)}${'☆'.repeat(5 - c.stars)}（展望台など${c.spots}か所${c.roadKm >= 1 ? `・おすすめの道${Math.round(c.roadKm)}km` : ''}）</span></button>`;

function renderTouring() {
  const dest = currentDest();
  const key = JSON.stringify([tour.destId, tour.custom, tour.roadId, tour.route && tour.route.at, tour.sel, tour.radius, tour.error, tour.busy, DATA.ver,
    !!DATA.touring.length, DATA.roads.length, navigator.onLine, tour.restored, tour.opts]);
  // 変化がなければ作り直さない（地図のズームと位置、スクロール位置を保つ）
  if (key === tour.key && $('#map')) { if (map) map.invalidateSize(); updateTourSelection(); return; }
  tour.key = key;
  const stops = getStops();
  const offline = navigator.onLine === false;
  const sns = dest && !tour.custom ? Lib.snsLinks({ name: dest.loop ? dest.road.name : dest.name, tags: dest.tags }) : null;
  const road = dest && dest.loop ? dest.road : null;
  const closedNow = road && (road.closedMonths || []).includes(thisMonth());
  const roadsByDist = [...DATA.roads].sort((a, b) => Lib.haversineKm(DATA.cfg.origin, { lat: a.points[0][0], lon: a.points[0][1] })
    - Lib.haversineKm(DATA.cfg.origin, { lat: b.points[0][0], lon: b.points[0][1] }));
  const viaRoads = tour.route ? (tour.route.via || []).map(roadById).filter(Boolean) : [];
  $('#view').innerHTML = `
    <label for="dest"><strong>目的地</strong></label>
    <select id="dest"><option value="">選んでください</option>
      <optgroup label="目的地まで走る">${DATA.touring.map((t) =>
        `<option value="${esc(t.id)}" ${t.id === tour.destId && !tour.custom && !tour.roadId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</optgroup>
      ${DATA.roads.length ? `<optgroup label="おすすめの道を走る（調布に戻る周回）">${roadsByDist.map((r) =>
        `<option value="road:${esc(r.id)}" ${r.id === tour.roadId ? 'selected' : ''}>${esc(r.name)}${r.toll ? '（有料）' : ''}</option>`).join('')}</optgroup>` : ''}
      ${tour.custom ? `<option selected>${esc(tour.custom.name)}</option>` : ''}</select>
    <div class="dest-search"><input id="dq" type="search" enterkeyhint="search" autocomplete="off" placeholder="目的地を検索（例：じんだいじ、河口湖、箱根町）" aria-label="目的地を検索">
      <button type="button" class="btn" id="dq-go">検索</button></div>
    <div id="dq-results"></div>
    <p class="hint">選ぶ・検索する・地図を動かして中央の＋を合わせ「中心を目的地に」を押す（または長押し）の、どれでも指定できます</p>
    ${road ? `<p class="notice">${closedNow ? '⚠ <strong>今月は通行止め・閉鎖の期間です。</strong>' : ''}${road.toll ? `有料道路（${road.fee ? esc(road.fee) : '料金は公式サイトで確認'}）。` : ''}${esc(road.note)}${road.closed ? `<br>⚠ ${esc(road.closed)}` : ''}</p>`
      : dest && dest.note ? `<p class="notice">⚠ ${esc(dest.note)}</p>` : ''}
    ${sns ? `<div class="actions"><a class="btn" href="${esc(sns.x)}" target="_blank" rel="noopener">#X で最新情報</a><a class="btn" href="${esc(sns.instagram)}" target="_blank" rel="noopener">#Instagram</a></div>` : ''}
    <fieldset class="opts"><legend><strong>走り方</strong></legend>
      <label class="check"><input type="checkbox" data-opt="noToll" ${tour.opts.noToll ? 'checked' : ''}>有料道路を使わない</label>
      <label class="check"><input type="checkbox" data-opt="fewHighways" ${tour.opts.fewHighways ? 'checked' : ''}>高速道路をなるべく使わない</label>
      <label class="check"><input type="checkbox" data-opt="bike" ${tour.opts.bike ? 'checked' : ''}>バイク向け（幹線を避け、地方の道を好む）</label>
    </fieldset>
    <label class="check"><input type="checkbox" id="awake" ${tour.awake ? 'checked' : ''}>このタブを開いている間は画面を消さない</label>
    <div class="row"><span class="label">立寄</span><div id="radius" class="chips"></div></div>
    <div class="actions"><button type="button" class="btn primary" id="route-go" ${dest && !tour.busy ? '' : 'disabled'}>${tour.busy ? '検索中…（候補を比べています）' : dest ? 'ルート候補を探す' : '目的地を選ぶと押せます'}</button></div>
    <div class="map-wrap"><div id="map"></div><span class="crosshair" aria-hidden="true">＋</span>
      <button type="button" class="btn map-pick" id="pick-center">中心を目的地に</button></div>
    ${tour.error ? `<p class="notice">${esc(tour.error)}</p>` : ''}
    ${tour.route && (tour.restored || offline) ? `<p class="notice">${offline ? '📴 圏外のため、' : ''}${fmtStamp(tour.route.at || 0)} に検索して保存したルートを表示しています${offline ? '' : '（再検索で更新）'}。</p>` : ''}
    ${routeStale() ? '<p class="notice">⚠ 走り方を変えました。「ルート候補を探す」で探し直してください（このままナビを開くと、ルートを固定する地点なしで Google マップに渡します）。</p>' : ''}
    ${tour.cands && tour.cands.length ? `<h2>ルート候補（${tour.cands.length}本${tour.cands.length > 1 ? '・押して切り替え' : ''}）</h2><div class="cands">${tour.cands.map(candCard).join('')}</div>` : ''}
    ${tour.route ? `<p class="route-sum">${esc(tour.route.label)}：約${Math.round(tour.route.km)}km・${fmtMin(Math.round(tour.route.min))}</p>
      <p class="hint">${esc(tour.route.engine || 'OSRM')} による推定${tour.route.note ? '。' + esc(tour.route.note) : ''}${tour.opts.noToll || tour.opts.fewHighways ? '。Google マップでは「ルートオプション」でも同じ設定にしてください' : ''}</p>
      ${dest && !dest.loop ? viaRoads.map((r) => `<p class="notice">「${esc(r.name)}」${(r.closedMonths || []).includes(thisMonth()) ? '⚠ <strong>今月は通行止め・閉鎖の期間です。</strong>' : ''}${r.toll ? `有料道路（${r.fee ? esc(r.fee) : '料金は公式サイトで確認'}）。` : ''}${r.closed ? `⚠ ${esc(r.closed)}` : ''}</p>`).join('') : ''}
      <p class="hint">ナビは Google マップのアプリで開いてください（ブラウザ版の Google マップは経由地が 3 件までしか使えません）。</p>` : ''}
    ${tour.route ? `<h2>立ち寄り候補（${stops.length}件・走る順）</h2>
      <p id="limit-msg" class="notice" hidden>立ち寄りは${room()}件まで選べます（残りの経由地はルートを固定するために使います）。ほかを外すと選べます。</p>`
      + (stops.length ? stops.slice(0, 100).map((s) => `
      <label class="card stop"><input type="checkbox" data-stop="${esc(s.id)}" ${tour.picked.has(s.id) ? 'checked' : ''}>
        <span class="km">${Math.round(s.alongKm)}<small>km</small></span>
        <span class="name">${s.genres.map((g) => icon(GENRES[g] || '・')).join('')} ${esc(s.name)}${parkText(s) ? ` <strong>${parkText(s)}</strong>` : ''}
          <span class="sub">道から${s.offKm.toFixed(1)}km${s.note ? '・' + esc(s.note) : ''}</span>${infoButton(s)}</span></label>
      <div class="info stop-info" hidden></div>`).join('')
        : '<p class="empty">この範囲に立ち寄り候補はありません。範囲を広げてみてください。</p>') : ''}
    ${dest ? `<div class="tour-bar"><a class="btn primary" id="nav" target="_blank" rel="noopener" href="#">ナビ開始</a>
      ${tour.route ? '<button type="button" class="btn" id="gpx">GPXで保存</button>' : ''}</div>` : ''}`;

  chips($('#radius'), [[1, '1km'], [3, '3km'], [5, '5km']], (v) => v === tour.radius, (v) => {
    tour.radius = v; tour.stops = null;
    // 範囲外になった立ち寄りは選択から外す（狭めて広げたときに上限を超えないように）
    const ids = new Set(getStops().map((s) => s.id));
    for (const id of [...tour.picked]) if (!ids.has(id)) tour.picked.delete(id);
    saveTour();
  });
  $('#dest').onchange = (e) => {
    const v = e.target.value;
    const ok = setDest(() => {
      tour.custom = null;
      if (v.startsWith('road:')) { tour.roadId = v.slice(5); tour.destId = null; } else { tour.roadId = null; tour.destId = v || null; }
    });
    if (!ok) e.target.value = tour.roadId ? 'road:' + tour.roadId : tour.custom ? '' : tour.destId || '';
  };
  // 目的地の検索欄（作り直しても入力中の文字とフォーカスを保つ）
  const dq = $('#dq');
  dq.value = dqState.q;
  if (dqState.focused) dq.focus();
  renderDestResults();
  let dqTimer = 0;
  dq.addEventListener('input', () => {
    dqState.q = dq.value; dqState.places = null;
    clearTimeout(dqTimer); dqTimer = setTimeout(renderDestResults, 150);
  });
  dq.addEventListener('focus', () => { dqState.focused = true; });
  dq.addEventListener('blur', () => { dqState.focused = false; });
  dq.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchPlaces(); } });
  $('#dq-go').onclick = () => { buzz(); searchPlaces(); };
  const pc = $('#pick-center');
  if (pc) pc.onclick = () => { if (!map) return; buzz(); const ce = map.getCenter(); setCustomDest(ce.lat, ce.lng); };
  document.querySelectorAll('[data-opt]').forEach((cb) => {
    // 変えたら描き直して「探し直して」を出す（古いルートのまま固定の地点を渡さない）
    cb.onchange = () => { buzz(); tour.opts = { ...tour.opts, [cb.dataset.opt]: cb.checked }; saveTour(); renderTouring(); };
  });
  $('#awake').onchange = (e) => { tour.awake = e.target.checked; store.set('awake', tour.awake); keepAwake(tour.awake); };
  $('#route-go').onclick = async () => {
    buzz(); tour.error = ''; tour.busy = true; renderTouring();
    // 地図で指定した地点は id がいつも 'custom' なので、地点そのものと走り方で同じ検索かを見分ける
    const sig = () => JSON.stringify([tour.destId, tour.roadId, tour.custom, tour.opts]);
    const d = currentDest(), at = sig();
    try {
      const cands = await fetchCandidates(d);
      if (sig() === at) { tour.cands = cands; tour.sel = 0; tour.restored = false; tour.stops = null; tour.picked.clear(); saveTour(); }
      else tour.error = '検索中に目的地か走り方が変わったため、結果を使いませんでした。もう一度探してください。';
    } catch (err) {
      if (sig() === at) tour.error = err.mine ? err.message : 'ルートを取得できませんでした。Google マップのボタンから確認してください。';
    }
    tour.busy = false;
    if (state.tab === 'touring') renderTouring(); // 検索中に別のタブへ移っていたら描かない
  };
  $('#view').onclick = (e) => {
    const b = e.target.closest('[data-cand]'); if (!b || +b.dataset.cand === tour.sel) return; // 選択中をもう一度押しても何も変えない
    buzz(); tour.sel = +b.dataset.cand; tour.stops = null; tour.picked.clear(); saveTour(); renderTouring();
  };
  const g = $('#gpx'); if (g) g.onclick = () => { buzz(); saveGpx(); };
  // チェックの変更では地図も一覧も作り直さない（マーカーとナビボタンだけ更新）
  $('#view').onchange = (e) => {
    const cb = e.target.closest('[data-stop]'); if (!cb) return;
    buzz();
    togglePick(cb.dataset.stop, cb.checked);
  };
  drawMap(dest, stops);
  updateTourSelection();
}

// 目的地を変える。保存したルートがあるときは消えてよいか確かめる（圏外では取り直せないため）
function setDest(apply) {
  if (tour.route && !confirm(navigator.onLine === false
    ? '圏外のため、目的地を変えると保存したルートを取り直せません。変更しますか？' : '目的地を変えると、今のルートと選んだ立ち寄りが消えます。変更しますか？')) return false;
  apply();
  tour.cands = null; tour.sel = 0; tour.stops = null; tour.restored = false; tour.picked.clear(); tour.error = '';
  saveTour(); renderTouring();
  return true;
}
const setCustomDest = (lat, lon, name = '地図で指定した地点') => setDest(() => {
  tour.roadId = null;
  tour.custom = { id: 'custom', name, lat: +lat.toFixed(5), lon: +lon.toFixed(5), waypoints: [] };
});

// ---- 目的地の検索: 入力中はアプリ内のスポットから（通信なし）、「検索」で国土地理院の地名・住所検索も ----
const dqState = { q: '', places: null, busy: false, error: '', focused: false, items: [] };
function renderDestResults() {
  const box = $('#dq-results'); if (!box) return;
  const q = dqState.q.trim();
  if (!q) { box.innerHTML = ''; dqState.items = []; return; }
  const spots = Lib.searchSpots(DATA.spots.concat(DATA.osm, poiSpotList()), q, DATA.cfg, state.favs, 'car', 6)
    .map((s) => ({ name: s.name, lat: s.lat, lon: s.lon, sub: `${s.genres.map((g) => icon(GENRES[g] || '・')).join('')} ${fmtMin(s.minutes)}` }));
  const places = (dqState.places || []).map((p) => ({ ...p, sub: '地名・住所' }));
  dqState.items = spots.concat(places);
  box.innerHTML = `<div class="dq-list">${dqState.items.map((x, i) => `<button type="button" class="card dq-item" data-dq="${i}">
      <strong>${esc(x.name)}</strong><span class="status">${esc(x.sub)}</span></button>`).join('')}</div>
    ${dqState.busy ? '<p class="hint">地名・住所を検索中…</p>' : dqState.error ? `<p class="hint">${esc(dqState.error)}</p>`
      : dqState.places ? (places.length ? '' : '<p class="hint">地名・住所では見つかりませんでした。</p>')
      : '<p class="hint">見つからないときは「検索」を押すと、地名・住所（国土地理院）でも探します。</p>'}`;
}
async function searchPlaces() {
  const q = dqState.q.trim(); if (!q || dqState.busy) return;
  dqState.busy = true; dqState.error = ''; renderDestResults();
  try {
    const r = await fetch(Lib.gsiSearchUrl(q), { signal: timeoutSignal(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (dqState.q.trim() === q) dqState.places = Lib.parseGsi(await r.json(), 8);
  } catch {
    dqState.error = '地名・住所の検索ができませんでした（圏外の可能性があります）。';
  }
  dqState.busy = false; renderDestResults();
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-dq]'); if (!b) return;
  const x = dqState.items[+b.dataset.dq]; if (!x) return;
  buzz();
  const prev = { ...dqState };
  dqState.q = ''; dqState.places = null; dqState.focused = false;
  if (!setCustomDest(x.lat, x.lon, x.name)) Object.assign(dqState, prev); // 変更をやめたら入力を戻す
});

function drawMap(dest, stops) {
  if (typeof L === 'undefined') { $('#map').textContent = '地図を読み込めませんでした（圏外の可能性があります）。'; return; }
  if (map) map.remove();
  markers = new Map();
  map = L.map('map', { renderer: L.canvas({ tolerance: 8 }) }).setView([DATA.cfg.origin.lat, DATA.cfg.origin.lon], 9);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> / ルート: Valhalla (FOSSGIS)・OSRM' }).addTo(map);
  L.marker([DATA.cfg.origin.lat, DATA.cfg.origin.lon], { bubblingMouseEvents: false }).addTo(map).bindPopup(esc(DATA.cfg.origin.name));
  if (dest) L.marker([dest.lat, dest.lon], { bubblingMouseEvents: false }).addTo(map).bindPopup(esc(dest.name));
  if (tour.route) {
    // ほかの候補は細い灰色の破線で比べられるように
    (tour.cands || []).forEach((c, i) => {
      if (i !== tour.sel) L.polyline(c.line.map(([lon, lat]) => [lat, lon]), { color: '#666', weight: 4, opacity: 0.8, dashArray: '6 8', bubblingMouseEvents: false }).addTo(map);
    });
    const latlngs = tour.route.line.map(([lon, lat]) => [lat, lon]);
    // 白い縁取りの上に濃い線を重ね、色の多い地図の上でも浮き上がらせる
    L.polyline(latlngs, { color: '#fff', weight: 12, opacity: 1, bubblingMouseEvents: false }).addTo(map);
    const line = L.polyline(latlngs, { color: keyColor(), weight: 7, opacity: 1, bubblingMouseEvents: false }).addTo(map);
    stops.forEach((s) => {
      const m = L.circleMarker([s.lat, s.lon], { bubblingMouseEvents: false }).addTo(map)
        .bindPopup(() => popupHtml(s, infoCache()[s.id] || null), { maxWidth: 280, minWidth: 220, maxHeight: 240, autoPanPaddingTopLeft: [16, 112], autoPanPaddingBottomRight: [16, 40] });
      m.on('popupopen', async () => {
        if (infoCache()[s.id]) return;
        const v = await loadInfo(s);
        if (m.isPopupOpen()) { m.setPopupContent(popupHtml(s, v)); refitPopup(m); }
      });
      markers.set(s.id, m);
    });
    map.fitBounds(line.getBounds(), { padding: [16, 16] });
  } else if (dest && dest.loop) {
    map.fitBounds(L.latLngBounds(dest.road.points.concat([[DATA.cfg.origin.lat, DATA.cfg.origin.lon]])), { padding: [16, 16] });
  }
  // 誤操作を防ぐため、目的地の指定は長押し（スマホでは contextmenu として届く）か「中心を目的地に」ボタンだけ。
  // 長押し中（指が触れている間）に地図を作り直すと iPhone で次のタップが効かなくなることがあるので、少し遅らせる
  map.on('contextmenu', (e) => { buzz(); setTimeout(() => setCustomDest(e.latlng.lat, e.latlng.lng), 350); });
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
  const prevToken = $('#token'), typed = prevToken ? prevToken.value : '', focused = document.activeElement === prevToken;
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
  if (typed) $('#token').value = typed;
  if (focused) $('#token').focus();
  $('#token-save').onclick = () => { const v = $('#token').value.trim(); if (v) { store.set('token', v); renderSettings(); } };
  $('#token-del').onclick = () => { store.set('token', null); renderSettings(); };
  $('#update-now').onclick = () => { buzz(); requestUpdate(true); };
}

// ---- タブと全体描画 ----
const RENDER = { spots: renderSpots, events: renderEvents, touring: renderTouring, settings: renderSettings };
function goTab(t) {
  // ツーリングタブを開いたら屋外モードを自動でオン（手動で切った後も、次に開いたときは再びオン）
  if (t === 'touring' && state.tab !== 'touring') setOutdoor(true, false); // 自動の ON は保存しない（手動の設定を上書きしない）
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
  if (state.tab === 'touring') setOutdoor(true, false);
  $('#filters').open = !!store.get('filtersOpen');
  $('#rec').open = store.get('recOpen') !== false;
  DATA.cfg = await getJSON('config.json', null);
  if (!DATA.cfg) { renderLoadMsg(); $('#view').innerHTML = '<p class="empty">config.json を読み込めません。電波の良い場所で開き直してください。</p>'; return; }
  // 先にスポットを出し、イベントなどは後から読み込む
  [DATA.spots, DATA.touring, DATA.status, DATA.roads] = await Promise.all([
    getJSON('data/spots.json', []), getJSON('data/touring.json', []), getJSON('data/status.json', null, 'no-store'),
    getJSON('data/scenic_roads.json', [])]);
  renderAll();
  loadWeather();
  requestUpdate();
  [DATA.pois, DATA.events] = await Promise.all([getJSON('data/pois.json', []), getJSON('data/events.json', [])]);
  DATA.eventsLoaded = true; DATA.ver++; tour.stops = null;
  cellIndex = await getJSON('data/cells/index.json', null);
  FAILED.delete('data/cells/index.json'); // まだ収集していないとき（404）は失敗扱いにしない
  renderAll();
  // 自動収集スポットは大きい（数 MB）ので最後に読み込む
  DATA.osm = await getJSON('data/osm_spots.json', []);
  DATA.osmLoaded = true;
  renderAll();
}
init();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* 非対応でも動く */ });
