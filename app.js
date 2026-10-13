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
  showNotices: false, showChains: false, walkinOnly: false, foodCat: '', spotMap: false, openOnly: false, seasonOnly: false, isoOn: false, gacha: null,
  favGenres: new Set(store.get('favGenres') || ['vehicle', 'museum', 'garden', 'temple', 'onsen']),
  favs: new Set(store.get('favs') || []), visited: new Set(store.get('visited') || []),
};
const DATA = { cfg: null, spots: [], osm: [], pois: [], events: [], status: null, touring: [], roads: [], courses: [], passes: [], ver: 0, eventsLoaded: false, osmLoaded: false };
const FAILED = new Set();

const rainy = () => (state.rainOverride ?? state.weatherRainy);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const noticeRe = () => {
  const words = (DATA.cfg && DATA.cfg.eventExcludeWords) || [];
  return words.length ? new RegExp(words.map(escRe).join('|')) : null;
};
// 到達圏で判定しているときは、直線距離からの時間の絞り込みを使わない
const filterState = () => ({ mode: state.mode, maxMin: isoGeom() ? null : state.maxMin, prefs: state.prefs, genres: state.genres, dirs: state.dirs,
  favs: state.favs, rainy: rainy(), exclude: state.showNotices ? null : noticeRe() });
function saveFilters() {
  store.set('filters', { mode: state.mode, maxMin: state.maxMin, prefs: [...state.prefs], genres: [...state.genres], dirs: [...state.dirs] });
}
const icon = (label) => [...label][0]; // 先頭の絵文字（コードポイント単位）
const fmtMin = (m) => (m == null ? '' : m < 60 ? `約${m}分` : `約${Math.floor(m / 60)}時間${m % 60 ? (m % 60) + '分' : ''}`);
const dirName = (d) => (DATA.cfg && DATA.cfg.directionLabels && DATA.cfg.directionLabels[d]) || DIR_NAMES[d];
const fmtStamp = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };

// 週 1 回しか変わらないデータは 'no-cache'（ETag で再検証し、変わっていなければ 304 でほぼ通信しない）
// ---- Google マップへのリンク: 同じ名前の別の場所に飛ばないよう「名前＋住所」で開く ----
// 住所は国土地理院の逆ジオコーダーで調べ、端末に保存する（最大 500 件）
const ADDR = new Map(Object.entries(store.get('addr') || {}));
const addrKey = (s) => `${s.lat},${s.lon}`;
let MUNI = null;
async function addressOf(s) {
  if (ADDR.has(addrKey(s))) return ADDR.get(addrKey(s));
  MUNI = MUNI || await getJSON('data/muni.json', {}, 'default');
  const j = await fetch(Lib.gsiReverseUrl(s), { signal: timeoutSignal(4000) }).then((r) => r.json());
  const a = Lib.parseGsiAddress(j, MUNI);
  if (a) {
    ADDR.set(addrKey(s), a);
    store.set('addr', Object.fromEntries([...ADDR].slice(-500)));
  }
  return a;
}
const gmUrl = (kind, s, addr) => (kind === 'dir'
  ? Lib.gmapsPlaceDirUrl(DATA.cfg.origin, s, GMAP_MODE[state.mode], addr) : Lib.gmapsSearchUrl(s, addr));
const gm = (s, kind = 'search') => `href="${esc(gmUrl(kind, s, ADDR.get(addrKey(s))))}" target="_blank" rel="noopener"
  data-gm="${kind}" data-name="${esc(s.name)}" data-lat="${s.lat}" data-lon="${s.lon}"`;
// 表示したリンクの住所を調べて、リンク先を「名前＋住所」に書き換える（リンクは普通のリンクのまま。
// 押したときに空のタブを開いてから行き先を入れる方式は、スマホで about:blank が残るのでやめた）
async function fillAddr(root) {
  for (const a of root.querySelectorAll('a[data-gm]')) {
    if (a.dataset.lat === 'undefined') continue;
    const s = { name: a.dataset.name, lat: +a.dataset.lat, lon: +a.dataset.lon };
    try {
      const addr = await addressOf(s);
      if (addr) a.href = gmUrl(a.dataset.gm, s, addr);
    } catch { return; } // 圏外などは座標・地図の範囲のまま
  }
}

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
  if (state.foodCat && groups.includes('food')) all = all.filter((s) => !s.genres.includes('food') || Lib.inFoodCat(s, state.foodCat));
  if (state.isoOn && isoAvailable()) {
    loadIso();
    const g = isoGeom();
    if (g) all = all.filter((s) => Lib.inGeometry(s, g));
  }
  if (state.openOnly) { const now = new Date(); all = all.filter((s) => Lib.openState(s.oh, now) === true); }
  if (state.seasonOnly) { const m = thisMonth(); all = all.filter((s) => Lib.seasonNow(s, m).length); }
  return all;
}
const isCurated = (s) => !s.poi && !s.op && !String(s.id).startsWith('osm:');
const parkText = (s) => (s.parking ? [s.parking.car ? '🅿車' : '', s.parking.bike ? '🅿二輪' : ''].filter(Boolean).join(' ') : '');
function spotCard(s) {
  const sns = Lib.snsLinks(s);
  const icons = s.genres.map((g) => icon(GENRES[g] || '・')).join('');
  const park = parkText(s);
  // 一覧では名前・時間・短い説明だけ。ボタン類と写真は「▼詳しく」を押してから（1 画面にたくさん並べるため）
  return `<article class="card spot">
    <div class="spot-head"><h3>${isCurated(s) ? '<span title="厳選スポット">★</span> ' : ''}${icons} ${esc(s.name)}</h3>
      <div class="head-btns">${infoButton(s)}${s.poi ? '' : `<button type="button" class="icon fav" data-fav="${esc(s.id)}" aria-pressed="${state.favs.has(s.id)}" aria-label="お気に入り">⭐</button>`}</div></div>
    <p class="meta">${s.indoor ? '<span class="badge rain">☔雨OK</span> ' : ''}${icon(MODES[state.mode])}<strong>${fmtMin(s.minutes)}</strong>${s.fee ? '・' + esc(s.fee) : ''}${park ? '・' + park : ''}${state.visited.has(s.id) ? '・✓行った' : ''}${'walkin' in s ? (s.walkin ? '・<strong>当日参加OK</strong>' : '・要予約') : ''}${openBadge(s)}${seasonBadge(s)}</p>
    ${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}
    <div class="info" hidden></div></article>`;
}
// 「▼詳しく」の中身（開いたときに作る。一覧の 1 枚ごとに作ると、300 件で部品が 1 万個を超えて重くなるため）
function infoShell(s) {
  const sns = Lib.snsLinks(s);
  return `${detailLine(s)}
    <div class="actions">
      <a class="btn" ${gm(s, 'dir')}>地図で経路</a>
      <a class="btn" ${gm(s)}>写真・口コミ</a>
      <button type="button" class="btn" data-plan="${esc(s.id)}">日帰りプラン</button>
      ${s.poi ? '' : `<button type="button" class="icon" data-visited="${esc(s.id)}" aria-pressed="${state.visited.has(s.id)}">行った</button>`}
    </div>
    <details class="more"><summary>その他（周辺を探す・共有・SNS・公式など）</summary>
      <div class="actions">
        ${s.url ? `<a class="btn" href="${esc(s.url)}" target="_blank" rel="noopener">${s.url.includes('wikipedia.org') ? 'Wikipedia' : '公式'}</a>` : ''}
        ${s.tel ? `<a class="btn" href="tel:${esc(s.tel.replace(/[^\d+]/g, ''))}">📞電話</a>` : ''}
        <a class="btn" href="${esc(Lib.streetViewUrl(s))}" target="_blank" rel="noopener">ストリートビュー</a>
        <button type="button" class="btn" data-share="${esc(s.id)}">共有</button>
        ${s.poi ? '' : `<a class="btn" href="${esc(sns.instagram)}" target="_blank" rel="noopener">#Instagram</a>
        <a class="btn" href="${esc(sns.x)}" target="_blank" rel="noopener">#X</a>`}
      </div>
      <p class="hint">周辺を探す（2km以内）</p>
      <div class="chips wrap" aria-label="周辺を探す">${Object.entries(Lib.NEARBY_KINDS).map(([k, [label]]) =>
        `<button type="button" class="chip" data-nb="${k}" data-nb-for="${esc(s.id)}">${label}</button>`).join('')}</div>
    </details>
    <div class="nearby"></div>
    <div class="plan"></div>
    <div class="info-body"></div>`;
}
// 日の出・日の入りの時刻と方角、ダイヤモンド富士（見える場所なら）、混みやすさの目安
const hmOf = (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
function nextWeekendNoon() {
  const d = new Date(); d.setHours(12, 0, 0, 0);
  while (d.getDay() !== 6 && d.getDay() !== 0 && !Lib.jpHoliday(d)) d.setDate(d.getDate() + 1);
  return d;
}
function extraInfo(s) {
  const parts = [];
  const t = Lib.sunTimes(new Date(), s);
  if (t.rise && t.set) parts.push(`🌅今日の日の出 ${hmOf(t.rise.at)}（${Lib.dir16(t.rise.az)}）・日の入り ${hmOf(t.set.at)}（${Lib.dir16(t.set.az)}）`);
  if ((s.genres || []).includes('scenic') || /富士|展望|湖|峠|山|岬|海岸|浜|丘|高原/.test(s.name)) {
    const df = Lib.diamondFuji(s).slice(0, 4);
    if (df.length) parts.push(`🗻ダイヤモンド富士（富士山が見える場所なら・予測）: ${df.map((x) => `${x.at.getMonth() + 1}/${x.at.getDate()} ${hmOf(x.at)} ${x.kind}`).join('、')}`);
  }
  const wk = nextWeekendNoon(), c = Lib.crowdLevel(s, wk);
  parts.push(`👥混みやすさの目安（${wk.getMonth() + 1}/${wk.getDate()}の昼）: <strong>${c.label}</strong>${c.reasons.length ? `（${esc(c.reasons.join('・'))}）` : ''}`);
  return `<p class="hint">${parts.join('<br>')}</p>`;
}

// 営業中か（営業時間がわかるものだけ）・季節の見頃・営業時間などの 1 行
function openBadge(s) {
  const o = s.oh ? Lib.openState(s.oh) : null;
  return o === true ? ' <span class="badge open">営業中</span>' : o === false ? ' <span class="badge closed">営業時間外</span>' : '';
}
function seasonBadge(s) {
  const now = Lib.seasonNow(s, thisMonth());
  return now.length ? ` <span class="badge season">🌸今が見頃: ${esc(now.map((b) => b.what).join('・'))}</span>` : '';
}
function detailLine(s) {
  const parts = [];
  if (s.oh) parts.push(`🕘営業時間: ${esc(Lib.ohText(s.oh))}（OpenStreetMap の情報・祝日や臨時休業は公式で確認）`);
  if (s.best && s.best.length) parts.push(`🌸見頃: ${esc(Lib.seasonText(s.best))}`);
  if (s.wc) parts.push(`♿車いす: ${s.wc === 'yes' ? '利用できる' : s.wc === 'limited' ? '一部利用できる' : '利用しにくい'}`);
  return parts.length ? `<p class="hint">${parts.join('<br>')}</p>` : '';
}

// ---- 共有・日帰りプラン・周辺検索（「詳しく」の中のボタン） ----
async function shareText(title, text, url) {
  try {
    if (navigator.share) { await navigator.share({ title, text, url }); return; }
    await navigator.clipboard.writeText(`${text}\n${url || ''}`);
    alert('コピーしました。LINE などに貼り付けて送れます。');
  } catch { /* 共有をやめたとき */ }
}
const planState = { depart: store.get('planDepart') || '09:00' };
// 日帰りプラン: 自動で作った行き先を、追加・削除・並べ替え・滞在時間の変更・帰宅したい時刻で調整できる
const PLANS = new Map(); // スポットの id → { stops, home }
const STAY_CHOICES = [15, 30, 45, 60, 90, 120, 150, 180, 240];
const toMin = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };
async function planPool(s) {
  await ensureCells(['food', 'heritage', 'local'], s, 2);
  return DATA.spots.concat(DATA.osm, poiSpotList(), cellItems(['food', 'heritage', 'local'], s, 2));
}
async function renderPlan(el, s, reset = false) {
  if (!PLANS.has(s.id) || reset) {
    el.innerHTML = '<p class="hint">プランを作成中…</p>';
    const pool = await planPool(s);
    PLANS.set(s.id, { stops: Lib.autoPlanStops(s, pool, DATA.cfg, state.mode, toMin(planState.depart)), home: store.get('planHome') || '' });
  }
  const p = PLANS.get(s.id);
  const sch = Lib.schedulePlan(p.stops, DATA.cfg, state.mode, toMin(planState.depart), p.home ? toMin(p.home) : null);
  const places = p.stops.map((x) => x.place);
  const text = sch.steps.map((x) => `${x.time} ${x.what}`).join('\n');
  const last = p.stops.length - 1;
  el.innerHTML = `<h4>日帰りプラン（${esc(MODES[state.mode])}・移動時間は概算）</h4>
    <div class="plan-times"><label>出発 <input type="time" class="plan-depart" value="${esc(planState.depart)}"></label>
      <label>帰宅したい時刻 <input type="time" class="plan-home" value="${esc(p.home)}"></label></div>
    ${sch.overMin == null ? '' : sch.overMin > 0
    ? `<p class="notice">⚠ 帰宅が希望より<strong>約${Math.round(sch.overMin)}分遅れます</strong>。行き先を減らすか、滞在時間を短くしてください（最後の場所を ${esc(sch.lastLeave)} までに出れば間に合います）。</p>
      <div class="actions"><button type="button" class="btn plan-fit">時間内に収める（後ろの行き先から外す）</button></div>`
    : `<p class="status">✓ 帰宅したい時刻まで約${Math.round(-sch.overMin)}分の余裕があります（最後の場所は ${esc(sch.lastLeave)} までに出れば間に合います）。</p>`}
    <ol class="plan-steps">${sch.steps.map((x) => x.place == null ? `<li><strong>${esc(x.time)}</strong> ${esc(x.what)}</li>` : `<li>
      <strong>${esc(x.time)}</strong> <a ${gm(x.place)}>${esc(x.what)}</a>
      <span class="plan-edit"><select data-stay="${x.index}" aria-label="滞在時間">${STAY_CHOICES.concat(STAY_CHOICES.includes(x.stay) ? [] : [x.stay]).sort((a, b) => a - b)
        .map((m) => `<option value="${m}" ${m === x.stay ? 'selected' : ''}>${m < 60 ? m + '分' : (m / 60) + '時間'}</option>`).join('')}</select>
        <button type="button" class="icon" data-up="${x.index}" ${x.index === 0 ? 'disabled' : ''} aria-label="前へ">↑</button>
        <button type="button" class="icon" data-down="${x.index}" ${x.index === last ? 'disabled' : ''} aria-label="後へ">↓</button>
        <button type="button" class="icon" data-del="${x.index}" aria-label="外す">✕</button></span></li>`).join('')}</ol>
    <details class="plan-add" ${p.adding ? 'open' : ''}><summary>＋行き先を追加</summary>
      <input type="search" class="plan-q" placeholder="名前・料理で探す（例：温泉、ラーメン、道の駅）" aria-label="追加する行き先を探す" value="${esc(p.q || '')}">
      <div class="plan-results"></div>
      <p class="hint">近くのおすすめ</p><div class="chips wrap plan-sugg"></div></details>
    <div class="actions"><a class="btn primary" href="${esc(Lib.gmapsDirUrl(DATA.cfg.origin, DATA.cfg.origin, places, GMAP_MODE[state.mode]))}" target="_blank" rel="noopener">Googleマップで1日の経路</a>
      <button type="button" class="btn plan-order">近い順に並べ替え</button>
      <button type="button" class="btn plan-share">プランを共有</button>
      <button type="button" class="btn plan-reset">最初から作り直す</button></div>
    <p class="hint">最初の案は、昼食を目的地から1.5km以内（昼に営業中か営業時間不明・チェーン以外）、もう1か所を15km以内の温泉か3km以内の見どころから選んでいます。</p>`;
  const redraw = () => renderPlan(el, s);
  el.querySelector('.plan-depart').onchange = (e) => { planState.depart = e.target.value || '09:00'; store.set('planDepart', planState.depart); redraw(); };
  el.querySelector('.plan-home').onchange = (e) => { p.home = e.target.value; store.set('planHome', p.home); redraw(); };
  el.querySelectorAll('[data-stay]').forEach((x) => { x.onchange = () => { p.stops[+x.dataset.stay].stay = +x.value; redraw(); }; });
  el.querySelectorAll('[data-up]').forEach((b) => { b.onclick = () => { const i = +b.dataset.up; [p.stops[i - 1], p.stops[i]] = [p.stops[i], p.stops[i - 1]]; buzz(); redraw(); }; });
  el.querySelectorAll('[data-down]').forEach((b) => { b.onclick = () => { const i = +b.dataset.down; [p.stops[i + 1], p.stops[i]] = [p.stops[i], p.stops[i + 1]]; buzz(); redraw(); }; });
  el.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => { p.stops.splice(+b.dataset.del, 1); buzz(); redraw(); }; });
  const fit = el.querySelector('.plan-fit');
  if (fit) fit.onclick = () => {
    const home = toMin(p.home), over = () => Lib.schedulePlan(p.stops, DATA.cfg, state.mode, toMin(planState.depart), home).overMin;
    while (p.stops.length > 1 && over() > 0) p.stops.pop();
    // それでも遅れるときは、残った場所の滞在時間を短くする
    for (const st of p.stops) while (over() > 0 && st.stay > 30) st.stay = STAY_CHOICES.filter((m) => m < st.stay).pop() || 15;
    buzz(); redraw();
  };
  el.querySelector('.plan-order').onclick = () => { p.stops = Lib.orderStops(p.stops, DATA.cfg.origin); buzz(); redraw(); };
  el.querySelector('.plan-reset').onclick = () => { buzz(); renderPlan(el, s, true); };
  el.querySelector('.plan-share').onclick = () => shareText(`${s.name} 日帰りプラン`, text, '');
  const add = (x) => { p.stops.push({ place: x, stay: stayGuess(x), kind: (x.genres || []).includes('food') ? 'meal' : 'extra' }); p.q = ''; buzz(); redraw(); };
  const details = el.querySelector('.plan-add');
  details.addEventListener('toggle', () => { p.adding = details.open; });
  const pool = await planPool(s);
  const inPlan = new Set(p.stops.map((x) => x.place.id));
  // 近くのおすすめ（似たスポット・周辺・食事から、まだプランにないもの）
  const rel = Lib.relatedSpots(s, pool, { limit: 4, chains: state.showChains });
  const sugg = rel.nearby.concat(rel.food, rel.similar).filter((x) => !inPlan.has(x.id)).slice(0, 8);
  const sg = el.querySelector('.plan-sugg');
  sg.innerHTML = sugg.map((x, i) => `<button type="button" class="chip" data-sugg="${i}">＋${esc(x.name)}</button>`).join('') || '<span class="hint">近くに候補が見つかりませんでした。</span>';
  sg.querySelectorAll('[data-sugg]').forEach((b) => { b.onclick = () => add(sugg[+b.dataset.sugg]); });
  // 名前で探して追加（目的地に近い順）
  const q = el.querySelector('.plan-q'), res = el.querySelector('.plan-results');
  const search = () => {
    p.q = q.value;
    const local = q.value.trim() ? Lib.searchSpots(pool, q.value, DATA.cfg, state.favs, state.mode, 300) : [];
    const net = q.value.trim() ? openPoiFor(q.value, s, 10, () => { if (el.isConnected && el.querySelector('.plan-q') === q) search(); }) : {};
    const hits = local.concat(net.items ? Lib.notInLocal(net.items, local) : [])
      .filter((x) => !inPlan.has(x.id)).map((x) => ({ x, d: Lib.haversineKm(s, x) })).sort((a, b) => a.d - b.d).slice(0, 8);
    res.innerHTML = hits.map(({ x, d }, i) => `<button type="button" class="card dq-item" data-hit="${i}"><strong>＋ ${esc(x.name)}</strong>
      <span class="status">${(x.genres || []).map((g) => icon(GENRES[g] || '・')).join('')} 目的地から${d < 1 ? Math.round(d * 1000) + 'm' : d.toFixed(1) + 'km'}${x.op ? '・🌐OpenPOI' : ''}${x.note ? '・' + esc(x.note) : ''}</span></button>`).join('')
      + (net.busy ? '<p class="hint">🌐 ネットでも探しています（OpenPOI）…</p>' : '')
      || (q.value.trim() ? '<p class="hint">見つかりませんでした（目的地の近く2km以内のグルメなどと、観光スポットから探しています）。</p>' : '');
    res.querySelectorAll('[data-hit]').forEach((b) => { b.onclick = () => add(hits[+b.dataset.hit].x); });
  };
  q.oninput = search;
  if (p.q) search();
  fillAddr(el);
}
// 追加した場所の滞在時間の目安（食事は 60 分、それ以外は種類から）
const stayGuess = (x) => ((x.genres || []).includes('food') ? 60 : (x.genres || []).includes('onsen') ? 90 : (x.genres || []).some((g) => ['museum', 'play', 'experience'].includes(g)) ? 120 : 60);
async function renderNearby(el, s, kind) {
  el.innerHTML = `<p class="hint">${esc(Lib.NEARBY_KINDS[kind][0])}を探しています…</p>`;
  try {
    const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: Lib.nearbyQuery(s, kind),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: timeoutSignal(30000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const xs = Lib.parseNearby(await r.json(), s).slice(0, 6);
    el.innerHTML = `<h4>${esc(Lib.NEARBY_KINDS[kind][0])}（2km以内・近い順）</h4>` + (xs.length ? `<ul class="rel">${xs.map((x) => `<li>
      <a ${gm(x)}>${esc(x.name)}</a> <span class="status">${x.distKm < 1 ? Math.round(x.distKm * 1000) + 'm' : x.distKm.toFixed(1) + 'km'}${openBadge(x)}</span></li>`).join('')}</ul>`
      : '<p class="hint">見つかりませんでした（OpenStreetMap に登録がない場合もあります）。</p>');
  } catch {
    el.innerHTML = '<p class="hint">探せませんでした（混雑か圏外の可能性があります）。少し待ってもう一度押してください。</p>';
  }
}
document.addEventListener('click', (e) => {
  const sh = e.target.closest('[data-share]'), pl = e.target.closest('[data-plan]'), nb = e.target.closest('[data-nb]');
  if (sh) { const s = INFO_ITEMS.get(sh.dataset.share); if (s) shareText(s.name, `${s.name}${s.note ? '（' + s.note + '）' : ''}`, gmUrl('search', s, ADDR.get(addrKey(s)))); }
  if (pl) { const s = INFO_ITEMS.get(pl.dataset.plan); if (s) { buzz(); renderPlan(pl.closest('.info').querySelector('.plan'), s); } }
  if (nb) { const s = INFO_ITEMS.get(nb.dataset.nbFor); if (s) { buzz(); renderNearby(nb.closest('.info').querySelector('.nearby'), s, nb.dataset.nb); } }
});

function renderSpots() {
  // 検索欄は作り直さない（入力中にほかの更新が来てもフォーカスを失わないように）
  if (!$('#spot-list')) $('#view').innerHTML = '<div id="spot-list"></div>';
  if (!$('#q')) {
    $('#search-slot').innerHTML = `<input id="q" type="search" enterkeyhint="search" autocomplete="off" placeholder="名前・料理で探す（例：じんだいじ、ラーメン）" aria-label="名前で探す">`;
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
    // グルメ・史跡・宿・お土産なども、移動時間の範囲（制限なしは 60km）の分を読み込んで探す
    const groups = ['food', 'heritage', 'local'];
    ensureCells(groups, DATA.cfg.origin, loadKm()).then((changed) => { if (changed && state.tab === 'spots') renderSpotList(); });
    const all = DATA.spots.concat(DATA.osm, poiSpotList(), cellItems(groups, DATA.cfg.origin, loadKm()).filter((s) => state.showChains || !s.chain));
    const hits = Lib.searchSpots(all, state.q, DATA.cfg, state.favs, state.mode, 300);
    // OpenPOI API（ネットの施設検索）でも探す。手元のデータにない場所だけ、下にまとめて出す
    const net = openPoiFor(state.q, DATA.cfg.origin, Math.min(loadKm(), 60));
    const netHits = (net.items ? Lib.notInLocal(net.items, hits) : []).map((x) => withMinutes(x)).sort((a, b) => a.minutes - b.minutes);
    setCount(null);
    box.innerHTML = `<p class="status">「${esc(state.q.trim())}」の検索結果 ${hits.length}件（近い順・上位300件。グルメなどは${state.maxMin == null ? '起点から60km' : '移動時間の範囲'}以内${cellLoading.size ? '・読み込み中…' : ''}）</p>`
      + mapToggle()
      + (!hits.length ? '<p class="empty">見つかりませんでした。ひらがなや別の呼び方でも試してください。</p>'
        : state.spotMap ? '<div id="spot-map"></div>' : hits.slice(0, 100).map(spotCard).join(''))
      + netSection(net, netHits);
    bindMapToggle(state.spotMap ? hits.concat(netHits) : hits);
    return;
  }
  const list = Lib.filterSpots(spotCandidates(), filterState(), DATA.cfg);
  setCount(list.length);
  const failed = FAILED.has('data/spots.json');
  const groups = selectedGroups();
  const toggles = [
    `<button type="button" class="chip" id="t-gacha">🎲おまかせ</button>`,
    `<button type="button" class="chip" id="t-open" aria-pressed="${state.openOnly}">🕘営業中だけ</button>`,
    `<button type="button" class="chip" id="t-season" aria-pressed="${state.seasonOnly}">🌸今が見頃</button>`,
    `<button type="button" class="chip" id="t-iso" aria-pressed="${state.isoOn}">⏱今から行ける（道のりで判定）</button>`,
    (state.genres.has('factory') || state.genres.has('experience')) ? `<button type="button" class="chip" id="t-walkin" aria-pressed="${state.walkinOnly}">当日参加OKだけ</button>` : '',
    groups.includes('food') ? `<button type="button" class="chip" id="t-chain" aria-pressed="${state.showChains}">チェーン店も表示</button>` : '',
  ].join('');
  const cats = groups.includes('food') ? `<div class="chips wrap" aria-label="料理のジャンル">${Lib.FOOD_CATS.map(([label]) =>
    `<button type="button" class="chip" data-foodcat="${esc(label)}" aria-pressed="${state.foodCat === label}">${esc(label)}</button>`).join('')}</div>` : '';
  const loadingCells = groups.length && cellLoading.size ? '・データを読み込み中…' : '';
  const noCells = groups.length && !cellIndex ? '・グルメなどのデータはまだ収集されていません' : '';
  const head = `<p class="status">${list.length.toLocaleString()}件・★厳選と⭐を先頭に表示${rainy() ? '（雨の日モード：屋内のみ）' : ''}${groups.length && state.maxMin == null ? '・グルメなどは起点から60km以内' : ''}${loadingCells}${noCells}${isoStatus()}</p>
    ${toggles ? `<div class="chips wrap">${toggles}</div>` : ''}${cats}${list.length ? mapToggle() : ''}`;
  const more = list.length > state.limit ? `<button type="button" class="btn" id="more">もっと見る（残り${(list.length - state.limit).toLocaleString()}件）</button>` : '';
  const g = state.gacha && list.find((s) => s.id === state.gacha);
  const gacha = g ? `<div class="gacha"><p class="status">🎲 おまかせで選びました（${list.length.toLocaleString()}件から）</p>${spotCard(g)}
    <div class="actions"><button type="button" class="btn primary" id="gacha-again">もう一回</button><button type="button" class="btn" id="gacha-close">閉じる</button></div></div>` : '';
  box.innerHTML = head + gacha + (list.length ? (state.spotMap ? '<div id="spot-map"></div>' : list.slice(0, state.limit).map(spotCard).join('') + more)
    : `<p class="empty">${failed ? 'スポットのデータを読み込めていません。電波の良い場所で開き直してください。'
      : !DATA.osmLoaded ? 'スポットを読み込み中…' : '条件に合うスポットがありません。条件を広げてみてください。'}</p>`);
  if (more && !state.spotMap) $('#more').onclick = () => { state.limit += 300; renderSpotList(); };
  const tw = $('#t-walkin'); if (tw) tw.onclick = () => { buzz(); state.walkinOnly = !state.walkinOnly; renderSpotList(); };
  const tc = $('#t-chain'); if (tc) tc.onclick = () => { buzz(); state.showChains = !state.showChains; renderSpotList(); };
  $('#t-gacha').onclick = () => { buzz(); spin(list); };
  const ga = $('#gacha-again'); if (ga) ga.onclick = () => { buzz(); spin(list); };
  const gc = $('#gacha-close'); if (gc) gc.onclick = () => { state.gacha = null; renderSpotList(); };
  $('#t-open').onclick = () => { buzz(); state.openOnly = !state.openOnly; state.limit = 300; renderSpotList(); };
  $('#t-iso').onclick = () => { buzz(); state.isoOn = !state.isoOn; state.limit = 300; renderSpotList(); };
  $('#t-season').onclick = () => { buzz(); state.seasonOnly = !state.seasonOnly; state.limit = 300; renderSpotList(); };
  box.querySelectorAll('[data-foodcat]').forEach((b) => { b.onclick = () => {
    buzz(); state.foodCat = state.foodCat === b.dataset.foodcat ? '' : b.dataset.foodcat; state.limit = 300; renderSpotList();
  }; });
  bindMapToggle(list);
}

// ---- 地図の共通部品: 背景（地図・航空写真・地理院地図）と陰影起伏、現在地ボタン ----
function baseLayers(m, credit = '') {
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18,
    attribution: `&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>${credit}` });
  const gsi = (id, ext, z = 18) => L.tileLayer(`https://cyberjapandata.gsi.go.jp/xyz/${id}/{z}/{x}/{y}.${ext}`, { maxZoom: 18, maxNativeZoom: z,
    attribution: `<a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>${credit}` });
  const std = gsi('std', 'png');
  (navigator.onLine === false ? std : osm).addTo(m); // 圏外では保存した地理院地図を使う
  L.control.layers({ '地図': osm, '航空写真': gsi('seamlessphoto', 'jpg'), '地理院地図': std },
    { '陰影（山の起伏）': L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/hillshademap/{z}/{x}/{y}.png', { maxZoom: 18, maxNativeZoom: 16, opacity: 0.4 }) },
    { position: 'topright' }).addTo(m);
  const Locate = L.Control.extend({ options: { position: 'topleft' }, onAdd() {
    const b = L.DomUtil.create('a', 'leaflet-bar locate'); b.href = '#'; b.title = '現在地'; b.setAttribute('role', 'button'); b.textContent = '◎';
    L.DomEvent.on(b, 'click', (e) => { L.DomEvent.stop(e); locate(m); });
    return b;
  } });
  new Locate().addTo(m);
}
let hereMarker = null;
function locate(m) {
  if (!navigator.geolocation) { alert('この端末では現在地を使えません。'); return; }
  navigator.geolocation.getCurrentPosition((p) => {
    const ll = [p.coords.latitude, p.coords.longitude];
    if (hereMarker) hereMarker.remove();
    hereMarker = L.circleMarker(ll, { radius: 8, weight: 3, color: '#fff', fillColor: '#1a73e8', fillOpacity: 1 }).bindTooltip('現在地').addTo(m);
    m.setView(ll, Math.max(m.getZoom(), 14));
  }, () => alert('現在地を取得できませんでした（位置情報の許可を確認してください）。'), { enableHighAccuracy: true, timeout: 10000 });
}

// おまかせ: 前回と違う 1 か所を選ぶ（★厳選・公式サイトのある所を少し出やすく）
function spin(list) {
  if (!list.length) { alert('条件に合うスポットがありません。条件を広げてください。'); return; }
  const pool = list.length > 1 ? list.filter((s) => s.id !== state.gacha) : list;
  const w = pool.map((s) => (s.tier === 0 ? 4 : s.tier === 1 ? 2 : 1));
  let r = Math.random() * w.reduce((a, b) => a + b, 0), i = 0;
  while ((r -= w[i]) > 0) i++;
  state.gacha = pool[i].id;
  renderSpotList();
  const el = document.querySelector('.gacha'); if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// ---- OpenPOI API: 入力が止まってから 0.6 秒後に 1 回だけ問い合わせる（同じ語・範囲は覚えておく） ----
const OPOI = new Map(); // 'q|lat,lon|km' → { busy, items, error }
let opoiTimer = 0;
function openPoiFor(q, p, km, onDone = () => { if (state.tab === 'spots') renderSpotList(); }) {
  const t = String(q).trim();
  if (t.length < 2 || navigator.onLine === false) return {};
  const key = `${t}|${p.lat.toFixed(3)},${p.lon.toFixed(3)}|${Math.round(km)}`;
  if (OPOI.has(key)) return OPOI.get(key);
  const v = { busy: true };
  clearTimeout(opoiTimer);
  opoiTimer = setTimeout(async () => {
    OPOI.set(key, v);
    try {
      const r = await fetch(Lib.openPoiUrl(t, p, km, 100), { signal: timeoutSignal(10000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      v.items = Lib.parseOpenPoi(await r.json());
    } catch { v.error = true; }
    v.busy = false;
    onDone();
  }, 600);
  return v;
}
const withMinutes = (x) => ({ ...x, minutes: Lib.travelMinutes(Lib.haversineKm(DATA.cfg.origin, x), state.mode, DATA.cfg), tier: 2 });
function netSection(net, xs) {
  if (!net || (!net.busy && !net.items && !net.error)) return '';
  const credit = '<p class="credit">施設データ：<a href="https://openpoiapi.com/attribution.html" target="_blank" rel="noopener">OpenPOI API（Overture Maps・食品営業許可のオープンデータ）出典・ライセンス</a></p>';
  if (net.busy) return '<h4 class="newdir">🌐 ネットでも探しています（OpenPOI）…</h4>';
  if (net.error) return '<p class="hint">ネットの施設検索（OpenPOI）に接続できませんでした。</p>';
  return `<h4 class="newdir">🌐 ネットで見つかった施設（OpenPOI・${xs.length}件・近い順）</h4>`
    + (xs.length ? xs.slice(0, 50).map(spotCard).join('') : '<p class="hint">手元のデータにない施設は見つかりませんでした。</p>') + credit;
}

// ---- 今から行ける範囲（実際の道のりで、移動時間内に着ける範囲。Valhalla の到達圏） ----
const ISO = new Map(); // 'mode|分|起点' → GeoJSON の形（読み込み中は 'loading'、失敗は 'fail'）
const isoKey = () => `${state.mode}|${state.maxMin}|${DATA.cfg.origin.lat},${DATA.cfg.origin.lon}`;
const isoAvailable = () => !!Lib.isochroneUrl(DATA.cfg.origin, state.mode, [30]) && state.maxMin != null && state.maxMin <= 120;
function isoGeom() {
  if (!state.isoOn || !isoAvailable()) return null;
  const g = ISO.get(isoKey());
  return g && typeof g === 'object' ? g : null;
}
async function loadIso() {
  const key = isoKey();
  if (ISO.has(key)) return;
  ISO.set(key, 'loading');
  try {
    const r = await fetch(Lib.isochroneUrl(DATA.cfg.origin, state.mode, [state.maxMin]), { signal: timeoutSignal(20000) });
    const j = await r.json();
    ISO.set(key, (j.features || [])[0] ? j.features[0].geometry : 'fail');
  } catch { ISO.set(key, 'fail'); }
  if (state.tab === 'spots') renderSpotList();
}
const isoStatus = () => {
  if (!state.isoOn) return '';
  if (!isoAvailable()) return '・道のりの判定は車・バイク・自転車の2時間以内だけ';
  const g = ISO.get(isoKey());
  return g === 'loading' || !g ? '・道のりで判定中…' : g === 'fail' ? '・道のりの判定に失敗（直線距離で表示）' : `・実際の道のりで${state.maxMin}分以内`;
};

// ---- 候補を地図で見る（一覧・検索結果の上位 2,000 件。★厳選・⭐は大きい点） ----
let spotMap = null;
const SPOT_MAP_MAX = 2000;
const mapToggle = () => `<div class="actions"><button type="button" class="btn" id="t-map">${state.spotMap ? '☰ 一覧で見る' : '🗺 地図で見る'}</button></div>`;
function bindMapToggle(list) {
  const t = $('#t-map'); if (t) t.onclick = () => { buzz(); state.spotMap = !state.spotMap; renderSpotList(); };
  if (spotMap) { spotMap.remove(); spotMap = null; }
  if (!state.spotMap || !$('#spot-map') || typeof L === 'undefined') return;
  spotMap = L.map('spot-map', { renderer: L.canvas({ tolerance: 8 }) }).setView([DATA.cfg.origin.lat, DATA.cfg.origin.lon], 10);
  baseLayers(spotMap);
  L.circleMarker([DATA.cfg.origin.lat, DATA.cfg.origin.lon], { radius: 7, color: '#000', fillColor: '#fff', fillOpacity: 1, weight: 3 })
    .bindTooltip(esc(DATA.cfg.origin.name)).addTo(spotMap);
  const g = isoGeom();
  if (g) L.geoJSON(g, { style: { color: '#1a73e8', weight: 2, fillOpacity: 0.08 }, interactive: false }).addTo(spotMap);
  const shown = list.slice(0, SPOT_MAP_MAX);
  for (const s of shown) {
    const top = s.tier === 0;
    L.circleMarker([s.lat, s.lon], { radius: top ? 8 : 6, weight: 2, color: '#fff', fillOpacity: 0.9,
      fillColor: top ? '#d4a000' : s.genres.includes('food') ? '#c4302b' : '#0055ad' })
      .bindPopup(() => spotPopup(s), { maxWidth: 260 })
      .on('popupopen', (e) => fillAddr(e.popup.getElement()))
      .addTo(spotMap);
  }
  if (shown.length) spotMap.fitBounds(L.latLngBounds(shown.map((s) => [s.lat, s.lon])).pad(0.05), { maxZoom: 14 });
}
function spotPopup(s) {
  return `<div class="pop"><strong>${isCurated(s) ? '★ ' : ''}${s.genres.map((g) => icon(GENRES[g] || '・')).join('')} ${esc(s.name)}</strong>
    <p class="meta">${icon(MODES[state.mode])}${fmtMin(s.minutes)}${s.indoor ? '・☔雨OK' : ''}${'walkin' in s ? (s.walkin ? '・当日参加OK' : '・要予約') : ''}</p>
    ${s.note ? `<p>${esc(s.note)}</p>` : ''}
    <div class="actions"><a class="btn" ${gm(s, 'dir')}>経路</a><a class="btn" ${gm(s)}>写真・口コミ</a></div></div>`;
}
// ---- Google マップの写真（設定タブで API キーを入れたときだけ。規約に沿って写真は端末に保存しない） ----
async function googlePhotos(s) {
  const key = store.get('gkey');
  if (!key || s.lat == null) return null;
  const r = await fetch(Lib.PLACES_URL, { method: 'POST', body: Lib.placesBody(s), signal: timeoutSignal(8000),
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.location,places.photos,places.googleMapsUri' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Lib.parsePlacesPhotos(await r.json(), s, key);
}
async function fillGooglePhotos(el, s) {
  if (!el || !store.get('gkey')) return;
  el.innerHTML = '<p class="hint">Google マップの写真を読み込み中…</p>';
  try {
    const g = await googlePhotos(s);
    el.innerHTML = g && g.photos.length ? `<div class="photos">${g.photos.map((p) => `<a href="${esc(g.page || p.artistUri)}" target="_blank" rel="noopener">
      <img src="${esc(p.thumb)}" alt="${esc(s.name)}の写真" loading="lazy"><span class="credit">${p.artist ? '撮影: ' + esc(p.artist) + ' / ' : ''}Google マップ</span></a>`).join('')}</div>`
      : '<p class="hint">Google マップにこの場所の写真は見つかりませんでした。</p>';
  } catch (err) {
    el.innerHTML = `<p class="hint">Google マップの写真を読み込めませんでした（${/HTTP 4/.test(err.message) ? 'API キーと、Places API (New) が有効になっているかを確認してください' : '圏外か混雑の可能性'}）。</p>`;
  }
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
  if (cached && cached.ver === 2) return cached; // 写真の探し方を変えたので、古い保存分は取り直す
  const ref = Lib.wikiRef(s);
  let summary = null, photos = [], failed = false;
  if (ref) {
    try { summary = Lib.parseSummary(await fetchJSON(Lib.summaryUrl(ref))); } catch (err) { if (!/HTTP 404/.test(err.message)) failed = true; }
  }
  if (!summary || !summary.thumb) {
    // まず施設名で（関係のある写真）、少なければ 1km 以内で撮られた写真も
    try { photos = Lib.parseCommons(await fetchJSON(Lib.commonsSearchUrl(s.name, 4))).map((p) => ({ ...p, byName: true })); } catch { failed = true; }
    if (photos.length < 2) {
      try {
        const seen = new Set(photos.map((p) => p.page));
        photos = photos.concat(Lib.parseCommons(await fetchJSON(Lib.commonsNearbyUrl(s.lat, s.lon, 1000, 4))).filter((p) => !seen.has(p.page)));
      } catch { failed = true; }
    }
  }
  const v = { summary, photos, ver: 2 };
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
    <a class="btn" ${gm(s)}>Googleマップで写真・口コミを見る</a>
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
      <a ${gm(x)}>${(x.genres || []).map((g) => icon(GENRES[g] || '・')).join('')} ${esc(x.name)}</a>
      <span class="status">${x.distKm < 1 ? Math.round(x.distKm * 1000) + 'm' : x.distKm.toFixed(1) + 'km'}${x.note ? '・' + esc(x.note) : ''}</span></li>`).join('')}</ul>` : '');
    el.innerHTML = list('似たスポット', rel.similar) + list('周辺のスポット（2km以内）', rel.nearby)
      + list('近くのカフェ・食事（1km以内）', rel.food)
      + (!rel.food.length && cellIndex ? '<p class="hint">1km以内のカフェ・食事は見つかりませんでした。</p>' : '')
      + (!cellIndex ? '<p class="hint">カフェ・食事のデータはまだ収集されていません。</p>' : '');
  };
  draw();
  if (await ensureCells(['food', 'heritage', 'local'], s, 2)) draw();
  fillAddr(el);
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
    parts.push(`<p class="credit"><strong>${v.photos[0].byName ? '写真' : '付近の写真'}</strong>（Wikimedia Commons。${v.photos.some((p) => !p.byName) ? '付近の写真は約1km以内で撮られたもので、関係のない写真が含まれることがあります' : '名前で探した写真です'}）</p><div class="photos">`
      + v.photos.map((p) => `<a href="${esc(p.page)}" target="_blank" rel="noopener"><img src="${esc(p.thumb)}" alt="付近の写真" loading="lazy">
        <span class="credit">${p.artist ? '撮影: ' + esc(p.artist) + ' / ' : ''}${esc(p.license) || 'ライセンスはリンク先'}</span></a>`).join('') + '</div>');
  } else if (!(v.summary && v.summary.thumb) && !store.get('gkey')) {
    parts.push('<p class="hint">写真は見つかりませんでした（設定タブで Google の API キーを入れると、Google マップの写真も出せます）。</p>');
  }
  if (v.failed) parts.push('<p class="hint">一部を読み込めませんでした（圏外の可能性があります）。電波の良い場所でもう一度開いてください。</p>');
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
  const isCard = !!b.closest('article.card');
  if (isCard && !box.dataset.built) { box.innerHTML = infoShell(s); box.dataset.built = '1'; }
  const body = box.querySelector('.info-body') || box; // スポットのカードはボタン類を残して、写真と説明だけ入れる
  body.innerHTML = '<p class="hint">読み込み中…</p>';
  const v = await loadInfo(s);
  body.innerHTML = '<div class="gphotos"></div>' + infoHtml(s, v) + `${s.booking ? `<p class="hint">予約: ${esc(s.booking)}</p>` : ''}${extraInfo(s)}<div class="related"></div>`;
  fillGooglePhotos(body.querySelector('.gphotos'), s);
  if (!v.failed) box.dataset.loaded = '1';
  if (!isCard) body.insertAdjacentHTML('beforeend', `<div class="actions"><a class="btn" ${gm(s)}>Googleマップで写真・口コミを見る</a></div>`);
  fillRelated(body.querySelector('.related'), s);
  fillAddr(box);
});
document.addEventListener('click', (e) => {
  const fav = e.target.closest('[data-fav]'), vis = e.target.closest('[data-visited]');
  if (fav) { buzz(); toggle(state.favs, fav.dataset.fav); store.set('favs', [...state.favs]); fav.setAttribute('aria-pressed', state.favs.has(fav.dataset.fav)); }
  if (vis) {
    buzz(); toggle(state.visited, vis.dataset.visited); store.set('visited', [...state.visited]); vis.setAttribute('aria-pressed', state.visited.has(vis.dataset.visited));
    const s = INFO_ITEMS.get(vis.dataset.visited), meta = store.get('visitedMeta') || {};
    if (state.visited.has(vis.dataset.visited) && s) meta[s.id] = { name: s.name, lat: s.lat, lon: s.lon, pref: s.pref, at: Date.now() };
    else delete meta[vis.dataset.visited];
    store.set('visitedMeta', meta);
  }
});

// ---- 今週末のおすすめ ----
function renderRecommend() {
  const cands = Lib.filterSpots(DATA.spots, { ...filterState(), genres: new Set() }, DATA.cfg);
  const ctx = { favGenres: state.favGenres, rainy: rainy(), visited: state.visited };
  const rec = Lib.pickRecommendations(cands, ctx, Lib.weekSeed(new Date()));
  $('#recommend').innerHTML = weatherPlanHtml(cands) + rec.map(spotCard).join('') + newDirHtml(rec);
  $('#rec').hidden = !rec.length;
  if (!WPLAN.loaded) loadWeatherPlan();
}
// まだ行っていない（行った記録の少ない）方面から 2 方面、各 2 か所。週ごとに入れ替わる
function newDirHtml(shown) {
  const recs = visitedRecords();
  const skip = new Set(shown.map((s) => s.id).concat([...state.visited]));
  const seed = Lib.weekSeed(new Date());
  const out = [];
  for (const d of Lib.lessVisitedDirs(recs, DATA.cfg.origin, seed)) {
    const cands = Lib.filterSpots(DATA.spots, { ...filterState(), genres: new Set(), dirs: new Set([d.dir]) }, DATA.cfg).filter((s) => !skip.has(s.id));
    const xs = Lib.pickRecommendations(cands, { favGenres: state.favGenres, rainy: rainy(), visited: state.visited }, seed + out.length).slice(0, 2);
    if (!xs.length) continue;
    xs.forEach((s) => skip.add(s.id));
    out.push(`<h4 class="newdir">🧭まだ${d.count ? 'あまり' : ''}行っていない「${esc(dirName(d.dir))}」方面${d.count ? `（行った記録 ${d.count}か所）` : ''}</h4>${xs.map(spotCard).join('')}`);
    if (out.length >= 2) break;
  }
  return out.length ? `<div class="newdirs">${out.join('')}<p class="hint">「▼詳しく」→「行った」を押すと、行った記録の少ない方面を優先して提案します。</p></div>` : '';
}
// 週末の午前・午後の降水確率を見て、晴れの時間は屋外、雨の時間は屋内のスポットを当てる
const WPLAN = { loaded: false, days: null };
async function loadWeatherPlan() {
  WPLAN.loaded = true;
  const { lat, lon } = DATA.cfg.origin;
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=precipitation_probability&timezone=Asia%2FTokyo&forecast_days=10`, { signal: timeoutSignal(8000) });
    const h = (await r.json()).hourly;
    WPLAN.days = Lib.weekend(new Date()).map((key) => {
      const day = new Date(`${key}T00:00:00`), max = (a, b) => Math.max(...h.time.map((t, i) => (t.startsWith(key) && +t.slice(11, 13) >= a && +t.slice(11, 13) < b ? h.precipitation_probability[i] : -1)));
      return { day, am: max(9, 12), pm: max(12, 17) };
    }).filter((d) => d.am >= 0);
  } catch { WPLAN.days = null; }
  renderRecommend();
}
function weatherPlanHtml(cands) {
  if (!WPLAN.days || !WPLAN.days.length) return '';
  const used = new Set(), seed = Lib.weekSeed(new Date());
  const pick = (wet, k) => {
    const xs = Lib.pickRecommendations(cands.filter((s) => !used.has(s.id) && (wet ? s.indoor : !s.indoor)),
      { favGenres: state.favGenres, rainy: wet, visited: state.visited }, seed + k);
    if (xs[0]) used.add(xs[0].id);
    return xs[0];
  };
  const slot = (label, p, k) => { const wet = p >= 50, s = pick(wet, k);
    return `<li>${label} ${wet ? '☔' : '☀'}${p}% → ${s ? `<a ${gm(s)}>${esc(s.name)}</a>${wet ? '（屋内）' : ''}` : '—'}</li>`; };
  return `<div class="wplan"><strong>天気で選んだ週末プラン</strong><ul>${WPLAN.days.map((d, i) => `<li>${d.day.getMonth() + 1}/${d.day.getDate()}（${'日月火水木金土'[d.day.getDay()]}）<ul>
    ${slot('午前', d.am, i * 2)}${slot('午後', d.pm, i * 2 + 1)}</ul></li>`).join('')}</ul>
    <p class="hint">降水確率50%以上の時間は屋内のスポットにしています（天気: Open-Meteo）。</p></div>`;
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
  // 持ち主とリポジトリ名は公開 URL（<owner>.github.io/<repo>/）から求める。config に書いてあればそちらを使う
  const { workflow, branch } = DATA.cfg.github;
  const owner = DATA.cfg.github.owner || location.hostname.split('.')[0];
  const repo = DATA.cfg.github.repo || location.pathname.split('/')[1];
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
  picked: new Set(savedTour.picked || []), error: '', busy: false, awake: store.get('awake') !== false, stops: null, key: '',
  showCourses: store.get('showCourses') === true, depart: savedTour.depart || '' };
tour.restored = !!tour.cands;
Object.defineProperty(tour, 'route', { get: () => (tour.cands && tour.cands[tour.sel]) || null });
let map = null, markers = new Map();
const saveTour = () => store.set('tour', { destId: tour.destId, custom: tour.custom, roadId: tour.roadId, opts: tour.opts, radius: tour.radius,
  cands: tour.cands, sel: tour.sel, picked: [...tour.picked], depart: tour.depart });
const keyColor = () => getComputedStyle(document.documentElement).getPropertyValue('--key').trim() || '#0017c1';
const fail = (msg) => Object.assign(new Error(msg), { mine: true });
const roadById = (id) => DATA.roads.find((r) => r.id === id) || DATA.courses.find((r) => r.id === id) || null;
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
    ・景色 ${'★'.repeat(c.stars)}${'☆'.repeat(5 - c.stars)}（展望台など${c.spots}か所${c.roadKm >= 1 ? `・おすすめの道${Math.round(c.roadKm)}km` : ''}）
    ・カーブ ${'★'.repeat(curvOf(c))}${'☆'.repeat(5 - curvOf(c))}</span></button>`;
const curvOf = (c) => (c.curvStars = c.curvStars || Lib.curvStars(Lib.curviness(c.line)));

function renderTouring() {
  const dest = currentDest();
  const key = JSON.stringify([tour.destId, tour.custom, tour.roadId, tour.route && tour.route.at, tour.sel, tour.radius, tour.error, tour.busy, DATA.ver,
    !!DATA.touring.length, DATA.roads.length, DATA.courses.length, tour.showCourses, navigator.onLine, tour.restored, tour.opts]);
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
      ${DATA.roads.length ? `<optgroup label="おすすめの道を走る（近い20本・ほかは下の検索か地図で）">${roadsByDist.slice(0, 20).concat(
        road && !roadsByDist.slice(0, 20).includes(road) ? [road] : []).map((r) =>
        `<option value="road:${esc(r.id)}" ${r.id === tour.roadId ? 'selected' : ''}>${esc(r.name)}${r.toll ? '（有料）' : ''}</option>`).join('')}</optgroup>` : ''}
      ${tour.custom ? `<option selected>${esc(tour.custom.name)}</option>` : ''}</select>
    <div class="dest-search"><input id="dq" type="search" enterkeyhint="search" autocomplete="off" placeholder="目的地を検索（例：じんだいじ、河口湖、箱根町）" aria-label="目的地を検索">
      <button type="button" class="btn" id="dq-go">検索</button></div>
    <div id="dq-results"></div>
    <div class="actions"><button type="button" class="btn primary" id="route-go" ${dest && !tour.busy ? '' : 'disabled'}>${tour.busy ? '検索中…（候補を比べています）' : dest ? 'ルート候補を探す' : '目的地を選ぶと押せます'}</button></div>
    <div class="map-wrap"><div id="map"></div><span class="crosshair" aria-hidden="true">＋</span>
      <button type="button" class="btn map-pick" id="pick-center">中心を目的地に</button></div>
    <p class="hint">目的地は、選ぶ・検索する・地図を長押し（または中央の＋を合わせて「中心を目的地に」）で指定</p>
    ${road ? `<p class="notice">${closedNow ? '⚠ <strong>今月は通行止め・閉鎖の期間です。</strong>' : ''}${road.toll ? `有料道路（${road.fee ? esc(road.fee) : '料金は公式サイトで確認'}）。` : ''}${esc(road.note)}${road.closed ? `<br>⚠ ${esc(road.closed)}` : ''}</p>`
      : dest && dest.note ? `<p class="notice">⚠ ${esc(dest.note)}</p>` : ''}
    ${sns ? `<div class="actions"><a class="btn" href="${esc(sns.x)}" target="_blank" rel="noopener">#X で最新情報</a><a class="btn" href="${esc(sns.instagram)}" target="_blank" rel="noopener">#Instagram</a></div>` : ''}
    <details class="tools" id="tour-opts" ${store.get('tourOptsOpen') ? 'open' : ''}><summary>⚙走り方・立ち寄りの範囲（${optSummary()}）</summary>
    <fieldset class="opts"><legend><strong>走り方</strong></legend>
      <label class="check"><input type="checkbox" data-opt="noToll" ${tour.opts.noToll ? 'checked' : ''}>有料道路を使わない</label>
      <label class="check"><input type="checkbox" data-opt="fewHighways" ${tour.opts.fewHighways ? 'checked' : ''}>高速道路をなるべく使わない</label>
      <label class="check"><input type="checkbox" data-opt="bike" ${tour.opts.bike ? 'checked' : ''}>バイク向け（幹線を避け、地方の道を好む）</label>
    </fieldset>
    <div class="row"><span class="label">立寄</span><div id="radius" class="chips"></div></div>
    <label class="check"><input type="checkbox" id="awake" ${tour.awake ? 'checked' : ''}>このタブを開いている間は画面を消さない</label></details>
    <label class="check"><input type="checkbox" id="show-courses" ${tour.showCourses ? 'checked' : ''}>ドライブコース（${(DATA.roads.length + DATA.courses.length).toLocaleString()}本）と峠（${DATA.passes.length.toLocaleString()}か所）を地図に表示</label>
    ${tour.showCourses ? curvyHtml() : ''}
    <details class="tools"><summary>🧭方面別の雨・🏍走行記録・閉鎖中の道</summary>
      <div class="actions"><button type="button" class="btn" id="dir-rain">🧭方面別の雨（出発日の9〜17時）</button></div><div id="dir-out"></div>
      <h4>🏍走行記録（GPS）</h4><p class="status" id="trk-msg">${trackText()}</p>
      <div class="actions"><button type="button" class="btn ${track.on ? '' : 'primary'}" id="trk-toggle">${track.on ? '⏹記録を止める' : '⏺記録を始める'}</button>
        <button type="button" class="btn" id="trk-gpx" ${track.pts.length > 1 ? '' : 'disabled'}>記録をGPXで保存</button>
        <button type="button" class="btn" id="trk-clear" ${track.pts.length ? '' : 'disabled'}>記録を消す</button></div>
      <p class="hint">記録中は画面をつけたままにしてください（画面が消えると止まる端末があります）。記録は端末の中にだけ保存します。</p>
      ${closedListHtml()}</details>
    ${tour.error ? `<p class="notice">${esc(tour.error)}</p>` : ''}
    ${tour.route && (tour.restored || offline) ? `<p class="notice">${offline ? '📴 圏外のため、' : ''}${fmtStamp(tour.route.at || 0)} に検索して保存したルートを表示しています${offline ? '' : '（再検索で更新）'}。</p>` : ''}
    ${routeStale() ? '<p class="notice">⚠ 走り方を変えました。「ルート候補を探す」で探し直してください（このままナビを開くと、ルートを固定する地点なしで Google マップに渡します）。</p>' : ''}
    ${tour.cands && tour.cands.length ? `<h2>ルート候補（${tour.cands.length}本${tour.cands.length > 1 ? '・押して切り替え' : ''}）</h2><div class="cands">${tour.cands.map(candCard).join('')}</div>` : ''}
    ${tour.route ? `<p class="route-sum">${esc(tour.route.label)}：約${Math.round(tour.route.km)}km・${fmtMin(Math.round(tour.route.min))}</p>
      <p class="hint">${esc(tour.route.engine || 'OSRM')} による推定${tour.route.note ? '。' + esc(tour.route.note) : ''}${tour.opts.noToll || tour.opts.fewHighways ? '。Google マップでは「ルートオプション」でも同じ設定にしてください' : ''}</p>
      ${dest && !dest.loop ? viaRoads.map((r) => `<p class="notice">「${esc(r.name)}」${(r.closedMonths || []).includes(thisMonth()) ? '⚠ <strong>今月は通行止め・閉鎖の期間です。</strong>' : ''}${r.toll ? `有料道路（${r.fee ? esc(r.fee) : '料金は公式サイトで確認'}）。` : ''}${r.closed ? `⚠ ${esc(r.closed)}` : ''}</p>`).join('') : ''}
      <p class="hint">ナビは Google マップのアプリで開いてください（ブラウザ版の Google マップは経由地が 3 件までしか使えません）。</p>
      <div class="row"><label for="depart" class="label">出発</label><input type="datetime-local" id="depart" value="${esc(departValue())}"></div>
      <p class="status" id="eta">${etaText()}</p>
      <div class="actions"><button type="button" class="btn" id="rt-rain">☔ルート上の雨</button><button type="button" class="btn" id="rt-elev">⛰標高</button>
        <button type="button" class="btn" id="rt-photo">📷ルート沿いの写真</button>
        <button type="button" class="btn" id="rt-onsen">♨帰りに寄れる温泉</button></div>
      <div class="actions"><button type="button" class="btn" id="rt-save-map">📥ルート沿いの地図を保存（圏外用）</button></div>
      <p class="status" id="rt-save-msg"></p>
      <div id="rt-out"></div>
      ${closedHtml()}` : ''}
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
  const dp = $('#depart');
  if (dp) {
    dp.onchange = (e) => { tour.depart = e.target.value; saveTour(); $('#eta').textContent = etaText(); };
    $('#rt-rain').onclick = () => { buzz(); routeRain(); };
    $('#rt-elev').onclick = () => { buzz(); routeElevation(); };
    $('#rt-photo').onclick = () => { buzz(); routePhotos(); };
    $('#rt-onsen').onclick = () => { buzz(); routeOnsen(); };
  }
  $('#dir-rain').onclick = () => { buzz(); dirRain(); };
  $('#trk-toggle').onclick = () => { buzz(); toggleTrack(); };
  $('#trk-gpx').onclick = () => { buzz(); saveTrackGpx(); };
  $('#trk-clear').onclick = () => { if (confirm('走行記録を消しますか？')) { track.pts = []; saveTrack(); tour.key = ''; renderTouring(); } };
  const sm = $('#rt-save-map'); if (sm) sm.onclick = () => { buzz(); saveRouteTiles(); };
  bindCourseBtns($('#curvy'));
  $('#tour-opts').addEventListener('toggle', (e) => store.set('tourOptsOpen', e.target.open));
  $('#show-courses').onchange = (e) => { tour.showCourses = e.target.checked; store.set('showCourses', tour.showCourses); renderTouring(); };
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

// コースと峠を名前で探せるように（データが変わったときだけ作り直す）
let courseItems = { ver: -1, items: [] };
function courseSearchItems() {
  if (courseItems.ver !== DATA.ver) {
    courseItems = { ver: DATA.ver, items: DATA.roads.concat(DATA.courses, DATA.passes).map((r) =>
      ({ id: r.id, name: r.name, kana: r.kana, note: r.note, tags: r.tags, pass: !!r.pass, lat: r.points[0][0], lon: r.points[0][1], genres: [] })) };
  }
  return courseItems.items;
}
// ---- 目的地の検索: 入力中はアプリ内のスポットから（通信なし）、「検索」で国土地理院の地名・住所検索も ----
const dqState = { q: '', places: null, busy: false, error: '', focused: false, items: [] };
function renderDestResults() {
  const box = $('#dq-results'); if (!box) return;
  const q = dqState.q.trim();
  if (!q) { box.innerHTML = ''; dqState.items = []; return; }
  const spots = Lib.searchSpots(DATA.spots.concat(DATA.osm, poiSpotList()), q, DATA.cfg, state.favs, 'car', 6)
    .map((s) => ({ name: s.name, lat: s.lat, lon: s.lon, sub: `${s.genres.map((g) => icon(GENRES[g] || '・')).join('')} ${fmtMin(s.minutes)}` }));
  const places = (dqState.places || []).map((p) => ({ ...p, sub: '地名・住所' }));
  const roads = Lib.searchSpots(courseSearchItems(), q, DATA.cfg, state.favs, 'car', 6)
    .map((x) => ({ name: x.name, lat: x.lat, lon: x.lon, roadId: x.pass ? null : x.id, sub: `${x.pass ? '⛰ 峠' : '🛣 ドライブコース（周回）'} ${fmtMin(x.minutes)}` }));
  dqState.items = roads.concat(spots, places);
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
  const ok = x.roadId ? setDest(() => { tour.custom = null; tour.roadId = x.roadId; tour.destId = null; }) : setCustomDest(x.lat, x.lon, x.name);
  if (!ok) Object.assign(dqState, prev); // 変更をやめたら入力を戻す
});

function drawMap(dest, stops) {
  if (typeof L === 'undefined') { $('#map').textContent = '地図を読み込めませんでした（圏外の可能性があります）。'; return; }
  if (map) map.remove();
  markers = new Map();
  map = L.map('map', { renderer: L.canvas({ tolerance: 8 }) }).setView([DATA.cfg.origin.lat, DATA.cfg.origin.lon], 9);
  baseLayers(map, ' / ルート: Valhalla (FOSSGIS)・OSRM');
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
        if (!infoCache()[s.id] || infoCache()[s.id].ver !== 2) {
          const v = await loadInfo(s);
          if (m.isPopupOpen()) { m.setPopupContent(popupHtml(s, v)); refitPopup(m); }
        }
        const v = infoCache()[s.id];
        if (store.get('gkey') && !(v && v.summary && v.summary.thumb)) {
          try {
            const g = await googlePhotos(s);
            const pe = m.getPopup() && m.getPopup().getElement();
            if (g && g.photos[0] && pe && !pe.querySelector('.pop-img')) {
              pe.querySelector('.pop strong').insertAdjacentHTML('afterend', `<img class="pop-img" src="${esc(g.photos[0].thumb)}" alt=""><div class="credit">${g.photos[0].artist ? '撮影: ' + esc(g.photos[0].artist) + ' / ' : ''}Google マップ</div>`);
              refitPopup(m);
            }
          } catch { /* 写真なしのまま */ }
        }
        const el = m.getPopup() && m.getPopup().getElement();
        if (el) fillAddr(el);
      });
      markers.set(s.id, m);
    });
    map.fitBounds(line.getBounds(), { padding: [16, 16] });
  } else if (dest && dest.loop) {
    map.fitBounds(L.latLngBounds(dest.road.points.concat([[DATA.cfg.origin.lat, DATA.cfg.origin.lon]])), { padding: [16, 16] });
  }
  if (tour.showCourses) drawCourses();
  track.line = track.pts.length ? L.polyline(track.pts.map((p) => [p[0], p[1]]), { color: '#2f9e44', weight: 5 }).addTo(map) : null;
  // 誤操作を防ぐため、目的地の指定は長押し（スマホでは contextmenu として届く）か「中心を目的地に」ボタンだけ。
  // 長押し中（指が触れている間）に地図を作り直すと iPhone で次のタップが効かなくなることがあるので、少し遅らせる
  map.on('contextmenu', (e) => { buzz(); setTimeout(() => setCustomDest(e.latlng.lat, e.latlng.lng), 350); });
}

// 出発時刻（未設定なら次の正時）と到着予定
function departValue() {
  if (tour.depart) return tour.depart;
  const d = new Date(Date.now() + 3600e3); d.setMinutes(0, 0, 0);
  return `${Lib.ymd(d)}T${String(d.getHours()).padStart(2, '0')}:00`;
}
const departMs = () => new Date(departValue()).getTime();
const hm = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
function etaText() {
  if (!tour.route) return '';
  const back = tour.route.loop || (currentDest() && currentDest().loop);
  return `${back ? '帰着' : '到着'}予定 ${hm(departMs() + tour.route.min * 60e3)}（休憩・立ち寄りの時間は含みません）`;
}
async function routeRain() {
  const out = $('#rt-out'); out.innerHTML = '<p class="hint">ルート上の天気を調べています…</p>';
  const pts = Lib.routeSamples(tour.route.line, tour.route.min, departMs(), 8);
  try {
    const r = await fetch(Lib.rainAlongUrl(pts), { signal: timeoutSignal(10000) });
    const rows = Lib.parseRainAlong(await r.json(), pts);
    const wet = rows.filter((x) => x.prob != null && x.prob >= 50);
    out.innerHTML = `<h4>☔ルート上の雨（通過する時刻の予報）</h4>
      ${wet.length ? `<p class="notice">⚠ 降水確率50%以上の区間があります（${wet.map((x) => Math.round(x.km) + 'km').join('・')}付近）。</p>` : rows.some((x) => x.prob != null) ? '<p class="status">雨の心配は少なそうです。</p>' : ''}
      <table class="rain"><tr><th>距離</th><th>通過</th><th>降水確率</th><th>雨量</th></tr>${rows.map((x) => `<tr><td>${Math.round(x.km)}km</td><td>${hm(x.at)}</td>
        <td>${x.prob == null ? '予報の範囲外' : `${x.prob}%`}</td><td>${x.mm == null ? '' : `${x.mm}mm`}</td></tr>`).join('')}</table>
      <p class="hint">天気: Open-Meteo（7日先まで）</p>`;
  } catch { out.innerHTML = '<p class="hint">天気を取得できませんでした（圏外の可能性があります）。</p>'; }
}
async function routeElevation() {
  const out = $('#rt-out'); out.innerHTML = '<p class="hint">標高を調べています…</p>';
  const pts = Lib.routeSamples(tour.route.line, tour.route.min, departMs(), 80);
  try {
    const r = await fetch(Lib.elevationUrl(pts), { signal: timeoutSignal(10000) });
    const elev = (await r.json()).elevation;
    const lo = Math.min(...elev), hi = Math.max(...elev), span = Math.max(hi - lo, 1), total = pts[pts.length - 1].km || 1;
    const poly = elev.map((e, i) => `${(pts[i].km / total * 300).toFixed(1)},${(95 - (e - lo) / span * 85).toFixed(1)}`).join(' ');
    out.innerHTML = `<h4>⛰標高（最高 ${Math.round(hi)}m・最低 ${Math.round(lo)}m・上り合計 約${Math.round(Lib.climbOf(elev))}m）</h4>
      <svg class="elev" viewBox="0 0 300 100" preserveAspectRatio="none" role="img" aria-label="ルートの標高グラフ">
        <polyline points="0,100 ${poly} 300,100" class="elev-fill"/><polyline points="${poly}" class="elev-line"/></svg>
      <p class="hint">左が出発、右が${Math.round(total)}km地点。標高: Open-Meteo（Copernicus DEM）</p>`;
  } catch { out.innerHTML = '<p class="hint">標高を取得できませんでした（圏外の可能性があります）。</p>'; }
}
// 帰り道に寄れる温泉（ルートから3km以内・家に近い順）。片道のルートは「帰り始める時刻」から着く時刻を見積もる
function routeOnsen(backTime) {
  const out = $('#rt-out');
  const dest = currentDest(), loop = !!(dest && dest.loop);
  const day = new Date(departMs());
  const bt = backTime || tour.backTime || '15:00';
  const [h, m] = bt.split(':').map(Number);
  const backMs = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
  const pool = DATA.spots.concat(DATA.osm, poiSpotList());
  const xs = Lib.onsenHome(pool, tour.route.line, tour.route.min, { loop, departMs: departMs(), backMs }).slice(0, 12);
  out.innerHTML = `<h4>♨帰りに寄れる温泉（ルートから3km以内・家に近い順）</h4>
    ${loop ? '' : `<label>目的地を出る時刻 <input type="time" id="back-time" value="${esc(bt)}"></label>`}
    ${xs.length ? `<ul class="rel">${xs.map((x) => `<li><a ${gm(x)}>${esc(x.name)}</a>
      <span class="status">家まで約${Math.round(x.homeKm)}km・道から${x.offKm.toFixed(1)}km・着くのは${hm(x.at)}ごろ${x.open === true ? ' <span class="badge open">その時刻は営業中</span>' : x.open === false ? ' <span class="badge closed">その時刻は営業時間外</span>' : ''}${x.note ? '・' + esc(x.note) : ''}</span></li>`).join('')}</ul>`
      : '<p class="hint">ルートから3km以内に温泉が見つかりませんでした。</p>'}
    <p class="hint">営業時間がわかる温泉だけ「営業中」を表示しています。最終受付は公式サイトで確認してください。</p>`;
  const bi = $('#back-time'); if (bi) bi.onchange = (e) => { tour.backTime = e.target.value || '15:00'; routeOnsen(tour.backTime); };
  fillAddr(out);
}
async function routePhotos() {
  const out = $('#rt-out'); out.innerHTML = '<p class="hint">ルート沿いの写真を探しています…</p>';
  const pts = Lib.routeSamples(tour.route.line, tour.route.min, departMs(), 10).slice(1);
  const seen = new Set(), photos = [];
  await Promise.all(pts.map(async (p) => {
    try {
      const r = await fetch(Lib.commonsNearbyUrl(p.lat, p.lon, 3000, 3), { signal: timeoutSignal(10000) });
      for (const ph of Lib.parseCommons(await r.json())) if (!seen.has(ph.page)) { seen.add(ph.page); photos.push({ ...ph, lat: p.lat, lon: p.lon, km: p.km }); }
    } catch { /* 取れなかった地点はとばす */ }
  }));
  photos.sort((a, b) => a.km - b.km);
  out.innerHTML = `<h4>📷ルート沿いの写真（${photos.length}枚・押すと地図でその付近へ）</h4>` + (photos.length ? `<div class="rt-photos">${photos.map((ph, i) => `
    <figure><button type="button" class="ph" data-ph="${i}"><img src="${esc(ph.thumb)}" alt="${Math.round(ph.km)}km付近の写真" loading="lazy"></button>
      <figcaption>${Math.round(ph.km)}km付近・<a href="${esc(ph.page)}" target="_blank" rel="noopener">${esc(ph.artist || '撮影者')}</a>（${esc(ph.license || 'ライセンスはリンク先')}）</figcaption></figure>`).join('')}</div>`
    : '<p class="hint">写真が見つかりませんでした。</p>') + '<p class="hint">写真: Wikimedia Commons（ルート上の地点から3km以内）</p>';
  out.querySelectorAll('[data-ph]').forEach((b) => { b.onclick = () => {
    const ph = photos[+b.dataset.ph];
    if (map) { map.setView([ph.lat, ph.lon], 13); L.popup().setLatLng([ph.lat, ph.lon]).setContent(`<img class="pop-img" src="${esc(ph.thumb)}" alt="">`).openOn(map); $('#map').scrollIntoView({ block: 'center' }); }
  }; });
}

// 走り方の設定を 1 行で（畳んだ見出しに出す）
function optSummary() {
  const xs = [];
  if (tour.opts.noToll) xs.push('有料なし');
  if (tour.opts.fewHighways) xs.push('高速少なめ');
  if (tour.opts.bike) xs.push('バイク向け');
  xs.push(`立ち寄り${tour.radius}km`);
  return xs.join('・');
}
// カーブの多いコース（起点から150km以内・上位20）
function curvyHtml() {
  const xs = DATA.courses.filter((r) => r.curv && Lib.haversineKm(DATA.cfg.origin, { lat: r.points[0][0], lon: r.points[0][1] }) <= 150)
    .sort((a, b) => b.curv - a.curv).slice(0, 20);
  if (!xs.length) return '';
  return `<details id="curvy"><summary>🌀カーブの多いコース（150km以内の上位${xs.length}本）</summary><ul class="rel">${xs.map((r) => `<li>
    <button type="button" class="btn" data-course-go="${esc(r.id)}">走る</button> ${'★'.repeat(Lib.curvStars(r.curv))} ${esc(r.name)}<span class="status">${esc(r.note || '')}</span></li>`).join('')}</ul>
    <p class="hint">林道は狭い・未舗装の区間があることがあります。路面と通行止めは事前に確認してください。</p></details>`;
}
// 出発する月に閉鎖・通行止めの道をルートが通るか
function closedHtml() {
  if (!tour.route) return '';
  const m = new Date(departMs()).getMonth() + 1;
  const xs = Lib.closedAlong(tour.route.line, DATA.roads, m);
  return xs.map((r) => `<p class="notice">⚠ このルートは<strong>${m}月に閉鎖・通行止めの期間</strong>の「${esc(r.name)}」を通ります。${r.closed ? esc(r.closed) : ''}</p>`).join('');
}
function closedListHtml() {
  const m = thisMonth(), n = m % 12 + 1;
  const xs = DATA.roads.filter((r) => (r.closedMonths || []).some((x) => x === m || x === n));
  if (!xs.length) return '';
  return `<h4>🚧今月・来月に閉鎖・通行止めの期間がある道（${xs.length}本）</h4><ul class="rel">${xs.map((r) =>
    `<li>${esc(r.name)}<span class="status">${(r.closedMonths || []).join('・')}月${r.closed ? '・' + esc(r.closed) : ''}</span></li>`).join('')}</ul>`;
}
// 方面別の雨: 起点から 70km 先の 8 方面で、出発日の 9〜17 時の最大降水確率
async function dirRain() {
  const out = $('#dir-out'); out.innerHTML = '<p class="hint">方面ごとの天気を調べています…</p>';
  const pts = Lib.dirPoints(DATA.cfg.origin, 70), day = Lib.ymd(new Date(departMs()));
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${pts.map((p) => p.lat.toFixed(3)).join(',')}&longitude=${pts.map((p) => p.lon.toFixed(3)).join(',')}&hourly=precipitation_probability&timezone=Asia%2FTokyo&forecast_days=10`, { signal: timeoutSignal(10000) });
    const js = await r.json(), arr = Array.isArray(js) ? js : [js];
    const rows = pts.map((p, i) => { const h = arr[i].hourly;
      const v = Math.max(...h.time.map((t, k) => (t.startsWith(day) && +t.slice(11, 13) >= 9 && +t.slice(11, 13) <= 17 ? h.precipitation_probability[k] : -1)));
      return { ...p, prob: v }; }).sort((a, b) => a.prob - b.prob);
    if (rows[0].prob < 0) { out.innerHTML = '<p class="hint">出発日が予報の範囲外です（10日先まで）。</p>'; return; }
    out.innerHTML = `<p class="status">${day.slice(5).replace('-', '/')} の日中、雨が少なそうなのは <strong>${esc(dirName(rows[0].dir))}</strong> 方面です。</p>
      <ul class="rel">${rows.map((x) => `<li>${esc(dirName(x.dir))}：${x.prob >= 50 ? '☔' : '☀'}${x.prob}%</li>`).join('')}</ul><p class="hint">起点から約70km先の地点の予報（Open-Meteo）</p>`;
  } catch { out.innerHTML = '<p class="hint">天気を取得できませんでした（圏外の可能性があります）。</p>'; }
}

// ---- 走行記録（GPS）: 15m 以上動いたら 1 点。端末の中にだけ保存 ----
const track = { on: false, pts: store.get('track') || [], watch: null, line: null };
const saveTrack = () => store.set('track', track.pts.slice(-20000));
function trackStats() {
  let km = 0, hi = null;
  for (let i = 0; i < track.pts.length; i++) {
    if (i) km += Lib.haversineKm({ lat: track.pts[i - 1][0], lon: track.pts[i - 1][1] }, { lat: track.pts[i][0], lon: track.pts[i][1] });
    if (track.pts[i][2] != null) hi = Math.max(hi ?? -1e9, track.pts[i][2]);
  }
  const min = track.pts.length > 1 ? Math.round((track.pts[track.pts.length - 1][3] - track.pts[0][3]) / 60e3) : 0;
  return { km, min, hi };
}
function trackText() {
  if (!track.pts.length) return track.on ? '記録中（位置を待っています）…' : 'まだ記録はありません。';
  const s = trackStats();
  return `${track.on ? '⏺記録中：' : '記録：'}${s.km.toFixed(1)}km・${fmtMin(s.min) || '0分'}${s.hi != null ? `・最高地点 約${Math.round(s.hi)}m` : ''}`;
}
function toggleTrack() {
  if (track.on) {
    navigator.geolocation.clearWatch(track.watch); track.on = false; saveTrack();
  } else {
    if (!navigator.geolocation) { alert('この端末では位置情報を使えません。'); return; }
    if (track.pts.length && !confirm('前の記録に続けて記録しますか？（「キャンセル」で新しく始めます）')) track.pts = [];
    track.on = true;
    keepAwake(true);
    track.watch = navigator.geolocation.watchPosition((p) => {
      const q = [+p.coords.latitude.toFixed(6), +p.coords.longitude.toFixed(6), p.coords.altitude == null ? null : Math.round(p.coords.altitude), p.timestamp];
      const last = track.pts[track.pts.length - 1];
      if (last && Lib.haversineKm({ lat: last[0], lon: last[1] }, { lat: q[0], lon: q[1] }) < 0.015) return;
      track.pts.push(q);
      if (track.pts.length % 10 === 0) saveTrack();
      const msg = $('#trk-msg'); if (msg) msg.textContent = trackText();
      if (map) { if (!track.line) track.line = L.polyline([], { color: '#2f9e44', weight: 5 }).addTo(map); track.line.addLatLng([q[0], q[1]]); }
    }, () => { const msg = $('#trk-msg'); if (msg) msg.textContent = '位置を取得できません（位置情報の許可を確認してください）。'; },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  }
  tour.key = ''; renderTouring();
}
function saveTrackGpx() {
  const d = new Date(track.pts[0][3]);
  const name = `走行記録 ${Lib.ymd(d)}`;
  const url = URL.createObjectURL(new Blob([Lib.toGpx(name, track.pts.map((p) => [p[1], p[0]]))], { type: 'application/gpx+xml' }));
  const a = document.createElement('a'); a.href = url; a.download = `mymap-track-${Lib.ymd(d)}.gpx`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---- 圏外用にルート沿いの地図（国土地理院の地理院地図）を端末に保存 ----
async function saveRouteTiles() {
  const tiles = Lib.tilesAlong(tour.route.line, [10, 11, 12, 13, 14], 1);
  const msg = $('#rt-save-msg');
  if (!confirm(`ルート沿いの地図 ${tiles.length}枚（約${Math.round(tiles.length * 25 / 1024)}MB）を保存します。Wi-Fi での保存がおすすめです。保存しますか？`)) return;
  const cache = await caches.open('mymap-tiles');
  let done = 0, fail = 0;
  const queue = [...tiles];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const t = queue.shift(), url = `https://cyberjapandata.gsi.go.jp/xyz/std/${t.z}/${t.x}/${t.y}.png`;
      try { if (!(await cache.match(url))) { const r = await fetch(url); if (r.ok) await cache.put(url, r); else fail++; } } catch { fail++; }
      done++;
      if (msg) msg.textContent = `保存中… ${done}/${tiles.length}`;
    }
  }));
  if (msg) msg.textContent = `保存しました（${done - fail}枚）。圏外では地図の右上で「地理院地図」を選ぶと表示されます（圏外で開いたときは自動で切り替えます）。`;
}

// ---- ドライブコースと峠を地図に（厳選は太線、自動収集は細線、峠は紫の点）。押すと説明と「このコースを走る」 ----
function courseHtml(r) {
  const closedNow = (r.closedMonths || []).includes(thisMonth());
  return `<div class="pop"><strong>${r.pass ? '⛰' : '🛣'} ${esc(r.name)}</strong>
    <p>${r.toll ? '<strong>有料</strong>・' : ''}${esc(r.note || '')}${r.closed ? `<br>⚠ ${esc(r.closed)}` : ''}${closedNow ? '<br>⚠ <strong>今月は通行止め・閉鎖の期間です</strong>' : ''}</p>
    <div class="actions">${r.pass ? `<button type="button" class="btn primary" data-pass-go="${esc(r.id)}">ここを目的地に</button>`
      : `<button type="button" class="btn primary" data-course-go="${esc(r.id)}">このコースを走る（周回）</button>`}</div></div>`;
}
function bindCourseBtns(el) {
  if (!el) return;
  el.querySelectorAll('[data-course-go]').forEach((b) => { b.onclick = () => {
    buzz(); const id = b.dataset.courseGo;
    setDest(() => { tour.custom = null; tour.roadId = id; tour.destId = null; });
  }; });
  el.querySelectorAll('[data-pass-go]').forEach((b) => { b.onclick = () => {
    const p = DATA.passes.find((x) => x.id === b.dataset.passGo);
    if (p) { buzz(); setCustomDest(p.points[0][0], p.points[0][1], p.name); }
  }; });
}
function drawCourses() {
  const add = (layer, r) => layer.bindPopup(() => courseHtml(r), { maxWidth: 260 })
    .on('popupopen', (e) => bindCourseBtns(e.popup.getElement())).addTo(map);
  for (const r of DATA.courses) add(L.polyline(r.points, { color: '#e8590c', weight: 4, opacity: 0.6 }), r);
  for (const r of DATA.roads) add(L.polyline(r.points, { color: '#e8590c', weight: 7, opacity: 0.85 }), r);
  for (const p of DATA.passes) add(L.circleMarker(p.points[0], { radius: 5, weight: 2, color: '#fff', fillColor: '#7048e8', fillOpacity: 0.9 }), p);
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
    <h2>起点</h2>
    <p class="status">今の起点：<strong>${esc(DATA.cfg.origin.name)}</strong>（移動時間・ルートはここから計算）</p>
    <div class="actions"><button type="button" class="btn" id="origin-here">現在地を起点にする</button>
      ${store.get('origin') ? `<button type="button" class="btn" id="origin-reset">${esc(CFG_ORIGIN.name)}に戻す</button>` : ''}</div>
    <h2>行った場所の記録</h2>${visitedHtml()}
    <h2>お気に入りの共有</h2>
    <p class="hint">⭐お気に入り（${state.favs.size}件）を 1 本のリンクにして家族に送れます。相手がリンクを開くと、その端末のお気に入りに追加されます。</p>
    <div class="actions"><button type="button" class="btn" id="fav-share" ${state.favs.size ? '' : 'disabled'}>⭐お気に入りを共有</button></div>
    <h2>好きなジャンル</h2><p class="hint">今週末のおすすめに優先して出します。</p><div id="fav-genres" class="chips" style="flex-wrap:wrap"></div>
    <h2>Google マップの写真（任意）</h2>
    <p class="hint">Wikipedia・Wikimedia Commons で写真が見つからない場所も多いので、ご自身の Google の API キー（Places API (New)）を入れると「▼詳しく」と地図の吹き出しに Google マップの写真を出します。キーはこの端末の中にだけ保存します。</p>
    <details><summary>キーの作り方（クレジットカードの登録が必要。個人で使う程度なら無料枠の範囲）</summary><ol class="hint">
      <li>Google Cloud コンソール（console.cloud.google.com）でプロジェクトを作り、お支払い（請求先アカウント）を設定</li>
      <li>「API とサービス」→「ライブラリ」で <strong>Places API (New)</strong> を有効にする</li>
      <li>「認証情報」→「API キーを作成」</li>
      <li>キーの制限：アプリケーションの制限は「ウェブサイト」で <code>${esc(location.origin)}/*</code>、API の制限は「Places API (New)」だけ</li>
      <li>念のため「お支払い」→「予算とアラート」で少額の予算アラートを設定（無料枠を超えると課金されます）</li></ol></details>
    <p class="status">状態：${store.get('gkey') ? '登録済み' : '未登録'}</p>
    <input id="gkey" type="password" autocomplete="off" placeholder="AIza..." aria-label="Google の API キー">
    <div class="actions"><button type="button" class="btn primary" id="gkey-save">保存</button><button type="button" class="btn" id="gkey-del">削除</button></div>
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
  $('#gkey-save').onclick = () => { const v = $('#gkey').value.trim(); if (v) { store.set('gkey', v); renderSettings(); } };
  $('#gkey-del').onclick = () => { store.set('gkey', null); renderSettings(); };
  $('#origin-here').onclick = () => {
    if (!navigator.geolocation) { alert('この端末では現在地を使えません。'); return; }
    navigator.geolocation.getCurrentPosition((p) => {
      setOrigin({ name: '現在地', lat: +p.coords.latitude.toFixed(5), lon: +p.coords.longitude.toFixed(5) });
    }, () => alert('現在地を取得できませんでした（位置情報の許可を確認してください）。'), { enableHighAccuracy: true, timeout: 10000 });
  };
  const or = $('#origin-reset'); if (or) or.onclick = () => setOrigin(null);
  $('#fav-share').onclick = () => {
    const url = `${location.origin}${location.pathname}#favs=${encodeURIComponent([...state.favs].join(','))}`;
    shareText('MyMap のお気に入り', `おでかけ候補 ${state.favs.size}件`, url);
  };
  drawVisitedMap();
}
let CFG_ORIGIN = null; // config.json の起点（現在地にしたあと戻すため）
function setOrigin(o) {
  store.set('origin', o);
  DATA.cfg.origin = o || CFG_ORIGIN;
  tour.cands = null; tour.stops = null; tour.key = ''; DATA.ver++;
  buzz(); renderAll();
}
function visitedRecords() {
  const meta = store.get('visitedMeta') || {};
  const byId = new Map(DATA.spots.concat(DATA.osm).map((s) => [s.id, s]));
  return [...state.visited].map((id) => meta[id] || byId.get(id)).filter((r) => r && r.lat != null);
}
function visitedHtml() {
  const recs = visitedRecords();
  if (!recs.length) return '<p class="hint">スポットの「▼詳しく」→「行った」を押すと、ここに地図と都県ごとの数が出ます。</p>';
  return `<p class="status">${recs.length}か所：${Lib.visitedStats(recs).map(([p, n]) => `${esc(p)} ${n}`).join('・')}</p><div id="visited-map"></div>`;
}
let visitedMap = null;
function drawVisitedMap() {
  if (visitedMap) { visitedMap.remove(); visitedMap = null; }
  const recs = visitedRecords();
  if (!recs.length || !$('#visited-map') || typeof L === 'undefined') return;
  visitedMap = L.map('visited-map', { renderer: L.canvas({ tolerance: 8 }) });
  baseLayers(visitedMap);
  for (const r of recs) L.circleMarker([r.lat, r.lon], { radius: 7, weight: 2, color: '#fff', fillColor: '#2f9e44', fillOpacity: 0.95 })
    .bindPopup(`<strong>✓ ${esc(r.name)}</strong>${r.at ? `<br>${new Date(r.at).toLocaleDateString('ja-JP')}に記録` : ''}`).addTo(visitedMap);
  visitedMap.fitBounds(L.latLngBounds(recs.map((r) => [r.lat, r.lon])).pad(0.2), { maxZoom: 12 });
}

// ---- タブと全体描画 ----
const RENDER = { spots: renderSpots, events: renderEvents, touring: renderTouring, settings: renderSettings };
function goTab(t) {
  // ツーリングタブを開いたら屋外モードを自動でオン（手動で切った後も、次に開いたときは再びオン）
  if (t === 'touring' && state.tab !== 'touring') setOutdoor(true, false); // 自動の ON は保存しない（手動の設定を上書きしない）
  if (t !== 'touring' && state.tab === 'touring') setOutdoor(!!store.get('outdoor'), false); // ほかのタブに戻ったら自分の設定に戻す
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
  if (state.tab !== 'spots' && $('#spot-list')) $('#view').innerHTML = ''; // 一覧は スポット タブ専用（検索欄は CSS で隠す）
  (RENDER[state.tab] || renderSpots)();
  keepAwake(state.tab === 'touring' && tour.awake);
}

async function init() {
  const outdoor = store.get('outdoor');
  // 初回は端末の「コントラストを上げる」設定に合わせる
  setOutdoor(outdoor ?? matchMedia('(prefers-contrast: more)').matches, outdoor != null);
  if (state.tab === 'touring') setOutdoor(true, false);
  $('#filters').open = !!store.get('filtersOpen');
  $('#rec').open = store.get('recOpen') === true;
  DATA.cfg = await getJSON('config.json', null);
  if (!DATA.cfg) { renderLoadMsg(); $('#view').innerHTML = '<p class="empty">config.json を読み込めません。電波の良い場所で開き直してください。</p>'; return; }
  CFG_ORIGIN = DATA.cfg.origin;
  // 共有されたお気に入りのリンク（#favs=id,id,...）
  const fm = location.hash.match(/^#favs=(.+)$/);
  if (fm) {
    const ids = decodeURIComponent(fm[1]).split(',').filter(Boolean).slice(0, 500);
    if (ids.length && confirm(`共有されたお気に入り ${ids.length}件を、この端末のお気に入りに追加しますか？`)) {
      ids.forEach((id) => state.favs.add(id)); store.set('favs', [...state.favs]);
    }
    history.replaceState(null, '', location.pathname);
  }
  if (store.get('origin')) DATA.cfg.origin = store.get('origin');
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
  const ro = await getJSON('data/roads_osm.json', []);
  FAILED.delete('data/roads_osm.json');
  DATA.courses = ro.filter((r) => !r.pass && r.points.length >= 2);
  DATA.passes = ro.filter((r) => r.pass);
  DATA.ver++;
  renderAll();
  // 自動収集スポットは大きい（数 MB）ので最後に読み込む
  DATA.osm = await getJSON('data/osm_spots.json', []);
  DATA.osmLoaded = true;
  renderAll();
}
init();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* 非対応でも動く */ });
