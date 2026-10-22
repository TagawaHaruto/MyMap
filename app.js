// MyMap 画面ロジック。純粋な計算は lib.js（Lib）に置く。
const GENRES = { play: '🎡遊び', sightseeing: '📷観光', shopping: '🛍買い物', vehicle: '🚗乗り物', museum: '🏛博物館',
  garden: '🌿植物園', temple: '⛩寺社', onsen: '♨温泉', scenic: '🏔絶景', viewpoint: '🔭展望台', nightview: '🌃夜景', simulator: '🎮シミュレーター', factory: '🏭工場見学', experience: '🎨体験',
  food: '🍴グルメ', heritage: '🏯史跡', lodging: '🏨宿', souvenir: '🛍お土産・直売', outdoor: '⚽遊び・アウトドア' };
// これらのジャンルは件数が多いので、升目ごとのファイルを選んだときだけ読み込む（data/cells/<グループ>/<升目>.json）
// ジャンル → そのジャンルの項目が入っているグループ（play: 公園・スポーツ・カラオケなど、temple: 寺社、hobby: 趣味のお店）
const GROUP_OF = { food: ['food'], heritage: ['heritage'], lodging: ['heritage'], souvenir: ['local'], outdoor: ['local', 'play'],
  play: ['play'], temple: ['temple'], shopping: ['hobby'] };
const ALL_GROUPS = ['food', 'heritage', 'local', 'play', 'temple', 'hobby'];
const MODES = { train: '🚃電車', car: '🚗車', bike: '🏍バイク', bicycle: '🚲自転車' };
const GMAP_MODE = { train: 'transit', car: 'driving', bike: 'driving', bicycle: 'bicycling' };
const TIMES = [[30, '30分'], [60, '60分'], [90, '90分'], [120, '2時間'], [180, '3時間'], [240, '4時間'], [300, '5時間'], [null, '制限なし']];
let PREFS = ['東京', '神奈川', '埼玉', '千葉', '山梨', 'その他']; // 起点の近くに多い都道府県に入れ替える（updateMainPrefs）
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
  prefs: new Set(saved.prefs || []), genres: new Set(saved.genres || []), dirs: new Set(saved.dirs || []), allTypes: !!saved.allTypes, band: saved.band || '',
  q: '', limit: 300, rainOverride: null, weatherRainy: false, tab: store.get('tab') || 'spots', period: 'weekend',
  showNotices: false, showChains: false, walkinOnly: false, foodCat: '', spotMap: false, openOnly: false, seasonOnly: false, isoOn: false, gacha: null, plansView: false, parkOnly: false, quickOnly: false, nightPlay: false,
  favGenres: new Set(store.get('favGenres') || ['vehicle', 'museum', 'garden', 'temple', 'onsen']),
  favs: new Set(store.get('favs') || []), visited: new Set(store.get('visited') || []),
};
const DATA = { cfg: null, spots: [], osm: [], onsen: [], pois: [], events: [], status: null, touring: [], roads: [], courses: [], passes: [], sx: null, issues: { courses: {}, auto: {} }, ver: 0, eventsLoaded: false, osmLoaded: false };
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
  store.set('filters', { mode: state.mode, maxMin: state.maxMin, prefs: [...state.prefs], genres: [...state.genres], dirs: [...state.dirs], allTypes: state.allTypes, band: state.band });
}
const icon = (label) => [...label][0]; // 先頭の絵文字（コードポイント単位）
const fmtMin = (m) => (m == null ? '' : m < 60 ? `約${m}分` : `約${Math.floor(m / 60)}時間${m % 60 ? (m % 60) + '分' : ''}`);
// 方面の呼び名（「北・秩父」など）は config の起点（調布）向けなので、起点を変えたら「北」「北東」などにする
const dirName = (d) => (DATA.cfg && !store.get('origin') && DATA.cfg.directionLabels && DATA.cfg.directionLabels[d]) || DIR_NAMES[d];
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
    el.innerHTML = navigator.onLine === false ? '圏外です。前に読み込んだデータを表示しています（最新の情報は電波のある場所で）。<button type="button" class="btn" id="reload">再読み込み</button>'
      : '一部のデータを読み込めませんでした。電波の良い場所で開き直してください。<button type="button" class="btn" id="reload">再読み込み</button>';
    $('#reload').onclick = () => location.reload();
  }
}

// ---- 屋外モード（日なた・グローブ向け表示） ----
// 画面のデザイン: 'stylish'（スタイリッシュ・既定）か 'standard'（デジタル庁デザインシステムに沿った標準）
function setTheme(t, save = true) {
  document.documentElement.dataset.theme = t;
  if (save) store.set('theme', t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t === 'stylish' ? '#1e1b4b' : '#264af4';
}
setTheme(store.get('theme') || 'stylish', false);
function setOutdoor(on, save = true) {
  document.documentElement.toggleAttribute('data-outdoor', on);
  $('#outdoor').setAttribute('aria-pressed', on);
  const cb = $('#set-outdoor'); if (cb) cb.checked = on;
  if (save) store.set('outdoor', on);
  if (map) setTimeout(() => { if (map && map.getContainer().isConnected) map.invalidateSize(); }, 0); // 別のタブへ移って地図が消えた後は触らない
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
  chips($('#f-band'), [['', 'いつでも']].concat(Object.entries(Lib.TIME_BANDS).map(([k, [label]]) => [k, label])), (v) => v === state.band, (v) => { state.band = v; });
  chips($('#f-pref'), PREFS.map((p) => [p, p]), (v) => state.prefs.has(v), (v) => toggle(state.prefs, v));
  chips($('#f-dir'), Lib.DIRS.map((d) => [d, dirName(d)]), (v) => state.dirs.has(v), (v) => toggle(state.dirs, v));
  // 先頭の「すべて」は、グルメ・史跡・宿・お土産・遊びも含めた全部（ほかの種類を押すと外れる）
  chips($('#f-genre'), [['__all', '🌐すべて（グルメ等も）']].concat(Object.entries(GENRES)),
    (v) => (v === '__all' ? state.allTypes : !state.allTypes && state.genres.has(v)),
    (v) => { if (v === '__all') { state.allTypes = !state.allTypes; state.genres.clear(); } else { state.allTypes = false; toggle(state.genres, v); } });
  const time = TIMES.find(([v]) => v === state.maxMin)[1];
  const parts = [MODES[state.mode], state.maxMin == null ? '時間制限なし' : `${time}以内`,
    state.prefs.size ? [...state.prefs].join('/') : '全都県',
    state.dirs.size ? [...state.dirs].map((d) => DIR_NAMES[d]).join('/') : '全方面'];
  if (state.band) parts.push(Lib.TIME_BANDS[state.band][0]);
  if (state.tab !== 'events') parts.push(state.allTypes ? 'すべての種類' : state.genres.size ? [...state.genres].map((g) => GENRES[g]).join('/') : '観光・遊びなど');
  $('#f-sum').textContent = parts.join('・');
}
const setCount = (n) => { $('#f-count').textContent = n == null ? '' : `（${n.toLocaleString()}件）`; };
$('#filters').addEventListener('toggle', (e) => store.set('filtersOpen', e.target.open));
$('#rec').addEventListener('toggle', (e) => store.set('recOpen', e.target.open));

// ---- スポット ----
function poiAsSpot(p) {
  return { id: `poi:${p.kind}:${p.name}:${p.lat}`, name: p.name, lat: p.lat, lon: p.lon, pref: null,
    genres: p.kind === 'viewpoint' ? ['viewpoint'] : SCENIC_KINDS.includes(p.kind) ? ['scenic'] : p.kind === 'onsen' ? ['onsen'] : ['sightseeing'],
    indoor: false, fee: '', parking: null, tags: [], url: p.wikipedia || '', poi: true, kind: p.kind,
    note: p.kind === 'fuel24' ? `${p.brand ? p.brand + '・' : ''}24時間営業${p.self === 1 ? '・セルフ' : ''}` : POI_KIND[p.kind] || '' };
}
let poiSpots = null, poiVer = -1;
function poiSpotList() {
  if (poiVer !== DATA.ver) { poiSpots = DATA.pois.filter((p) => p.kind !== 'fuel24').map(poiAsSpot); poiVer = DATA.ver; } // ガソリンスタンドは行き先にしない
  return poiSpots;
}
// グルメなど（件数の多い升目のデータ）を読み込む範囲は最大 15km（通信量を抑える。遠くは検索欄で OpenPOI から探す）
const CELL_KM_MAX = 15;
const cellKm = () => Math.min(loadKm(), CELL_KM_MAX);
// 「種類」を選んでいないとき（観光・遊びなど）の一覧には、件数の多いグルメなどは混ぜない。
// その代わりに、範囲内にあるグルメなどの件数を出して、押すと加えられるようにする
// [表示名, 数えるグループ, 押したときに選ぶ種類]
const HIDDEN_GROUPS = [['🍴グルメ', ['food'], ['food']], ['🏯史跡・🏨宿', ['heritage'], ['heritage', 'lodging']],
  ['🌳公園・🎤カラオケ・スポーツ', ['play'], ['play']], ['⛩神社・お寺', ['temple'], ['temple']],
  ['📚趣味のお店', ['hobby'], ['shopping']], ['🛍お土産・⛺キャンプ', ['local'], ['souvenir', 'outdoor']]];
function hiddenGroupsHtml() {
  if (!cellIndex) return '';
  const cells = Lib.cellsInRadius(DATA.cfg.origin, cellKm());
  const count = (g) => cells.reduce((a, c) => a + ((cellIndex[g] && cellIndex[g][c]) || 0), 0);
  const items = HIDDEN_GROUPS.map(([label, groups], i) => [i, label, groups.reduce((a, g) => a + count(g), 0)]).filter(([, , n]) => n);
  if (!items.length) return '';
  return `<p class="hint">ほかに：${items.map(([i, label, n]) =>
    `<button type="button" class="chip" data-add-genre="${i}">${label} 約${n.toLocaleString()}件</button>`).join(' ')}
    <details class="help"><summary aria-label="説明を見る">i</summary>この一覧は観光・遊び・体験などの名所です（グルメや近所の公園などは件数が多いので含みません）。上の種類の数を押すとその種類の一覧を、種類の「🌐すべて」を選ぶと全部を表示します。</details></p>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-add-genre]'); if (!b) return;
  buzz();
  HIDDEN_GROUPS[+b.dataset.addGenre][2].forEach((x) => state.genres.add(x));
  saveFilters(); state.limit = 300; renderAll();
});
// ---- 地方ごとのデータ（全国。1 度四方の升目 data/area/<種類>/<升目>.json）: 起点から poiRadiusKm 以内だけ読む ----
// （全国分を一度に読むと重いため。起点を変えたら読み直す。まだ全国の収集をしていないときは、関東だけの頃の 1 ファイルを読む）
const AREA_LEGACY = { pois: 'data/pois.json', spots: 'data/osm_spots.json', roads: 'data/roads_osm.json', moto: 'data/moto.json' };
let areaIndexP = null;
async function loadArea(kind, center = DATA.cfg.origin, km = DATA.cfg.poiRadiusKm) {
  if (!areaIndexP) {
    areaIndexP = fetch('data/area/index.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : r.status === 404 ? null : Promise.reject(new Error(`HTTP ${r.status}`))))
      .catch((e) => { areaIndexP = null; throw e; });
  }
  let index;
  try { index = await areaIndexP; FAILED.delete('data/area/index.json'); } catch { FAILED.add('data/area/index.json'); renderLoadMsg(); return []; }
  if (!index) { if (!AREA_LEGACY[kind]) return []; const xs = await getJSON(AREA_LEGACY[kind], []); FAILED.delete(AREA_LEGACY[kind]); return xs; }
  const have = index[kind] || {};
  const cids = Lib.cellsInRadius(center, km, 1).filter((c) => have[c]);
  return (await Promise.all(cids.map((c) => getJSON(`data/area/${kind}/${c}.json`, [])))).flat();
}
const setRoads = (ro) => {
  DATA.courses = ro.filter((r) => !r.pass && r.points.length >= 2 && DATA.issues.auto[r.id] !== 'hide'); // ルートが引けないと確かめたものは出さない
  DATA.passes = ro.filter((r) => r.pass);
};
// 絞り込みの都道府県: 起点から 150km 以内に多いものを上から 5 つ（全国どこでも、近くの都道府県で絞り込めるように）
const DEFAULT_PREFS = ['東京', '神奈川', '埼玉', '千葉', '山梨'];
const setPrefs = (main) => { Lib.setMainPrefs(main); PREFS = main.concat('その他'); };
const originKey = (o) => `${o.lat},${o.lon}`;
function updateMainPrefs() {
  const o = store.get('origin');
  if (!o) setPrefs(DEFAULT_PREFS);
  else {
    const n = {};
    for (const s of DATA.spots.concat(DATA.osm)) {
      if (s.pref && s.pref !== 'その他' && Lib.haversineKm(DATA.cfg.origin, s) <= 150) n[s.pref] = (n[s.pref] || 0) + 1;
    }
    const main = Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p]) => p);
    // 覚えておき、次に開いたときは読み込みの前から同じチップにする（init）
    if (main.length) { setPrefs(main); store.set('mainPrefs', { at: originKey(o), list: main }); }
  }
  // 今のチップにない都道府県の絞り込みは外す（残すと、見えないチップで絞り込まれたまま一覧が空になる）
  const n0 = state.prefs.size;
  for (const p of [...state.prefs]) if (!PREFS.includes(p)) state.prefs.delete(p);
  if (state.prefs.size !== n0) saveFilters();
}
// 地方ごとの観光スポットに全国の温泉地を足す（地図データに同じ名前の温泉が近くにあれば、そちらだけ）
const withOnsen = (osm) => osm.concat(Lib.dropSameName(DATA.onsen, osm));
// 起点を変えたとき・データを更新したとき: 地方ごとのデータを読み直す
let areaSeq = 0;
async function reloadArea(keepOnFail = false) {
  const seq = ++areaSeq;
  const [pois, osm, ro] = await Promise.all([loadArea('pois'), loadArea('spots'), loadArea('roads')]);
  if (seq !== areaSeq) return; // 読み込む間に起点をもう一度変えたときは、後の分だけ使う
  // データの更新で読み直すときは、一時的な通信の失敗で今のデータを欠けたものに置き換えない（読み込みの失敗の案内は出る）
  if (keepOnFail && [...FAILED].some((u) => u.startsWith('data/area/'))) { DATA.osmLoaded = true; return; }
  DATA.pois = pois; osm.forEach(Lib.refineGenres); DATA.osm = withOnsen(osm); setRoads(ro);
  JCTS = null; updateMainPrefs();
  DATA.osmLoaded = true; DATA.ver++; tour.stops = null; // 起動時の読み込みの途中で呼ばれたときは、起動時の側は使わずに終わるため、ここで読み終わりにする
}

// ---- 升目ごとのデータ（飲食・史跡・宿・お土産・遊び） ----
const CELL_DATA = new Map(); // 'グループ/升目' → 項目
const cellLoading = new Map(); // 読み込み中の 'グループ/升目' → 読み込みの Promise
let cellIndex = null;
// 読み込む範囲（km）: 移動時間から求めた半径。制限なしは 60km まで
function loadKm() {
  if (state.maxMin == null) return 60;
  const min = state.maxMin - (state.mode === 'train' ? DATA.cfg.trainOverheadMin : 0);
  return Math.min(DATA.cfg.poiRadiusKm, Math.max(0, min) / 60 * DATA.cfg.speedsKmh[state.mode] + 2);
}
function ensureCells(groups, center, km) { return ensureCellIds(groups, Lib.cellsInRadius(center, km)); }
// 読み込みが終わるまで待つ（別の画面が読み込み中の升目も待つ。待たないと、ルート沿いのごはん屋さんが 0 件になる）。新しく揃ったら true
async function ensureCellIds(groups, cids) {
  if (!cellIndex) return false;
  const wait = [];
  for (const g of groups) {
    for (const cid of cids) {
      const key = `${g}/${cid}`;
      if (!cellIndex[g] || !cellIndex[g][cid] || CELL_DATA.has(key)) continue;
      if (!cellLoading.has(key)) cellLoading.set(key, getJSON(`data/cells/${key}.json`, []).then((xs) => { CELL_DATA.set(key, xs); cellLoading.delete(key); }));
      wait.push(cellLoading.get(key));
    }
  }
  if (!wait.length) return false;
  await Promise.all(wait);
  return true;
}
function cellItems(groups, center, km) { return cellItemsIn(groups, Lib.cellsInRadius(center, km)); }
function cellItemsIn(groups, cids) {
  const out = [];
  for (const g of groups) for (const cid of cids) { const xs = CELL_DATA.get(`${g}/${cid}`); if (xs) out.push(...xs); }
  return out;
}
const selectedGroups = () => (state.allTypes ? ALL_GROUPS : [...new Set([...state.genres].flatMap((g) => GROUP_OF[g] || []))]);

function spotCandidates() {
  // 絶景を選んだときだけ滝・山・湖などの POI を混ぜる（展望台は osm_spots 側にある）
  const extra = state.genres.has('scenic')
    ? poiSpotList().filter((p) => SCENIC_KINDS.includes(p.kind) && p.kind !== 'viewpoint') : [];
  // グルメなどは、そのジャンルを選んだときだけ（「全種類」には混ぜない）
  const groups = selectedGroups();
  let cellsPart = [];
  if (groups.length) {
    ensureCells(groups, DATA.cfg.origin, cellKm()).then((changed) => { if (changed && state.tab === 'spots') renderSpotList(); });
    cellsPart = cellItems(groups, DATA.cfg.origin, cellKm());
  }
  // 夜・深夜は道の駅も（駐車場とトイレは 24 時間使える）
  const night = state.band === 'night' || state.band === 'late';
  const michi = night ? poiSpotList().filter((p) => p.kind === 'michinoeki') : [];
  let all = DATA.spots.concat(DATA.osm, extra, cellsPart, michi);
  if (!state.showChains) all = all.filter((s) => !s.chain);
  if (state.walkinOnly && (state.genres.has('factory') || state.genres.has('experience'))) all = all.filter((s) => s.walkin === true);
  if (state.foodCat && groups.includes('food')) all = all.filter((s) => !s.genres.includes('food') || Lib.inFoodCat(s, state.foodCat));
  if (state.isoOn && isoAvailable()) {
    loadIso();
    const g = isoGeom();
    if (g) all = all.filter((s) => Lib.inGeometry(s, g));
  }
  if (state.openOnly) { const now = new Date(); all = all.filter((s) => Lib.openState(s.oh, now) === true); }
  if (state.band) { const day = new Date(); all = all.filter((s) => Lib.timeBandState(s, state.band, day)); }
  if (state.parkOnly) all = all.filter(hasParking);
  // 調べて追加した「ちょっとお出かけ」「夜も遊べる」（夜景・展望台も夜に楽しめるものとして含める）
  if (state.quickOnly) all = all.filter((s) => (s.tags || []).includes('ちょっとお出かけ'));
  if (state.nightPlay) all = all.filter((s) => (s.tags || []).includes('夜も遊べる') || (s.genres || []).includes('nightview'));
  if (state.seasonOnly) { const m = thisMonth(); all = all.filter((s) => Lib.seasonNow(s, m).length); }
  return all;
}
const isCurated = Lib.isCurated;
// 駐車場の目安: 厳選は登録済みの情報、そのほかは収集時に近くの駐車場から推定した pk（2: 専用がありそう・1: 近くにある）
// 駐車場: 確かな情報だけ（厳選の登録・名前で確かめられた専用駐車場 pk=2・この起動中に Google マップから取れた情報）。推定はしない
const parkText = (s) => {
  if (s.parking) return [s.parking.car ? '🅿車' : '', s.parking.bike ? '🅿二輪' : ''].filter(Boolean).join(' ');
  const g = GPARK.get(s.id);
  if (g) return g.has ? '🅿あり（Google）' : '🅿なし（Google）';
  return s.pk === 2 ? '🅿専用駐車場あり' : '';
};
const hasParking = (s) => (s.parking ? !!s.parking.car : GPARK.has(s.id) ? GPARK.get(s.id).has : s.pk === 2) || s.kind === 'michinoeki';
function spotCard(s) {
  const sns = Lib.snsLinks(s);
  const icons = s.genres.map((g) => icon(GENRES[g] || '・')).join('');
  const park = parkText(s);
  // 一覧では名前・時間・短い説明だけ。ボタン類と写真は「▼詳しく」を押してから（1 画面にたくさん並べるため）
  return `<article class="card spot">
    <div class="spot-head"><h3>${isCurated(s) ? '<span title="厳選スポット">★</span> ' : ''}${icons} ${esc(s.name)}</h3>
      <div class="head-btns">${infoButton(s)}${s.poi ? '' : `<button type="button" class="icon fav" data-fav="${esc(s.id)}" aria-pressed="${state.favs.has(s.id)}" aria-label="お気に入り">⭐</button>`}</div></div>
    <p class="meta">${s.indoor ? '<span class="badge rain">☔雨OK</span> ' : ''}${icon(MODES[state.mode])}<strong>${fmtMin(s.minutes)}</strong>${s.fee ? '・' + esc(s.fee) : ''}${park ? '・' + park : ''}${state.visited.has(s.id) ? '・✓行った' : ''}${s.walkin === true ? '・<strong>当日参加OK</strong>' : s.walkin === false ? '・要予約' : ''}${openBadge(s)}${seasonBadge(s)}</p>
    ${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}
    <div class="info" hidden></div></article>`;
}
// 「▼詳しく」の中身（開いたときに作る。一覧の 1 枚ごとに作ると、300 件で部品が 1 万個を超えて重くなるため）
function infoShell(s) {
  const sns = Lib.snsLinks(s);
  return `${detailLine(s)}
    <div class="actions">
      <a class="btn" ${gm(s, 'dir')}>地図で経路</a>
      <a class="btn" ${gm(s)}>写真・口コミ・GoogleMapで確認</a>
      <button type="button" class="btn" data-plan="${esc(s.id)}">日帰りプラン</button>
      <button type="button" class="btn" data-park="${esc(s.id)}">🅿駐車場</button>
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
  {
    const km = Lib.haversineKm(DATA.cfg.origin, s), cc = costCfg();
    parts.push(`💴${esc(DATA.cfg.origin.name)}から往復の交通費の目安：電車 約${Lib.yen(Lib.trainFare(km) * 2)}（JR の運賃で概算）・車のガソリン 約${Lib.yen(Lib.fuelCost(km * 1.3 * 2, cc.car, cc.price))}（高速代は別。ツーリングでルートを出すと計算）`);
  }
  const wk = nextWeekendNoon(), c = Lib.crowdLevel(s, wk);
  parts.push(`👥混みやすさの目安（${wk.getMonth() + 1}/${wk.getDate()}の昼）: <strong>${c.label}</strong>${c.reasons.length ? `（${esc(c.reasons.join('・'))}）` : ''}`);
  return `<p class="hint">${parts.join('<br>')}</p>`;
}

// 営業中か（営業時間がわかるものだけ）・季節の見頃・営業時間などの 1 行
const BAND_NOTE = { open: '営業時間内', h24: '駐車場・トイレは24時間', outdoor: '屋外（夜間の閉鎖・駐車場の時間は現地で確認）' };
function openBadge(s) {
  if (state.band && state.tab === 'spots') {
    const b = Lib.timeBandState(s, state.band);
    if (BAND_NOTE[b]) return ` <span class="badge ${b === 'open' || b === 'h24' ? 'open' : 'season'}">${icon(Lib.TIME_BANDS[state.band][0])}${BAND_NOTE[b]}</span>`;
  }
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
    <p class="status">${planCostText(p.stops)}</p>
    <details class="plan-add" ${p.adding ? 'open' : ''}><summary>＋行き先を追加</summary>
      <input type="search" class="plan-q" placeholder="名前・料理で探す（例：温泉、ラーメン、道の駅）" aria-label="追加する行き先を探す" value="${esc(p.q || '')}">
      <div class="plan-results"></div>
      <p class="hint">近くのおすすめ</p><div class="chips wrap plan-sugg"></div></details>
    <div class="actions"><a class="btn primary" href="${esc(Lib.gmapsDirUrl(DATA.cfg.origin, DATA.cfg.origin, places, GMAP_MODE[state.mode]))}" target="_blank" rel="noopener">Googleマップで1日の経路</a>
      <button type="button" class="btn plan-order">近い順に並べ替え</button>
      <button type="button" class="btn plan-share">プランを共有</button>
      <button type="button" class="btn plan-reset">最初から作り直す</button>
      <button type="button" class="btn primary plan-save">${p.savedId ? '保存を上書き' : '💾 このプランを保存'}</button></div>
    <details class="help"><summary aria-label="説明を見る">i</summary>最初の案は、昼食を目的地から1.5km以内（昼に営業中か営業時間不明・チェーン以外）、もう1か所を15km以内の温泉か3km以内の見どころから選んでいます。</details>`;
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
  el.querySelector('.plan-save').onclick = () => { savePlan(s, p); buzz(); redraw(); const c = $('#t-plans'); if (c) c.textContent = `📋保存したプラン（${savedPlans().length}）`; };
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
// 日帰りプランの 1 日の交通費の目安（区間ごとの直線距離から。車は道のりを直線の 1.3 倍とみなす）
function planCostText(stops) {
  const pts = [DATA.cfg.origin, ...stops.map((x) => x.place), DATA.cfg.origin];
  const legs = pts.slice(1).map((p, i) => Lib.haversineKm(pts[i], p)).filter((d) => d > 0.3);
  const cc = costCfg();
  if (state.mode === 'train') return `💴 1日の交通費の目安：電車 約${Lib.yen(legs.reduce((a, d) => a + Lib.trainFare(d), 0))}（${legs.length}区間・JR の運賃で概算。近い区間は歩きの場合も）`;
  if (state.mode === 'bicycle') return '💴 交通費：自転車なので 0 円';
  const bike = state.mode === 'bike', km = legs.reduce((a, d) => a + d, 0) * 1.3;
  return `💴 1日の交通費の目安：ガソリン 約${Lib.yen(Lib.fuelCost(km, bike ? cc.bike : cc.car, cc.price))}（約${Math.round(km)}km・高速代は別。ツーリングでルートを出すと高速料金も計算）`;
}

// ---- 保存した日帰りプラン（端末の中に最大 30 件） ----
// 場所は表示と時刻の計算に使う項目だけを残す（保存領域を節約）
const slim = (x) => { const o = {}; for (const k of ['id', 'name', 'lat', 'lon', 'genres', 'note', 'oh', 'chain', 'url', 'pref', 'indoor', 'kana', 'op', 'wp']) if (x[k] != null) o[k] = x[k]; return o; };
const savedPlans = () => store.get('plans') || [];
function savePlan(s, p) {
  const list = savedPlans();
  const today = new Date();
  const name = p.savedId ? (list.find((x) => x.id === p.savedId) || {}).name
    : prompt('プランの名前', `${s.name}（${today.getMonth() + 1}/${today.getDate()}）`);
  if (!name) return;
  const rec = { id: p.savedId || `plan-${Date.now()}`, name: String(name).slice(0, 40), at: Date.now(), spot: slim(s), depart: planState.depart, home: p.home,
    mode: state.mode, stops: p.stops.map((x) => ({ place: slim(x.place), stay: x.stay, kind: x.kind })) };
  const rest = list.filter((x) => x.id !== rec.id);
  store.set('plans', [rec, ...rest].slice(0, 30));
  p.savedId = rec.id;
  alert(`「${rec.name}」を保存しました。スポット一覧の上の「📋保存したプラン」から開けます。`);
}
function openSavedPlan(id, el) {
  const rec = savedPlans().find((x) => x.id === id); if (!rec) return;
  PLANS.set(rec.spot.id, { stops: rec.stops.map((x) => ({ ...x })), home: rec.home || '', savedId: rec.id });
  planState.depart = rec.depart || planState.depart;
  INFO_ITEMS.set(rec.spot.id, rec.spot);
  renderPlan(el, rec.spot);
}
function renderPlansView(box) {
  const list = savedPlans();
  box.innerHTML = `<div class="actions"><button type="button" class="btn" id="plans-close">← 一覧に戻る</button></div>
    <h3>📋 保存した日帰りプラン（${list.length}件）</h3>
    ${list.length ? list.map((r) => `<article class="card"><strong>${esc(r.name)}</strong>
      <p class="meta">${new Date(r.at).toLocaleDateString('ja-JP')}に保存・${r.stops.length}か所・出発${esc(r.depart || '')}${r.home ? `・帰宅${esc(r.home)}` : ''}</p>
      <p class="note">${r.stops.map((x) => esc(x.place.name)).join(' → ')}</p>
      <div class="actions"><button type="button" class="btn primary" data-plan-open="${esc(r.id)}">開く・編集</button>
        <button type="button" class="btn" data-plan-del="${esc(r.id)}">削除</button></div>
      <div class="plan" data-plan-box="${esc(r.id)}"></div></article>`).join('')
      : '<p class="hint">まだありません。スポットの「▼詳しく」→「日帰りプラン」→「💾 このプランを保存」で保存できます。</p>'}`;
  $('#plans-close').onclick = () => { state.plansView = false; renderSpotList(); };
  box.querySelectorAll('[data-plan-open]').forEach((b) => { b.onclick = () => { buzz(); openSavedPlan(b.dataset.planOpen, box.querySelector(`[data-plan-box="${b.dataset.planOpen}"]`)); }; });
  box.querySelectorAll('[data-plan-del]').forEach((b) => { b.onclick = () => {
    if (!confirm('このプランを削除しますか？')) return;
    store.set('plans', savedPlans().filter((x) => x.id !== b.dataset.planDel)); renderPlansView(box);
  }; });
}

// 追加した場所の滞在時間の目安（食事は 60 分、それ以外は種類から）
const stayGuess = (x) => ((x.genres || []).includes('food') ? 60 : (x.genres || []).includes('onsen') ? 90 : (x.genres || []).some((g) => ['museum', 'play', 'experience'].includes(g)) ? 120 : 60);
// Overpass（OpenStreetMap の検索）: 混雑（429・504 など）のときは別のサーバーで試す
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
async function overpass(body) {
  let last = null;
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: timeoutSignal(15000) });
      if (r.ok) { const j = await r.json(); if (!j.remark || !/runtime error/i.test(j.remark)) return j; }
      last = new Error(`HTTP ${r.status}`);
    } catch (err) { last = err; }
  }
  throw last || new Error('overpass');
}
// ---- 駐車場: その施設の駐車場（100m 以内の利用者用・同じ名前）と、周辺 600m の車・バイクの駐車場 ----
const PARK = new Map(); // 地点 → 結果（同じ場所は取り直さない）
async function fetchParking(p, m = 600) {
  const key = `${p.lat.toFixed(4)},${p.lon.toFixed(4)},${m}`;
  if (PARK.has(key)) return PARK.get(key);
  const v = Lib.parseParking(await overpass(Lib.parkingQuery(p, m, BIKE_KM * 1000)), p);
  PARK.set(key, v);
  return v;
}
const distTxt = (d) => (d < 1 ? `${Math.round(d * 1000)}m` : `${d.toFixed(1)}km`);
function parkRow(x, bike) {
  // 名前を押すと Google マップでその場所を確かめる（経路は横の「🧭経路」から）
  const place = { name: x.name || (bike ? 'バイク駐車場' : '駐車場'), lat: x.lat, lon: x.lon };
  const info = [x.kind || x.type, x.fee, x.capacity ? `${x.capacity}台` : '', bike && (x.capMoto || x.cap) ? `二輪${x.capMoto || x.cap}台` : '', !bike && x.motoNo ? 'バイク不可' : '',
    x.moped && !x.official ? '原付だけの可能性' : '', x.access === 'customers' ? '利用者用' : '', bike && x.src === 'OpenPOI' ? '🌐OpenPOI' : '', x.hours ? `利用時間 ${x.hours}` : '',
    x.addr ? `住所 ${x.addr}` : ''].filter(Boolean).join('・'); // 公式データの一部（札幌市など）は座標がなく住所の町丁目の代表点なので、住所で確かめられるように
  return `<li>${x.official ? '<span class="badge open">公式</span> ' : ''}${x.own ? '<span class="badge open">この施設の駐車場（名前が一致）</span> ' : ''}${x.likely ? '<span class="badge closed">たいてい止められる</span> ' : ''}<a ${gm(place)}>${esc(x.name || (bike ? '（名前なし）バイクを止められる場所' : '（名前なし）駐車場'))}</a>
    <span class="status">${distTxt(x.distKm)}・<a ${gm(place, 'dir')}>🧭経路</a>${info ? '・' + esc(info) : ''}${x.oh ? '・' + esc(Lib.ohText(x.oh)) : ''}${openBadge(x)}${x.srcName ? `・出典：${x.srcUrl ? `<a href="${esc(x.srcUrl)}" target="_blank" rel="noopener">${esc(x.srcName)}</a>` : esc(x.srcName)}` : ''}</span></li>`;
}
// 前もって集めたバイクを止められる場所。公式データ（全国 1 ファイル）は初めて使うときに 1 回だけ、
// 自動収集の分（data/area/moto）は調べる地点のまわりの升目を読む（起点から遠い旅先で探しても出るように）
let MOTO = null;
async function motoData(p) {
  const [osm, official] = await Promise.all([loadArea('moto', p, BIKE_KM),
    MOTO || getJSON('data/moto_official.json', []).then((xs) => { FAILED.delete('data/moto_official.json'); return (MOTO = xs.map(Lib.officialMoto)); })]);
  return official.concat(osm.map((x) => ({ ...x, kind: x.type })));
}
// 道の駅（立ち寄り候補のデータ）。起点から読み込んだ範囲の外なら、その地点のまわりを読む
const michiNear = async (p) => (Lib.haversineKm(DATA.cfg.origin, p) + BIKE_KM <= DATA.cfg.poiRadiusKm ? DATA.pois : await loadArea('pois', p, BIKE_KM))
  .filter((x) => x.kind === 'michinoeki').map((x) => ({ name: x.name, lat: x.lat, lon: x.lon, type: '道の駅', likely: true }));
// OpenPOI で名前に「バイク」「二輪」などを含む駐車場（2km 以内）
async function openPoiBike(p) {
  if (navigator.onLine === false) return [];
  const out = [];
  for (const q of ['バイク 駐車場', '二輪 駐車場']) {
    try {
      const r = await fetch(Lib.openPoiUrl(q, p, 2, 50), { signal: timeoutSignal(8000) });
      if (r.ok) out.push(...Lib.parseOpenPoi(await r.json()).filter((x) => Lib.MOTO_NAME_RE.test(x.name)).map((x) => ({ ...x, type: 'バイク駐車場（OpenPOI）' })));
    } catch { /* ネットの分はなしで */ }
  }
  return out;
}
// 前もって集めた車の駐車場（data/park/<升目>.json）。その場所のまわりの升目だけ読む
let PARK_INDEX;
const PARK_CELLS = new Map();
async function parkNear(p, km) {
  if (PARK_INDEX === undefined) { PARK_INDEX = await getJSON('data/park/index.json', null); FAILED.delete('data/park/index.json'); }
  if (!PARK_INDEX) return [];
  const ids = Lib.cellsInRadius(p, km).filter((id) => PARK_INDEX[id]);
  await Promise.all(ids.filter((id) => !PARK_CELLS.has(id)).map(async (id) => PARK_CELLS.set(id, await getJSON(`data/park/${id}.json`, []))));
  return ids.flatMap((id) => PARK_CELLS.get(id) || []).map(Lib.parkFromCell).filter((x) => Lib.haversineKm(p, x) <= km);
}
// OpenPOI で「駐車場」「パーキング」（1km 以内）
async function openPoiCar(p) {
  if (navigator.onLine === false) return [];
  const out = [];
  for (const q of ['駐車場', 'パーキング']) {
    try {
      const r = await fetch(Lib.openPoiUrl(q, p, 1, 100), { signal: timeoutSignal(8000) });
      if (r.ok) out.push(...Lib.parseOpenPoi(await r.json()).filter((x) => /駐車|パーキング|parking/i.test(x.name)).map((x) => ({ name: x.name, lat: x.lat, lon: x.lon, kind: '駐車場（OpenPOI）', src: 'OpenPOI' })));
    } catch { /* ネットの分はなしで */ }
  }
  return out;
}
const CAR_KM = 1, BIKE_KM = 3, PARK_SHOW = 20;
async function renderParking(el, s, only) {
  if (!el) return;
  const title = `<h4>🅿 駐車場（${esc(s.name)}の周辺。車は${CAR_KM}km・バイクは${BIKE_KM}km以内）</h4>`;
  el.innerHTML = `${title}<p class="hint">探しています…</p>`;
  const gmLinks = `<div class="actions"><a class="btn" href="${esc(`https://www.google.com/maps/search/${encodeURIComponent('バイク 駐車場')}/@${s.lat},${s.lon},16z`)}" target="_blank" rel="noopener">Googleマップでバイク駐車場</a>
    <a class="btn" href="${esc(`https://www.google.com/maps/search/${encodeURIComponent('駐車場')}/@${s.lat},${s.lon},16z`)}" target="_blank" rel="noopener">Googleマップで駐車場</a></div>`;
  const shown = { car: PARK_SHOW, bike: PARK_SHOW, maybe: 8 };
  let live = null, liveState = 'loading', got = null;
  // 前もって集めた分・OpenPOI はすぐ出し、その場の検索（OpenStreetMap）は届いたら足す
  const draw = () => {
    if (!el.isConnected || !got) return;
    const [moto, opBike, localCar, opCar, michi] = got;
    const car = Lib.dedupeNear(Lib.markOwn(localCar.concat(live ? live.car : [], opCar).filter((x) => Lib.haversineKm(s, x) <= CAR_KM), s))
      .sort((a, b) => (b.own - a.own) || a.distKm - b.distKm);
    const bike = Lib.mergeBikeSpots(s, BIKE_KM, [['OSM', moto], ['live', live ? live.bike : []],
      ['OSM', car.filter((x) => x.motoOk).map((x) => ({ ...x, kind: `${x.kind}（二輪可）` }))], ['OpenPOI', opBike], ['道の駅', michi]]);
    const bikeSet = new Set(bike.map((x) => `${x.lat.toFixed(4)},${x.lon.toFixed(4)}`));
    const maybe = car.filter((x) => Lib.maybeMoto(x) && !bikeSet.has(`${x.lat.toFixed(4)},${x.lon.toFixed(4)}`));
    const own = car.concat(bike).filter((x) => x.own);
    const sec = (key, head, xs, bike2, empty) => `<h4>${head}（${xs.length}件・近い順）</h4>` + (xs.length
      ? `<ul class="rel">${xs.slice(0, shown[key]).map((x) => parkRow(x, bike2)).join('')}</ul>${xs.length > shown[key] ? `<button type="button" class="btn" data-park-more="${key}">もっと見る（残り${xs.length - shown[key]}件）</button>` : ''}`
      : `<p class="hint">${empty}</p>`);
    el.innerHTML = `${title}
      ${sureHtml}
      ${only !== 'car' ? sec('bike', '🏍 バイクを止められる所', bike, true, '見つかりませんでした（OpenStreetMap に登録が少ないため）。下の「止められるかもしれない所」や Google マップも確認してください。') : ''}
      ${only !== 'car' && maybe.length ? `<details class="more"><summary>参考：二輪の可否が登録されていない大きな駐車場（${maybe.length}件・未確認）</summary>${sec('maybe', '🏍 二輪の可否が未確認の駐車場', maybe, true, '')}<details class="help"><summary aria-label="説明を見る">i</summary>施設の利用者用や 50 台以上の駐車場で、二輪を止められるかは分かりません（コインパーキングは除外）。止める前に現地の表示を確認してください。</details></details>` : ''}
      ${only !== 'bike' ? sec('car', '🚗 車の駐車場', car, false, '見つかりませんでした。') : ''}
      ${liveState === 'loading' ? '<p class="hint">🔄 OpenStreetMap でも探しています…</p>' : liveState === 'failed' ? '<p class="hint">⚠ その場の検索は混雑のためできませんでした（前もって集めた情報で表示しています）。</p>' : ''}
      <details class="help"><summary aria-label="説明を見る">i</summary>情報元：自治体の公式データ（「公式」の印）、OpenStreetMap（週 1 回まとめて収集＋その場の検索）、<a href="licenses/FSQ-OS-Places-NOTICE.txt" target="_blank" rel="noopener">Foursquare OS Places（Apache-2.0・2025年2月版）</a>、OpenPOI、道の駅・SA・PA（「たいてい止められる」）。満空・料金・二輪の可否は現地や公式で確認してください。</details>${gmLinks}`;
    el.querySelectorAll('[data-park-more]').forEach((b) => { b.onclick = () => { shown[b.dataset.parkMore] += 30; draw(); }; });
    fillAddr(el);
  };
  // お店の駐車場（確かな情報）: 厳選の登録・駐車場の名前・Google マップ
  let gp = GPARK.get(s.id) || null;
  if (!gp && store.get('gkey') && s.lat != null) { try { const g = await googlePhotos(s); gp = g && Lib.parkingOptionsText(g.parking); if (gp) GPARK.set(s.id, gp); } catch { /* なしで */ } }
  const sure = [s.parking ? `登録済み：${s.parking.car ? '🚗車の駐車場あり' : '🚗車の駐車場なし'}${s.parking.bike ? '・🏍二輪を止められる' : ''}` : '',
    s.pk === 2 ? '駐車場の名前にこの施設の名前が入った駐車場があります（OpenStreetMap）' : '',
    gp ? `Google マップ：${gp.text}` : ''].filter(Boolean);
  const sureHtml = `<p class="status"><strong>この施設の駐車場：</strong>${sure.length ? esc(sure.join('／')) : '確かな情報がありません'}${!store.get('gkey') ? '（設定タブで Google の API キーを入れると、Google マップの駐車場情報も出せます）' : ''}</p>`;
  const [localCar] = await Promise.all([parkNear(s, Math.max(CAR_KM, 1.2))]);
  const [moto, opBike, opCar, michi] = await Promise.all([motoData(s), openPoiBike(s), openPoiCar(s), michiNear(s)]);
  got = [moto, opBike, localCar, opCar, michi];
  draw();
  try { live = await fetchParking(s); liveState = 'done'; } catch { liveState = 'failed'; }
  draw();
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-park]'); if (!b) return;
  const s = INFO_ITEMS.get(b.dataset.park); if (!s) return;
  buzz(); renderParking(b.closest('.info').querySelector('.nearby'), s);
});

async function renderNearby(el, s, kind) {
  el.innerHTML = `<p class="hint">${esc(Lib.NEARBY_KINDS[kind][0])}を探しています…</p>`;
  try {
    const xs = Lib.parseNearby(await overpass(Lib.nearbyQuery(s, kind)), s).slice(0, 6);
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
      suggest(e.target.value);
    });
    $('#search-slot').insertAdjacentHTML('beforeend', '<div id="q-sugg" class="sugg" role="listbox" hidden></div>');
    $('#q').addEventListener('focus', (e) => suggest(e.target.value));
    $('#q').addEventListener('blur', () => setTimeout(() => { const b = $('#q-sugg'); if (b) b.hidden = true; }, 200));
  }
  renderSpotList();
}
function renderSpotList() {
  const box = $('#spot-list'); if (!box) return;
  if (state.plansView) { renderPlansView(box); return; }
  if (state.q.trim()) {
    // 「近くの○○」は現在地（取れなければ起点）のまわりを探す
    const nq = Lib.nearQuery(state.q);
    if (nq) { renderNearList(box, nq.word); return; }
    // 手元のデータは観光スポット・厳選と、すでに読み込んだグルメなどだけ（検索のために升目を読み込まない＝通信量を抑える）。
    // グルメなどの全件は OpenPOI で探す
    const all = DATA.spots.concat(DATA.osm, poiSpotList(), [...CELL_DATA.values()].flat().filter((s) => state.showChains || !s.chain));
    const hits = Lib.searchSpots(all, state.q, DATA.cfg, state.favs, state.mode, 300);
    // OpenPOI API（ネットの施設検索）でも探す。手元のデータにない場所だけ、下にまとめて出す
    const net = openPoiFor(state.q, DATA.cfg.origin, Math.min(loadKm(), 60));
    const netHits = (net.items ? Lib.notInLocal(net.items, hits) : []).map((x) => withMinutes(x)).sort((a, b) => a.minutes - b.minutes);
    setCount(null);
    box.innerHTML = `<p class="status">「${esc(state.q.trim())}」の検索結果 ${hits.length}件（アプリ内のデータ・近い順）。お店などはネットの検索結果（下）も。「近くの○○」で現在地のまわりを探せます</p>`
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
    `<button type="button" class="chip" id="t-plans">📋保存したプラン${savedPlans().length ? `（${savedPlans().length}）` : ''}</button>`,
    `<button type="button" class="chip" id="t-open" aria-pressed="${state.openOnly}">🕘営業中だけ</button>`,
    `<button type="button" class="chip" id="t-park" aria-pressed="${state.parkOnly}">🅿駐車場あり</button>`,
    `<button type="button" class="chip" id="t-quick" aria-pressed="${state.quickOnly}">☕ちょっとお出かけ</button>`,
    `<button type="button" class="chip" id="t-night" aria-pressed="${state.nightPlay}">🌙夜も遊べる</button>`,
    `<button type="button" class="chip" id="t-season" aria-pressed="${state.seasonOnly}">🌸今が見頃</button>`,
    state.mode !== 'train' ? `<button type="button" class="chip" id="t-iso" aria-pressed="${state.isoOn}">⏱今から行ける（道のりで判定）</button>` : '', // 道のりの判定は車・バイク・自転車だけ
    (state.genres.has('factory') || state.genres.has('experience')) ? `<button type="button" class="chip" id="t-walkin" aria-pressed="${state.walkinOnly}">当日参加OKだけ</button>` : '',
    groups.includes('food') ? `<button type="button" class="chip" id="t-chain" aria-pressed="${state.showChains}">チェーン店も表示</button>` : '',
  ].join('');
  const cats = groups.includes('food') ? `<div class="chips wrap" aria-label="料理のジャンル">${Lib.FOOD_CATS.map(([label]) =>
    `<button type="button" class="chip" data-foodcat="${esc(label)}" aria-pressed="${state.foodCat === label}">${esc(label)}</button>`).join('')}</div>` : '';
  const loadingCells = groups.length && cellLoading.size ? '・データを読み込み中…' : '';
  const noCells = groups.length && !cellIndex ? '・グルメなどのデータはまだ収集されていません' : '';
  const hiddenHint = state.genres.size || state.allTypes || state.q ? '' : hiddenGroupsHtml();
  const head = `${hiddenHint}<p class="status">${list.length.toLocaleString()}件・★厳選と⭐を先頭に表示${rainy() ? '（雨の日モード：屋内のみ）' : ''}${groups.length ? `・グルメなどは起点から${Math.round(cellKm())}km以内（遠くは検索欄で探せます）` : ''}${loadingCells}${noCells}${isoStatus()}</p>
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
  $('#t-plans').onclick = () => { buzz(); state.plansView = true; renderSpotList(); window.scrollTo(0, 0); };
  if (state.pendingGacha && DATA.osmLoaded && list.length) { state.pendingGacha = false; spin(list); }
  const ga = $('#gacha-again'); if (ga) ga.onclick = () => { buzz(); spin(list); };
  const gc = $('#gacha-close'); if (gc) gc.onclick = () => { state.gacha = null; renderSpotList(); };
  // それ自体が種類のようなものなので、押したら「種類」の選択は外す（重ねると 0 件になりやすい）
  const asCategory = (on) => { if (on && (state.genres.size || state.allTypes)) { state.genres.clear(); state.allTypes = false; saveFilters(); renderFilters(); } };
  $('#t-quick').onclick = () => { buzz(); state.quickOnly = !state.quickOnly; asCategory(state.quickOnly); state.limit = 300; renderSpotList(); };
  $('#t-night').onclick = () => { buzz(); state.nightPlay = !state.nightPlay; asCategory(state.nightPlay); state.limit = 300; renderSpotList(); };
  $('#t-park').onclick = () => { buzz(); state.parkOnly = !state.parkOnly; state.limit = 300; renderSpotList(); };
  $('#t-open').onclick = () => { buzz(); state.openOnly = !state.openOnly; state.limit = 300; renderSpotList(); };
  const ti = $('#t-iso'); if (ti) ti.onclick = () => { buzz(); state.isoOn = !state.isoOn; state.limit = 300; renderSpotList(); }; // 電車では出さない
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
  // 現在地を追いかけ中なら、作り直した地図にも青い点を出す
  if (LOC.watch != null && LOC.last) { LOC.maps.add(m); m.once('unload', () => LOC.maps.delete(m)); m.whenReady(() => drawHere(m)); }
}
// 現在地ボタン（Google マップのように）: 押すと青い点と精度の円を出して現在地へ移動し、そのまま位置を追いかける。
// もう一度押すと現在地へ戻る。青い点を押すと「ここから出発（起点にする）」
const LOC = { watch: null, last: null, maps: new Set() };
function hereHtml() {
  const isHere = String((store.get('origin') || {}).name || '').startsWith('現在地');
  return `<div class="pop"><strong>📍 現在地</strong>
    <p class="status">${LOC.last ? `誤差 約${Math.round(LOC.last.acc)}m` : ''}${isHere ? `・今の起点：${esc(DATA.cfg.origin.name)}` : ''}</p>
    <div class="actions"><button type="button" class="btn primary" data-here-origin>ここから出発（起点にする）</button>
      ${isHere ? `<button type="button" class="btn" data-here-reset>${esc(CFG_ORIGIN.name)}に戻す</button>` : ''}</div>
    <details class="help"><summary aria-label="説明を見る">i</summary>移動時間・ルート・日帰りプランが、ここからの計算になります</details></div>`;
}
function bindHere(el) {
  if (!el) return;
  const o = el.querySelector('[data-here-origin]');
  if (o) o.onclick = () => {
    const h = new Date();
    setOrigin({ name: `現在地（${h.getHours()}:${String(h.getMinutes()).padStart(2, '0')}）`, lat: +LOC.last.lat.toFixed(5), lon: +LOC.last.lon.toFixed(5) });
  };
  const r = el.querySelector('[data-here-reset]');
  if (r) r.onclick = () => setOrigin(null);
}
// その地図の青い点を今の位置に（なければ作る）
function drawHere(m) {
  const ll = [LOC.last.lat, LOC.last.lon];
  if (!m._here) {
    m._here = {
      acc: L.circle(ll, { radius: LOC.last.acc, weight: 1, color: '#1a73e8', fillColor: '#1a73e8', fillOpacity: 0.12, interactive: false }).addTo(m),
      dot: L.circleMarker(ll, { radius: 9, weight: 3, color: '#fff', fillColor: '#1a73e8', fillOpacity: 1, bubblingMouseEvents: false })
        .bindPopup(hereHtml, { maxWidth: 260 }).on('popupopen', (e) => bindHere(e.popup.getElement())).addTo(m),
    };
  } else { m._here.acc.setLatLng(ll).setRadius(LOC.last.acc); m._here.dot.setLatLng(ll); }
}
function locate(m) {
  if (!navigator.geolocation) { alert('この端末では現在地を使えません。'); return; }
  LOC.maps.add(m);
  m.once('unload', () => LOC.maps.delete(m));
  const goHere = () => { drawHere(m); m.setView([LOC.last.lat, LOC.last.lon], Math.max(m.getZoom(), 15)); m._here.dot.openPopup(); };
  if (LOC.last && LOC.watch != null) { goHere(); return; } // 追いかけ中なら現在地へ戻るだけ
  let first = true;
  LOC.watch = navigator.geolocation.watchPosition((p) => {
    LOC.last = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy || 30 };
    for (const mm of LOC.maps) drawHere(mm);
    if (first) { first = false; goHere(); }
  }, () => {
    navigator.geolocation.clearWatch(LOC.watch); LOC.watch = null;
    alert('現在地を取得できませんでした（位置情報の許可を確認してください）。');
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
}
// 画面を離れたら位置の追いかけを止める（電池の節約。戻ったら ◎ でまた始める）
document.addEventListener('visibilitychange', () => {
  if (document.hidden && LOC.watch != null) { navigator.geolocation.clearWatch(LOC.watch); LOC.watch = null; }
});

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

// ---- 検索の入力補完: アプリの中の候補（すぐ）＋ OpenPOI の候補（入力が止まって 0.3 秒後） ----
let suggTimer = 0;
const SUGG = new Map();
function suggest(q) {
  const box = $('#q-sugg'); if (!box) return;
  const t = String(q || '').trim();
  if (!t) { box.hidden = true; return; }
  const local = Lib.localSuggest(t, DATA.spots.concat(DATA.osm), 6);
  const draw = (net) => {
    if (String($('#q').value).trim() !== t) return;
    const words = [...new Set(local.concat(net ? net.words : []))].slice(0, 6);
    const places = net ? net.places.filter((x) => !words.includes(x)).slice(0, 4) : [];
    box.innerHTML = words.map((w) => `<button type="button" class="sugg-item" data-sugg-q="${esc(w)}">🔍 ${esc(w)}</button>`).join('')
      + places.map((w) => `<button type="button" class="sugg-item" data-sugg-q="${esc(w)}">🌐 ${esc(w)}</button>`).join('');
    box.hidden = !(words.length + places.length) || document.activeElement !== $('#q');
  };
  draw(SUGG.get(t));
  clearTimeout(suggTimer);
  if (t.length < 2 || SUGG.has(t) || navigator.onLine === false) return;
  suggTimer = setTimeout(async () => {
    try {
      const r = await fetch(Lib.openPoiSuggestUrl(t, DATA.cfg.origin), { signal: timeoutSignal(5000) });
      if (r.ok) { SUGG.set(t, Lib.parseSuggest(await r.json())); draw(SUGG.get(t)); }
    } catch { /* 候補はアプリの中の分だけ */ }
  }, 300);
}
document.addEventListener('mousedown', (e) => { if (e.target.closest('.sugg-item')) e.preventDefault(); }); // 押す前に入力欄のフォーカスが外れないように
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-sugg-q]'); if (!b) return;
  buzz();
  const q = $('#q'); q.value = b.dataset.suggQ; state.q = q.value; state.limit = 300;
  $('#q-sugg').hidden = true; q.blur();
  renderSpotList();
});

// ---- 「近くの○○」: 現在地（位置情報が使えなければ起点）から 3km 以内を、アプリ内のデータと OpenPOI で近い順に ----
const HERE = { p: null, at: 0, asking: false, denied: false };
function hereOrOrigin() {
  if (HERE.p && Date.now() - HERE.at < 5 * 60e3) return { ...HERE.p, here: true };
  if (!HERE.asking && !HERE.denied && navigator.geolocation) {
    HERE.asking = true;
    navigator.geolocation.getCurrentPosition((pos) => {
      HERE.p = { name: '現在地', lat: pos.coords.latitude, lon: pos.coords.longitude }; HERE.at = Date.now(); HERE.asking = false;
      if (state.tab === 'spots') renderSpotList();
    }, () => { HERE.asking = false; HERE.denied = true; if (state.tab === 'spots') renderSpotList(); }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 120000 });
  }
  return { ...DATA.cfg.origin, here: false };
}
const NEAR_KM = 3;
function renderNearList(box, word) {
  const c = hereOrOrigin();
  if (Lib.isParkingWord(word)) {
    setCount(null);
    const where = c.here ? '現在地' : `${esc(DATA.cfg.origin.name)}（現在地を使えないため起点）`;
    box.innerHTML = `<p class="status">📍${where}のまわりの駐車場${HERE.asking ? '・現在地を取得中…' : ''}</p><div class="nearby"></div>`;
    renderParking(box.querySelector('.nearby'), { ...c, name: c.here ? '現在地' : DATA.cfg.origin.name }, Lib.isBikeWord(word) ? 'bike' : null);
    return;
  }
  ensureCells(ALL_GROUPS, c, NEAR_KM).then((changed) => { if (changed && state.tab === 'spots') renderSpotList(); });
  const pool = DATA.spots.concat(DATA.osm, poiSpotList(), cellItems(ALL_GROUPS, c, NEAR_KM).filter((s) => state.showChains || !s.chain));
  const local = Lib.nearSearch(pool, word, c, NEAR_KM);
  const net = openPoiFor(Lib.netWord(word), c, NEAR_KM);
  const netItems = net.items ? Lib.notInLocal(net.items, local).map((x) => ({ ...x, distKm: Lib.haversineKm(c, x) })).filter((x) => x.distKm <= NEAR_KM) : [];
  const all = local.concat(netItems).sort((a, b) => a.distKm - b.distKm).map((x) => ({ ...withMinutes(x), tier: x.op ? 2 : Lib.tierOf(x, state.favs) }));
  setCount(null);
  const where = c.here ? '現在地' : `${esc(DATA.cfg.origin.name)}（現在地を使えないため起点）`;
  box.innerHTML = `<p class="status">📍${where}から${NEAR_KM}km以内の「${esc(word)}」${all.length}件（近い順）${HERE.asking ? '・現在地を取得中…' : ''}${net.busy ? '・ネットでも探しています…' : ''}</p>`
    + mapToggle()
    + (!all.length ? (net.busy || cellLoading.size ? '<p class="hint">探しています…</p>' : '<p class="empty">見つかりませんでした。別の言葉（例：ラーメン、カフェ、コンビニ、温泉）でも試してください。</p>')
      : state.spotMap ? '<div id="spot-map"></div>' : all.slice(0, 100).map((s) => spotCard({ ...s, note: `${s.distKm < 1 ? Math.round(s.distKm * 1000) + 'm' : s.distKm.toFixed(1) + 'km'}${s.op ? '・🌐' : ''}${s.note ? '・' + s.note : ''}` })).join(''))
    + (netItems.length ? '<p class="credit">施設データの一部：<a href="https://openpoiapi.com/attribution.html" target="_blank" rel="noopener">OpenPOI API 出典・ライセンス</a></p>' : '');
  bindMapToggle(all);
}

// ---- OpenPOI API: 入力が止まってから 0.6 秒後に 1 回だけ問い合わせる（同じ語・範囲は覚えておく） ----
const OPOI = new Map(); // 'q|lat,lon|km' → { busy, items, error }（現在地は 100m 単位で同じとみなす）
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

// ---- 地図の点: 種類の絵文字（🏯⛩♨🍴など）のピン。★厳選・⭐は金色の縁、選んだ立ち寄りは番号つき ----
const KIND_EMOJI = { michinoeki: '🚏', onsen: '♨', viewpoint: '🔭', scenic: '🏞', fuel24: '⛽' };
function emojiOf(s) {
  if (s.kind && KIND_EMOJI[s.kind]) return KIND_EMOJI[s.kind];
  if (s.g === 'food' && (s.k === 'cafe' || s.k === 'sweets')) return '☕';
  const g = (s.genres || []).find((x) => GENRES[x]);
  return g ? icon(GENRES[g]) : '📍';
}
const ICONS = new Map(); // 同じ見た目のアイコンは使い回す（数千個でも軽く）
function pinIcon(s, opts = {}) {
  const top = opts.top ?? s.tier === 0, num = opts.num || 0;
  const html = `<span class="pin${top ? ' top' : ''}${opts.picked ? ' picked' : ''}">${emojiOf(s)}${num ? `<b>${num}</b>` : ''}</span>`;
  // ずらしたアイコン（ルートに重ならないように）: 本当の位置に小さな点、そこからアイコンまで細い線
  if (opts.dx || opts.dy) {
    const x = -opts.dx, y = -opts.dy;
    return L.divIcon({ className: '', iconSize: [32, 32], iconAnchor: [16 + x, 16 + y], popupAnchor: [0, -14],
      html: `<svg class="pin-stem" width="32" height="32" aria-hidden="true"><line x1="16" y1="16" x2="${16 + x}" y2="${16 + y}"/><circle cx="${16 + x}" cy="${16 + y}" r="3.5"/></svg>${html}` });
  }
  const key = `${emojiOf(s)}|${top}|${num}|${!!opts.picked}`;
  if (!ICONS.has(key)) ICONS.set(key, L.divIcon({ className: '', iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -14], html }));
  return ICONS.get(key);
}

// ---- 候補を地図で見る（一覧・検索結果の全件。近いピンは数字の丸にまとめ、寄ると分かれる） ----
let spotMap = null;
const SPOT_MAP_MAX = 60000; // グルメなども含めた「すべて」でも全部入る数
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
  const mk = (s) => L.marker([s.lat, s.lon], { icon: pinIcon(s), title: s.name, riseOnHover: true })
    .bindPopup(() => spotPopup(s), { maxWidth: 260 }).on('popupopen', (e) => fillAddr(e.popup.getElement()));
  const top = shown.filter((s) => isCurated(s) || state.favs.has(s.id));
  const note = L.control({ position: 'bottomleft' });
  if (L.markerClusterGroup) {
    // 全件を出す。近いピンは数字の丸にまとめ（押すと寄る）、ズーム16からは全部ばらして出す。重なった所は押すと広がる
    const cluster = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 45, disableClusteringAtZoom: 16, spiderfyOnMaxZoom: true, showCoverageOnHover: false,
      iconCreateFunction: (c) => { const n = c.getChildCount(); return L.divIcon({ className: '', iconSize: [40, 40], html: `<span class="cluster${n >= 100 ? ' big' : ''}">${n >= 1000 ? Math.round(n / 100) / 10 + '千' : n}</span>` }); } });
    cluster.addLayers(shown.map(mk));
    spotMap.addLayer(cluster);
    note.onAdd = () => { const d = L.DomUtil.create('div', 'map-note'); d.textContent = list.length > shown.length ? `${shown.length.toLocaleString()}件を表示（全${list.length.toLocaleString()}件のうち★厳選と近い順。数字の丸を押すと寄ります）` : `${shown.length.toLocaleString()}件すべて表示（数字の丸を押すと寄ります）`; return d; };
    note.addTo(spotMap);
  } else {
    // まとめる部品が読めないとき（初めての圏外など）: 引いた地図では★厳選と⭐だけ、ズーム12以上で見えている範囲の全部
    L.layerGroup(top.map(mk)).addTo(spotMap);
    const rest = shown.filter((s) => !isCurated(s) && !state.favs.has(s.id)), restLayer = L.layerGroup().addTo(spotMap);
    note.onAdd = () => { const d = L.DomUtil.create('div', 'map-note'); d.textContent = `★厳選・⭐のみ表示（寄るとほか${rest.length.toLocaleString()}件も）`; return d; };
    const refresh = () => {
      restLayer.clearLayers();
      if (spotMap.getZoom() < 12) { if (rest.length) note.addTo(spotMap); return; }
      note.remove();
      const b = spotMap.getBounds().pad(0.2);
      rest.filter((s) => b.contains([s.lat, s.lon])).slice(0, 400).forEach((s) => restLayer.addLayer(mk(s)));
    };
    spotMap.on('moveend zoomend', refresh);
    refresh();
  }
  if (shown.length) spotMap.fitBounds(L.latLngBounds((top.length ? top : shown).map((s) => [s.lat, s.lon])).pad(0.05), { maxZoom: 14 });
}
function spotPopup(s) {
  INFO_ITEMS.set(s.id, s); // 「ここを目的地にする」で使う
  return `<div class="pop"><strong>${isCurated(s) ? '★ ' : ''}${s.genres.map((g) => icon(GENRES[g] || '・')).join('')} ${esc(s.name)}</strong>
    <p class="meta">${icon(MODES[state.mode])}${fmtMin(s.minutes)}${s.indoor ? '・☔雨OK' : ''}${s.walkin === true ? '・当日参加OK' : s.walkin === false ? '・要予約' : ''}</p>
    ${s.note ? `<p>${esc(s.note)}</p>` : ''}
    <div class="actions"><a class="btn" ${gm(s, 'dir')}>経路</a><a class="btn" ${gm(s)}>写真・口コミ・GoogleMapで確認</a></div>
    <button type="button" class="btn primary" data-spot-dest="${esc(s.id)}">🏍ここを目的地にする</button></div>`;
}
// ---- Google マップの写真（設定タブで API キーを入れたときだけ。規約に沿って写真は端末に保存しない） ----
async function googlePhotos(s) {
  const key = store.get('gkey');
  if (!key || s.lat == null) return null;
  const r = await fetch(Lib.PLACES_URL, { method: 'POST', body: Lib.placesBody(s), signal: timeoutSignal(8000),
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.location,places.photos,places.googleMapsUri,places.parkingOptions' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Lib.parsePlacesPhotos(await r.json(), s, key);
}
const GPARK = new Map(); // この起動中に Google マップから取れた駐車場情報（規約に沿って端末には保存しない）
async function fillGooglePhotos(el, s) {
  if (!el || !store.get('gkey')) return;
  el.innerHTML = '<p class="hint">Google マップの写真を読み込み中…</p>';
  try {
    const g = await googlePhotos(s);
    const pk = g && Lib.parkingOptionsText(g.parking);
    const pkHtml = pk ? `<p class="status"><strong>🅿 ${esc(pk.text)}</strong>（Google マップの情報）</p>` : '';
    el.innerHTML = pkHtml + (g && g.photos.length ? `<div class="photos">${g.photos.map((p) => `<a href="${esc(g.page || p.artistUri)}" target="_blank" rel="noopener">
      <img src="${esc(p.thumb)}" alt="${esc(s.name)}の写真" loading="lazy"><span class="credit">${p.artist ? '撮影: ' + esc(p.artist) + ' / ' : ''}Google マップ</span></a>`).join('')}</div>`
      : '<p class="hint">Google マップにこの場所の写真は見つかりませんでした。</p>');
    if (pk) { GPARK.set(s.id, pk); const meta = el.closest('article.card') && el.closest('article.card').querySelector('.meta'); if (meta && !meta.querySelector('.gpark')) meta.insertAdjacentHTML('beforeend', `<span class="gpark">・🅿${pk.has ? 'あり' : 'なし'}（Google）</span>`); }
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
  if (cached && cached.ver === 4) return cached; // 写真の探し方を変えたので、古い保存分は取り直す
  const ref = Lib.wikiRef(s);
  let summary = null, photos = [], failed = false;
  if (ref) {
    try { summary = Lib.parseSummary(await fetchJSON(Lib.summaryUrl(ref))); } catch (err) { if (!/HTTP 404/.test(err.message)) failed = true; }
  }
  if (!summary && s.lat != null) {
    try { summary = Lib.parseWikiSearch(await fetchJSON(Lib.wikiSearchUrl(s)), s); } catch { failed = true; }
  }
  if (!summary || !summary.thumb || (summary.byName && !summary.same)) {
    // まず施設名で（関係のある写真）、少なければ 1km 以内で撮られた写真も
    try { photos = Lib.parseCommons(await fetchJSON(Lib.commonsSearchUrl(s.name, 4))).map((p) => ({ ...p, byName: true })); } catch { failed = true; }
    if (photos.length < 2) {
      try {
        const seen = new Set(photos.map((p) => p.page));
        photos = photos.concat(Lib.parseCommons(await fetchJSON(Lib.commonsNearbyUrl(s.lat, s.lon, 1000, 4))).filter((p) => !seen.has(p.page)));
      } catch { failed = true; }
    }
  }
  const v = { summary, photos, ver: 4 };
  if (!failed) saveInfo(s.id, v); // 圏外などで取れなかったときは保存しない（次に開いたときに取り直す）
  return { ...v, failed };
}
// 地図の吹き出し: 名前・距離・写真 1 枚・説明・立ち寄りの追加ボタン
function popupHtml(s, v) {
  const picked = tour.picked.has(s.id);
  const img = v && v.summary && v.summary.thumb ? { src: v.summary.thumb, credit: v.summary.byName && !v.summary.same ? `写真: Wikipedia「${v.summary.title}」（付近）` : '写真: Wikipedia', page: v.summary.page }
    : v && v.photos && v.photos.length ? { src: v.photos[0].thumb, credit: `付近の写真${v.photos[0].artist ? '・撮影: ' + v.photos[0].artist : ''}（${v.photos[0].license || 'ライセンスはリンク先'}）`, page: v.photos[0].page } : null;
  const text = v && v.summary ? v.summary.text : s.note || '';
  return `<div class="pop">
    <strong>${s.genres.map((g) => icon(GENRES[g] || '・')).join('')} ${esc(s.name)}</strong>
    <div class="pop-sub">${s.alongKm != null ? `${Math.round(s.alongKm)}km地点・道から${s.offKm.toFixed(1)}km` : ''}${parkText(s) ? '・' + parkText(s) : ''}</div>
    ${img ? `<a href="${esc(img.page)}" target="_blank" rel="noopener"><img class="pop-img" src="${esc(img.src)}" alt="${esc(s.name)}の写真"></a><div class="credit">${esc(img.credit)}</div>` : ''}
    ${text ? `<p>${esc(text)}</p>` : ''}
    ${!v ? '<p class="hint">写真と説明を読み込み中…</p>' : v.failed ? '<p class="hint">写真と説明を読み込めませんでした（圏外の可能性）。</p>' : ''}
    ${v && v.summary && v.summary.page ? `<div class="credit">出典: <a href="${esc(v.summary.page)}" target="_blank" rel="noopener">Wikipedia</a></div>` : ''}
    <a class="btn" ${gm(s)}>写真・口コミ・GoogleMapで確認</a>
    <button type="button" class="btn ${picked ? '' : 'primary'} pop-pick" data-popup-pick="${esc(s.id)}">${picked ? '立ち寄りから外す' : '立ち寄りに追加'}</button>
    <button type="button" class="btn pop-park" data-pop-park="${esc(s.id)}">🅿 駐車場を見る</button>
    <button type="button" class="btn" data-spot-dest="${esc(s.id)}">🏁ここを目的地にする</button>
  </div>`;
}
// 地図の吹き出しの「ここを目的地にする」: ツーリングタブで、そのスポットまでのルートを探す
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-spot-dest]'); if (!b) return;
  const s = INFO_ITEMS.get(b.dataset.spotDest) || getStops().find((x) => x.id === b.dataset.spotDest); if (!s) return;
  buzz();
  if (spotMap) spotMap.closePopup();
  if (map) map.closePopup();
  if (state.tab !== 'touring') goTab('touring');
  if (setCustomDest(s.lat, s.lon, s.name) && navigator.onLine !== false) { const g = $('#route-go'); if (g && !g.disabled) g.click(); }
});
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
  const s = on && getStops().find((x) => x.id === id);
  if (s && s.g) tour.kept = tour.kept.filter((k) => k.id !== id).concat({ id, name: s.name, lat: s.lat, lon: s.lon, genres: s.genres, note: s.note, oh: s.oh, url: s.url, indoor: s.indoor, pref: s.pref, g: s.g, k: s.k });
  const cb = document.querySelector(`[data-stop="${CSS.escape(id)}"]`);
  if (cb) cb.checked = on;
  saveTour(); updateTourSelection();
  return true;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-pop-park]'); if (!b) return;
  const s = getStops().find((x) => x.id === b.dataset.popPark); if (!s) return;
  buzz(); if (map) map.closePopup();
  const out = $('#rt-out'); if (!out) return;
  renderParking(out, s, tour.opts.bike ? 'bike' : null); out.scrollIntoView({ block: 'start', behavior: 'smooth' });
});
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
    // 押すと開く一覧（開いたままにすると長くなるので、最初は閉じておく。描き直しても開閉は保つ）
    const open = new Set([...el.querySelectorAll('details[open]')].map((d) => d.dataset.k));
    const list = (k, title, xs, empty = '') => (xs.length || empty ? `<details class="rel-box" data-k="${k}" ${open.has(k) ? 'open' : ''}><summary>${title}（${xs.length}件）</summary>
      ${xs.length ? `<ul class="rel">${xs.map((x) => `<li>
      <a ${gm(x)}>${(x.genres || []).map((g) => icon(GENRES[g] || '・')).join('')} ${esc(x.name)}</a>
      <span class="status">${x.distKm < 1 ? Math.round(x.distKm * 1000) + 'm' : x.distKm.toFixed(1) + 'km'}${x.note ? '・' + esc(x.note) : ''}</span></li>`).join('')}</ul>` : `<p class="hint">${empty}</p>`}</details>` : '');
    el.innerHTML = list('s', '似たスポット', rel.similar) + list('n', '周辺のスポット（2km以内）', rel.nearby)
      + list('f', '近くのカフェ・食事（1km以内）', rel.food,
        !cellIndex ? 'カフェ・食事のデータはまだ収集されていません。' : '1km以内のカフェ・食事は見つかりませんでした。');
  };
  draw();
  if (await ensureCells(['food', 'heritage', 'local'], s, 2)) draw();
  fillAddr(el);
}

function infoHtml(s, v) {
  const parts = [];
  if (v.summary) {
    const rel = v.summary.byName && !v.summary.same; // 施設そのものではなく、付近の関連する記事
    if (rel) parts.push(`<p class="credit"><strong>関連する記事：${esc(v.summary.title)}</strong>（この場所の付近・この場所そのものの記事ではありません）</p>`);
    if (v.summary.thumb) parts.push(`<img class="info-img" src="${esc(v.summary.thumb)}" alt="${esc(rel ? v.summary.title : s.name)}の写真" loading="lazy">`);
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
  if (!isCard) body.insertAdjacentHTML('beforeend', `<div class="actions"><a class="btn" ${gm(s)}>写真・口コミ・GoogleMapで確認</a></div>`);
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

// Google マップで確かめたコースの出発地（gfrom。書いていないものは config の起点＝調布駅で確かめた）と、今の起点がそこか
const gFrom = (road) => road.gfrom || CFG_ORIGIN || DATA.cfg.origin;
const atGFrom = (road) => Lib.haversineKm(DATA.cfg.origin, gFrom(road)) < 1;

// ---- 今週末のおすすめ ----
// おすすめの元: ★厳選（関東）。起点から 100km 以内に厳選が少ない地方では、100km 以内の厳選と、
// 公式サイトか Wikipedia のある観光スポット（OpenStreetMap）から選ぶ（遠くの関東の厳選ばかり勧めないように）
function recPool() {
  const near = DATA.spots.filter((s) => Lib.haversineKm(DATA.cfg.origin, s) <= 100);
  return near.length >= 30 ? DATA.spots : near.concat(DATA.osm.filter((s) => (s.url || s.wp) && Lib.haversineKm(DATA.cfg.origin, s) <= 100));
}
// 「🔄ほかの提案」を押すたびに選び直す（週ごとの種に足す）
const REC = { shift: 0 };
const recSeed = () => Lib.weekSeed(new Date()) + REC.shift * 7919;
function renderRecommend() {
  const pool = recPool();
  const cands = Lib.filterSpots(pool, { ...filterState(), genres: new Set() }, DATA.cfg);
  const ctx = { favGenres: state.favGenres, rainy: rainy(), visited: state.visited };
  const rec = Lib.pickRecommendations(cands, ctx, recSeed(), 4);
  // 週末プランは時間帯ごとの天気で屋内・屋外を選ぶので、雨の日モードの絞り込み（屋内だけ）をかけない候補から
  const planCands = rainy() ? Lib.filterSpots(pool, { ...filterState(), genres: new Set(), rainy: false }, DATA.cfg) : cands;
  $('#recommend').innerHTML = `<div class="actions"><button type="button" class="btn" id="rec-more">🔄ほかの提案</button></div>`
    + weatherPlanHtml(planCands) + rec.map(spotCard).join('') + newDirHtml(rec);
  $('#rec-more').onclick = () => { buzz(); REC.shift++; renderRecommend(); };
  $('#rec').hidden = !rec.length;
  if (!WPLAN.loaded) loadWeatherPlan();
}
// まだ行っていない（行った記録の少ない）方面から 2 方面、各 2 か所。週ごとに入れ替わる
function newDirHtml(shown) {
  const recs = visitedRecords();
  const skip = new Set(shown.map((s) => s.id).concat([...state.visited]));
  const seed = recSeed();
  const out = [];
  for (const d of Lib.lessVisitedDirs(recs, DATA.cfg.origin, seed)) {
    const cands = Lib.filterSpots(recPool(), { ...filterState(), genres: new Set(), dirs: new Set([d.dir]) }, DATA.cfg).filter((s) => !skip.has(s.id));
    const xs = Lib.pickRecommendations(cands, { favGenres: state.favGenres, rainy: rainy(), visited: state.visited }, seed + out.length).slice(0, 2);
    if (!xs.length) continue;
    xs.forEach((s) => skip.add(s.id));
    out.push(`<h4 class="newdir">🧭まだ${d.count ? 'あまり' : ''}行っていない「${esc(dirName(d.dir))}」方面${d.count ? `（行った記録 ${d.count}か所）` : ''}</h4>${xs.map(spotCard).join('')}`);
    if (out.length >= 2) break;
  }
  return out.length ? `<div class="newdirs">${out.join('')}<details class="help"><summary aria-label="説明を見る">i</summary>「▼詳しく」→「行った」を押すと、行った記録の少ない方面を優先して提案します。</details></div>` : '';
}
// 週末の午前・午後の降水確率を見て、晴れの時間は屋外、雨の時間は屋内のスポットを当てる
const WPLAN = { loaded: false, days: null };
async function loadWeatherPlan() {
  WPLAN.loaded = true;
  const o = DATA.cfg.origin, { lat, lon } = o;
  let days = null;
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=precipitation_probability&timezone=Asia%2FTokyo&forecast_days=10`, { signal: timeoutSignal(8000) });
    const h = (await r.json()).hourly;
    days = Lib.weekend(new Date()).map((key) => {
      const day = new Date(`${key}T00:00:00`), max = (a, b) => Math.max(...h.time.map((t, i) => (t.startsWith(key) && +t.slice(11, 13) >= a && +t.slice(11, 13) < b ? h.precipitation_probability[i] : -1)));
      return { day, am: max(9, 12), pm: max(12, 17), night: max(17, 22) };
    }).filter((d) => d.am >= 0);
  } catch { /* 取れなければプランを出さない */ }
  if (DATA.cfg.origin !== o) return; // 取得中に起点を変えた（新しい起点の分は setOrigin のあとで取り直す）
  WPLAN.days = days;
  renderRecommend();
}
// 週末の時間帯ごとに 3 か所ずつ（晴れは屋外・雨は屋内）。夜は夜景・夜も遊べる所があれば
function weatherPlanHtml(cands) {
  if (!WPLAN.days || !WPLAN.days.length) return '';
  const used = new Set(), seed = recSeed();
  const isNight = (s) => (s.genres || []).includes('nightview') || (s.tags || []).includes('夜も遊べる');
  const pick = (xs, wet, k) => {
    const got = Lib.pickRecommendations(xs.filter((s) => !used.has(s.id) && (wet ? s.indoor : true)),
      { favGenres: state.favGenres, rainy: wet, visited: state.visited }, seed + k, 3);
    got.forEach((s) => used.add(s.id));
    return got;
  };
  const slot = (label, p, k, night) => {
    const wet = p >= 50;
    const xs = night ? pick(cands.filter(isNight), wet, k) : pick(cands.filter((s) => (wet ? s.indoor : !s.indoor) && !isNight(s)), wet, k);
    if (night && !xs.length) return '';
    return `<li>${label} ${wet ? '☔' : '☀'}${p}% → ${xs.length ? xs.map((s) => `<a ${gm(s)}>${esc(s.name)}</a>`).join('／') : '—'}${wet && xs.length ? '（屋内）' : ''}</li>`;
  };
  return `<div class="wplan"><strong>天気で選んだ週末プラン</strong><ul>${WPLAN.days.map((d, i) => `<li>${d.day.getMonth() + 1}/${d.day.getDate()}（${'日月火水木金土'[d.day.getDay()]}）<ul>
    ${slot('午前', d.am, i * 3)}${slot('午後', d.pm, i * 3 + 1)}${d.night >= 0 ? slot('夜', d.night, i * 3 + 2, true) : ''}</ul></li>`).join('')}</ul>
    <details class="help"><summary aria-label="説明を見る">i</summary>時間帯ごとに 3 か所ずつ選んでいます。降水確率50%以上の時間は屋内のスポットです。夜は夜景や夜も遊べる所です（天気: Open-Meteo）。「🔄ほかの提案」で選び直せます。</details></div>`;
}

// ---- 天気（Open-Meteo, 登録不要） ----
async function loadWeather() {
  const o = DATA.cfg.origin, { lat, lon } = o, at = `${lat},${lon}`;
  const btn = $('#weather');
  const [sat, sun] = Lib.weekend(new Date());
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=precipitation_probability_max&timezone=Asia%2FTokyo&forecast_days=10`,
      { signal: timeoutSignal(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (DATA.cfg.origin !== o) return; // 取得中に起点を変えた
    const pick = (d) => j.daily.precipitation_probability_max[j.daily.time.indexOf(d)];
    const ps = [['土', pick(sat)], ['日', pick(sun)]].filter(([, p]) => p != null);
    state.weatherRainy = ps.some(([, p]) => p >= DATA.cfg.rainThreshold);
    btn.dataset.text = ps.map(([d, p]) => `${d}${p >= DATA.cfg.rainThreshold ? '☔' : '☀'}${p}%`).join(' ');
    store.set('weather', { text: btn.dataset.text, rainy: state.weatherRainy, sat, at });
  } catch {
    if (DATA.cfg.origin !== o) return;
    // 同じ週末・同じ起点の予報を前に取れていれば、それを「前回取得」として出す
    const w = store.get('weather');
    // 起点を覚える前の保存分（at なし）は既定の起点（調布）のもの
    if (w && w.sat === sat && (w.at ? w.at === at : !store.get('origin'))) { state.weatherRainy = w.rainy; btn.dataset.text = `${w.text}（前回取得）`; } else btn.dataset.text = '天気を取得できません';
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
function dataTotalsHtml() {
  const sum = (g) => (cellIndex && cellIndex[g] ? Object.values(cellIndex[g]).reduce((a, b) => a + b, 0) : 0);
  const rows = [['厳選スポット（工場見学・体験・季節の見頃など）', DATA.spots.length], ['観光スポット（博物館・寺社・温泉・体験など）', DATA.osm.length],
    ['立ち寄り候補（道の駅・温泉・展望台・滝など）', DATA.pois.filter((p) => p.kind !== 'fuel24').length], ['⛽24時間営業のガソリンスタンド', DATA.pois.filter((p) => p.kind === 'fuel24').length], ['🍴グルメ', sum('food')], ['🏯史跡・🏨宿', sum('heritage')], ['🛍お土産・⚽遊び・キャンプ', sum('local')],
    ['ドライブコース（厳選＋自動収集）', DATA.roads.length + DATA.courses.length], ['峠', DATA.passes.length]];
  const total = rows.slice(0, 6).reduce((a, [, n]) => a + n, 0);
  return `<p class="status">スポット 合計 <strong>約${total.toLocaleString()}件</strong>（起点から約${DATA.cfg.poiRadiusKm}km圏）＋ネットの施設検索 OpenPOI（全国 約337万件）</p>
    <ul class="rel">${rows.map(([k, n]) => `<li>${k}：${n.toLocaleString()}</li>`).join('')}</ul>
    <details class="help"><summary aria-label="説明を見る">i</summary>一覧の件数（絞り込みの横の数字）は、移動手段・時間・種類などの条件に合う件数です。グルメなどは「種類」で選んだときだけ、起点から${CELL_KM_MAX}km以内を表示します。</details>`;
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
    ${Lib.haversineKm(DATA.cfg.origin, CFG_ORIGIN || DATA.cfg.origin) > 100 ? '<p class="hint">イベントは今のところ、調布のまわりの自治体などの情報だけです（スポット・グルメ・ツーリングは全国で使えます）。</p>' : ''}
    ${hidden || state.showNotices ? `<button type="button" class="btn" id="notices">${state.showNotices ? '募集・講座などの告知を隠す' : `募集・講座などの告知${hidden}件を非表示中（表示する）`}</button>` : ''}
    ${list.length ? list.slice(0, 300).map((e) => eventCard(e, from)).join('')
      : `<p class="empty">${evFailed ? 'イベントのデータを読み込めませんでした。電波の良い場所で開き直してください。' : 'この期間・条件のイベントはありません。'}</p>`}
    ${statusHtml()}`;
  chips($('#periods'), PERIODS, (v) => v === state.period, (v) => { state.period = v; });
  const nb = $('#notices'); if (nb) nb.onclick = () => { buzz(); state.showNotices = !state.showNotices; renderEvents(); };
}

// ---- データ更新の依頼（方式 C：古いときだけ GitHub Actions を起動。トークンは端末内のみ） ----
function setUpdateMsg(text) { const el = $('#update-msg'); el.hidden = !text; el.textContent = text || ''; }
// ---- データの更新: トークンを登録した端末は、アプリを開いたときに自動で GitHub Actions に収集を依頼し、終わるまで見守る ----
const ghRepo = () => {
  const { workflow, branch } = DATA.cfg.github;
  return { owner: DATA.cfg.github.owner || location.hostname.split('.')[0], repo: DATA.cfg.github.repo || location.pathname.split('/')[1], workflow, branch: branch || 'main' };
};
async function gh(path, token, init = {}) {
  const { owner, repo } = ghRepo();
  return fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, { ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', ...(init.headers || {}) }, signal: timeoutSignal(15000) });
}
const UPD = { watching: false, state: null, msg: '' };
async function latestRun(token) {
  const r = await gh(`/actions/workflows/${ghRepo().workflow}/runs?per_page=1`, token);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Lib.runState(await r.json());
}
// 依頼が必要か: データが古い（staleHours）か、前回の収集で取れなかった種類が残っていて前回の依頼から 3 時間以上たった
function needsUpdate() {
  const st = DATA.status;
  if (Lib.isStale(st && st.updated_at, Date.now(), DATA.cfg.staleHours)) return true;
  return Lib.pendingParts(st).length > 0 && Date.now() - (store.get('lastDispatch') || 0) > 3 * 3600e3;
}
async function requestUpdate(force = false) {
  const token = store.get('token');
  if (!token) return; // トークンのない端末（家族など）には何も出さない
  try {
    const run = await latestRun(token);
    if (run.state === 'running' || run.state === 'queued') { watchUpdate(); return; } // すでに収集中
    if (!force && !needsUpdate()) return;
    const { workflow, branch } = ghRepo();
    const r = await gh(`/actions/workflows/${workflow}/dispatches`, token, { method: 'POST', body: JSON.stringify({ ref: branch }) });
    if (!r.ok) { setUpdateMsg(`更新の依頼に失敗しました（${r.status}）。設定タブの「データの更新」でトークンを確認してください。`); return; }
    store.set('lastDispatch', Date.now());
    watchUpdate();
  } catch {
    if (force) setUpdateMsg('更新の依頼を送れませんでした（通信エラー）。');
  }
}
// 収集が終わるまで 1 分ごとに様子を見る（アプリを開いている間だけ）。終わったら新しいデータを読み直す
async function watchUpdate() {
  if (UPD.watching) return;
  UPD.watching = true;
  const token = store.get('token'), prev = DATA.status && DATA.status.updated_at;
  for (let i = 0; i < 200; i++) {
    let run = null;
    try { run = await latestRun(token); } catch { /* 通信が戻るまで待つ */ }
    if (run && (run.state === 'running' || run.state === 'queued')) {
      UPD.state = run;
      setUpdateMsg(run.state === 'queued' ? '🔄 データの更新を待っています…' : `🔄 データを更新中です（開始から${run.startedMin}分・ふだん1〜2時間）。そのまま使えます。`);
      if (state.tab === 'settings') renderSettings();
    } else if (run) {
      UPD.state = run;
      const st = await getJSON('data/status.json', null, 'no-store');
      if (st && st.updated_at && st.updated_at !== prev) { await reloadData(st); break; }
      if (run.state === 'failed') { setUpdateMsg('⚠ データの更新に失敗しました。時間をおいて設定タブの「今すぐ更新」を押してください。'); break; }
      setUpdateMsg('🔄 新しいデータを公開しています…（数分）'); // 収集は終わり、公開ページの作り直し待ち
    }
    await new Promise((ok) => setTimeout(ok, 60e3));
  }
  UPD.watching = false;
  if (state.tab === 'settings') renderSettings();
}
async function reloadData(st) {
  DATA.status = st;
  DATA.events = await getJSON('data/events.json', DATA.events);
  areaIndexP = null; // 地方ごとのデータの目録も読み直す
  await reloadArea(true);
  cellIndex = await getJSON('data/cells/index.json', cellIndex);
  CELL_DATA.clear(); MOTO = null; PARK.clear();
  DATA.ver++; tour.stops = null;
  const left = Lib.pendingParts(st);
  setUpdateMsg(left.length ? `✓ データを更新しました（${left.map((k) => Lib.COLLECT_PARTS[k]).join('・')}は時間切れのため、次に開いたときに続きを集めます）` : '✓ データを更新しました');
  setTimeout(() => setUpdateMsg(''), 8000);
  renderAll();
}
// 設定タブ: 更新の状況とトークンの登録
function updateHtml() {
  const st = DATA.status, has = !!store.get('token'), left = Lib.pendingParts(st);
  const when = st && st.updated_at ? st.updated_at.slice(0, 16).replace('T', ' ') : '未取得';
  const run = UPD.state;
  return `<h2>データの更新</h2>
    <p class="status">最終更新：${esc(when)}${left.length ? `／前回取れなかった種類：${left.map((k) => Lib.COLLECT_PARTS[k]).join('・')}` : ''}</p>
    ${run && (run.state === 'running' || run.state === 'queued') ? `<p class="notice">🔄 更新中（開始から${run.startedMin || 0}分・ふだん1〜2時間）。終わると自動で新しいデータに切り替わります。</p>` : ''}
    ${has ? `<p class="status">✓ トークン登録済み：アプリを開いたとき、データが${DATA.cfg.staleHours}時間より古いか、前回取れなかった種類があれば自動で更新を頼みます。GitHub での操作は不要です。</p>`
      : `<details class="help"><summary aria-label="説明を見る">i</summary>トークンを一度登録すると、<strong>アプリを開くだけで自動で更新</strong>されます（GitHub に行く必要がなくなります）。家族の端末には不要です。</details>`}
    <div class="actions"><button type="button" class="btn primary" id="update-now" ${has ? '' : 'disabled'}>今すぐ更新</button>
      ${has ? '<button type="button" class="btn" id="token-check">トークンを確認</button><button type="button" class="btn" id="token-del">トークンを削除</button>' : ''}</div>
    <p class="status" id="token-msg"></p>
    <details ${has ? '' : 'open'}><summary>トークンの登録（最初の 1 回だけ）</summary><ol class="hint">
      <li><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub のトークン作成ページ</a>を開く（GitHub にログイン）</li>
      <li>Token name に「MyMap」、Expiration は「366 days」など長めに</li>
      <li>Repository access を「Only select repositories」にして、<strong>${esc(ghRepo().repo)}</strong> を選ぶ</li>
      <li>Permissions の「Repository permissions」→ <strong>Actions を「Read and write」</strong>（ほかは変えない）</li>
      <li>「Generate token」を押し、表示された <code>github_pat_…</code> をコピーして下に貼り、「登録」</li></ol>
      <input id="token" type="password" autocomplete="off" placeholder="github_pat_..." aria-label="GitHub トークン">
      <div class="actions"><button type="button" class="btn primary" id="token-save">登録</button></div>
      <details class="help"><summary aria-label="説明を見る">i</summary>トークンはこの端末の中にだけ保存され、GitHub への更新の依頼にだけ使います。期限が切れたら同じ手順で作り直してください。</details></details>`;
}
function bindUpdate() {
  const msg = (t) => { const m = $('#token-msg'); if (m) m.textContent = t; };
  $('#token-save').onclick = async () => {
    const v = $('#token').value.trim(); if (!v) return;
    msg('確認しています…');
    try {
      const r = await gh(`/actions/workflows/${ghRepo().workflow}/runs?per_page=1`, v);
      if (!r.ok) { msg(`このトークンでは使えません（${r.status}）。リポジトリの選択と Actions の権限を確認してください。`); return; }
      store.set('token', v); buzz(); renderSettings(); msg('✓ 登録しました。必要なときは自動で更新を頼みます。');
      requestUpdate();
    } catch { msg('確認できませんでした（通信エラー）。'); }
  };
  const ck = $('#token-check'); if (ck) ck.onclick = async () => {
    msg('確認しています…');
    try { const run = await latestRun(store.get('token')); msg(`✓ 使えます（前回の収集：${({ done: '成功', failed: '失敗', running: '実行中', queued: '待ち' })[run.state] || 'なし'}）`); }
    catch (e) { msg(`使えません（${e.message}）。期限切れなら作り直してください。`); }
  };
  const del = $('#token-del'); if (del) del.onclick = () => { if (confirm('トークンを削除しますか？（自動の更新が止まります）')) { store.set('token', null); renderSettings(); } };
  $('#update-now').onclick = () => { buzz(); requestUpdate(true); };
}

// ---- ツーリング（ルート：Valhalla・OSRM の公開サーバー／地図：OSM。どれも登録不要） ----
const savedTour = store.get('tour') || {};
const tour = { destId: savedTour.destId || null, custom: savedTour.custom || null, roadId: savedTour.roadId || null,
  opts: { noToll: false, fewHighways: !!savedTour.avoid, bike: false, ...(savedTour.opts || {}) }, radius: savedTour.radius || 3,
  cands: savedTour.cands || (savedTour.route ? [{ ...savedTour.route, label: 'ルート' }] : null), sel: savedTour.sel || 0,
  picked: new Set(savedTour.picked || []), kept: savedTour.kept || savedTour.meals || [], foodCat: '', stopsAll: false, error: '', busy: false, awake: store.get('awake') !== false, stops: null, key: '',
  showCourses: store.get('showCourses') === true, depart: savedTour.depart || '', rainAt: savedTour.rainAt || 0, rainMsg: '', rainBusy: false };
tour.restored = !!tour.cands;
Object.defineProperty(tour, 'route', { get: () => (tour.cands && tour.cands[tour.sel]) || null });
let map = null, markers = new Map();
// 地図を作り直した直後、片づけたキャンバスへ Leaflet の描画が 1 回届いてエラーになる（Leaflet 1.9 の既知の癖）。キャンバスが無ければ描かない
if (typeof L !== 'undefined' && L.Canvas) { const redraw = L.Canvas.prototype._redraw; L.Canvas.prototype._redraw = function () { if (this._ctx) redraw.call(this); }; }
// 同じく、ズームの途中で地図を片づけると、ズームの続きの処理が消えた地図に届いてエラーになる。片づけた後は位置を 0 として扱う
if (typeof L !== 'undefined' && L.Map) { const pos = L.Map.prototype._getMapPanePos; L.Map.prototype._getMapPanePos = function () { return this._mapPane ? pos.call(this) : L.point(0, 0); }; }
// ホイールでの拡大縮小は少し遅れて実行されるので、その間に地図を片づけると、消えた地図の表示位置を直そうとしてエラーになる。片づけた後は何もしない
if (typeof L !== 'undefined' && L.Map) { const rv = L.Map.prototype._resetView; L.Map.prototype._resetView = function (...a) { return this._mapPane ? rv.apply(this, a) : this; }; }
const saveTour = () => store.set('tour', { destId: tour.destId, custom: tour.custom, roadId: tour.roadId, opts: tour.opts, radius: tour.radius,
  cands: tour.cands, sel: tour.sel, picked: [...tour.picked], depart: tour.depart, kept: tour.kept.filter((m) => tour.picked.has(m.id)), rainAt: tour.rainAt || 0 });
const keyColor = () => getComputedStyle(document.documentElement).getPropertyValue('--key').trim() || '#0017c1';
const fail = (msg) => Object.assign(new Error(msg), { mine: true });
// 自分で登録したルート（Google マップの経路リンクから。端末の中にだけ保存）
const myRoutes = () => store.get('myRoutes') || [];
const roadById1 = (id) => DATA.roads.find((r) => r.id === id) || DATA.courses.find((r) => r.id === id) || null;
// 'chain:a+b+c' は複数のコースを続けて走る（Lib.chainRoad）
// 'sx:区間+区間' は首都高の区間（data/shutoko_net.json）を選んでつないだルート。案内点は各区間の正しい車線の上の点
const sxSeg = (id) => (DATA.sx && DATA.sx.segs.find((s) => s.id === id)) || null;
const sxNode = (k) => DATA.sx.nodes[k].name;
const sxName = (s) => `${s.route}（${sxNode(s.from)}→${sxNode(s.to)}）`;
function sxRoad(id) {
  const segs = id.slice(3).split('+').map(sxSeg);
  if (!segs.length || segs.some((s) => !s)) return null;
  const via = [segs[0].from, ...segs.map((s) => s.to)].map((k) => sxNode(k).replace(/JCT$/, ''));
  return { id, name: `首都高 組み立てルート（${via.join('→')}）`, hw: segs.map((s) => s.pin), points: segs.map((s) => [s.pin[0], s.pin[1]]),
    toll: true, fee: '', note: `首都高の区間を選んでつないだルート：${segs.map(sxName).join('、')}`, tags: [], closed: '', closedMonths: [] };
}
const roadById = (id) => {
  if (String(id).startsWith('sx:')) return sxRoad(id);
  if (!String(id).startsWith('chain:')) return roadById1(id);
  const [ids, mode] = id.slice(6).split('@');
  const parts = ids.split('+').map(roadById1).filter(Boolean);
  if (!parts.length) return null;
  const r = Lib.chainRoad(parts, mode || 'seq'), n = (store.get('savedChains') || []).find((c) => c.id === id);
  return n ? { ...r, name: n.name } : r;
};
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
  // フェリーは使わない（海の上の点をフェリー航路に合わせて、遠くまで渡るルートになるのを防ぐ）
  const co = { use_tolls: opts.noToll ? 0 : 0.5, use_highways: opts.fewHighways ? 0 : 1, use_ferry: 0, ...(opts.bike ? { use_trails: 0.8 } : {}) };
  const body = { locations: points.map((p, i) => ({ lat: p.lat, lon: p.lon, type: i === 0 || i === points.length - 1 ? 'break' : 'through',
    ...(p.hw ? { search_filter: { min_road_class: 'motorway' }, radius: 300 } : {}), ...(p.heading != null ? { heading: p.heading, heading_tolerance: 60 } : {}) })),
    costing, costing_options: { [costing]: co }, units: 'kilometers', language: 'ja-JP', ...(alternates ? { alternates } : {}) };
  const jcts = await jctList();
  const r = await getRoute('https://valhalla1.openstreetmap.de/route', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  if (r.status === 429) throw fail('ルートサーバーが混雑しています。少し待ってから再検索してください。');
  if (r.status >= 500) throw fail(`ルートサーバーが一時的に使えません（${r.status}）。`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.trip) throw fail('この地点までのルートが見つかりませんでした。');
  const toRoute = (trip) => ({
    line: trip.legs.flatMap((leg, i) => Lib.decodePolyline(leg.shape, 6).slice(i ? 1 : 0)),
    km: trip.summary.length, min: trip.summary.time / 60, toll: !!trip.summary.has_toll, highway: !!trip.summary.has_highway, engine: 'Valhalla',
    tollKm: Math.round(Lib.tollKmOf(trip.legs) * 10) / 10, guide: Lib.jctGuide(trip.legs, jcts), tollSpans: Lib.tollSpans(trip.legs) });
  return [toRoute(j.trip), ...(j.alternates || []).map((a) => toRoute(a.trip))];
}

// JCT の名前（OpenStreetMap。分岐の案内に付ける）
let JCTS = null;
async function jctList() {
  if (!JCTS) {
    // 手で集めた関東の分＋全国の収集（起点から poiRadiusKm 以内）
    const seq = areaSeq;
    const [own, area] = await Promise.all([getJSON('data/jct.json', []), loadArea('jct').catch(() => [])]);
    FAILED.delete('data/jct.json');
    const all = own.concat(area.map((x) => [x.name, x.lat, x.lon]));
    if (seq !== areaSeq) return all;
    JCTS = all;
  }
  return JCTS;
}
// Google マップに渡す「迷わない」地点: ルートの上で、半径 12m 以内が高速道路の本線だけの所（下や横の一般道・ランプに吸い寄せられない）
async function safePins(line, road, k) {
  const pts = road.hw || road.points, lat = pts.map((p) => p[0]), lon = pts.map((p) => p[1]);
  const box = [Math.min(...lat) - 0.01, Math.min(...lon) - 0.01, Math.max(...lat) + 0.01, Math.max(...lon) + 0.01];
  const cand = Lib.samplesIn(line, box, 120);
  if (!cand.length) return [];
  try {
    const r = await fetch('https://valhalla1.openstreetmap.de/locate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: timeoutSignal(15000),
      body: JSON.stringify({ locations: cand.map((p) => ({ lat: p.lat, lon: p.lon, radius: 60 })), costing: 'auto', verbose: true }) });
    const j = r.ok ? await r.json() : [];
    const near = (es) => (es || []).filter((e) => (e.distance || 0) <= 12);
    const ok = cand.map((p, i) => ({ p, es: Array.isArray(j) && j[i] ? j[i].edges : null })).filter((x) => x.es && Lib.safeSpot(near(x.es), x.p.heading));
    // 出入口のランプの横は避ける。避けると 2 点も残らない道（一般道と並ぶ湾岸線など）は、これまでどおり本線の上の点を使う
    // 地上の道の下を通るトンネル（山手トンネルなど）の中も避ける。Google マップは経由地を上の一般道に合わせることがある
    const strict = ok.filter((x) => Lib.rampFree(x.es, x.p.heading)
      && !(x.es.some((e) => (e.distance || 0) <= 12 && e.edge.tunnel) && x.es.some((e) => e.edge.classification.classification !== 'motorway')));
    // コースの最初から最後まで均等に（候補の並び順ではなく、走る距離で間をあける。抜けた区間は Google マップが近道を選ぶ）
    return Lib.spreadAlong((strict.length >= 2 ? strict : ok).map((x) => x.p), k).map((p) => ({ lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) }));
  } catch { return []; }
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

// 高速道路のコースの案内用の点（一周するコースでも始点には戻らない）
const hwFix = (road) => Lib.coursePoints(road).slice(0, MAX_WAYPOINTS - 2).map(({ lat, lon }) => ({ lat, lon }));

// 1 回の検索で候補を最大 5 本作る: 標準（＋別ルート）、コースの経由地なし、おすすめの道を寄り道として通すもの
// 外周: 各コースの線を引いて、重なる道にある案内用の点を外し、残りの点を外周の順に並べる（Lib.outerFromPoints）
async function outerPoints(road) {
  const lines = [], parts = [];
  for (const p of road.parts) {
    const pts = Lib.coursePoints(p, true);
    if (pts.length < 2) continue;
    const [rt] = await valhalla(pts, tour.opts, 0);
    lines.push(rt.line.filter((q, i) => i % 3 === 0 || i === rt.line.length - 1)); // 計算を軽く
    parts.push(Lib.coursePoints(p));
    await new Promise((ok) => setTimeout(ok, 800));
  }
  const pts = Lib.outerFromPoints(parts, lines, road.mode, DATA.cfg.origin);
  if (!pts) throw fail('このコースどうしは重なっていないため、外周を作れませんでした。「順に1本ずつ一周」で探してください。');
  return pts.slice(0, 8).map((p) => ({ ...p, ...(Array.isArray(road.hw) ? { hw: true } : {}) }));
}
async function fetchCandidates(dest) {
  const o = DATA.cfg.origin, optsKey = JSON.stringify(tour.opts);
  if (dest.loop && dest.road.parts && dest.road.mode !== 'seq' && !dest.road.outerPts) dest.road.outerPts = await outerPoints(dest.road);
  const course = (dest.waypoints || []).map(([lat, lon]) => ({ lat, lon }));
  const main = dest.loop ? Lib.loopPoints(o, dest.road) : [o, ...course, dest];
  const baseFix = dest.loop ? (dest.road.parts ? fixedWaypointsFor(dest) : roadFix(dest.road.points)) : course;
  const pause = () => new Promise((ok) => setTimeout(ok, 800)); // 公開サーバーへの配慮
  const out = [];
  let note = '';
  try {
    const std = await valhalla(main, tour.opts, main.length === 2 ? 2 : 0);
    const baseLabel = dest.loop ? `${dest.road.name}を周回` : dest.mine ? '登録したルート' : course.length ? 'おすすめのコース' : '標準';
    std.forEach((rt, i) => out.push({ ...rt, label: i ? `別ルート${i}` : baseLabel, via: dest.loop ? [dest.road.id] : [], fixed: i ? [] : baseFix }));
    if (dest.loop && Array.isArray(dest.road.hw) && out[0]) {
      // Google マップで実際に経路を開いて、途中で高速を降りないと確かめた経由地があればそれを使う（data の gpins）
      const pins = dest.road.gpins ? dest.road.gpins.map(([lat, lon]) => ({ lat, lon })) : await safePins(out[0].line, dest.road, MAX_WAYPOINTS - 2);
      out[0].fixed = pins.length >= 3 || dest.road.gpins ? pins : hwFix(dest.road);
      out[0].hwPins = pins.length;
      out[0].gVerified = !!dest.road.gpins;
      // Google マップに渡す地点だけで引いた距離（Google マップの表示と比べる目安）
      try { await pause(); out[0].gmKm = (await valhalla([o, ...out[0].fixed, o], tour.opts, 0))[0].km; } catch { /* なければルートの距離で */ }
    }
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
  return tour.custom || DATA.touring.concat(myRoutes()).find((t) => t.id === tour.destId) || null;
};
// Google マップへ渡す経由地のうち、決まって使うもの（コースの経由地・周回する道の入口と出口）
function fixedWaypoints() {
  const dest = currentDest(); if (!dest) return [];
  if (tour.route && tour.route.fixed) return tour.route.fixed; // 選んだ候補が通る道・コース
  if (dest.loop && dest.road.parts && !Array.isArray(dest.road.hw)) return Lib.spreadPick(dest.road.parts.flatMap((p) => roadFix(p.points)), MAX_WAYPOINTS - 2);
  if (dest.loop) return Array.isArray(dest.road.hw) ? hwFix(dest.road) : roadFix(dest.road.points);
  return (dest.waypoints || []).map(([lat, lon]) => ({ lat, lon }));
}
function fixedWaypointsFor(dest) {
  if (dest.road.outerPts) return dest.road.outerPts.slice(0, MAX_WAYPOINTS - 2).map(({ lat, lon }) => ({ lat, lon })); // 外周
  if (dest.road.parts && !Array.isArray(dest.road.hw)) return Lib.spreadPick(dest.road.parts.flatMap((p) => roadFix(p.points)), MAX_WAYPOINTS - 2);
  return Array.isArray(dest.road.hw) ? hwFix(dest.road) : roadFix(dest.road.points);
}
// 候補を作ったあとで走り方を変えたか
const routeStale = () => !!(tour.route && tour.route.opts && tour.route.opts !== JSON.stringify(tour.opts));
// 立ち寄りの上限。コースを固定する点と合わせて Google マップの 9 件を超える分は、ナビを立ち寄りの所で区切って複数のリンクにする
const MAX_STOPS = 10;
const room = () => MAX_STOPS;
// 営業時間が登録されている所は、着く時刻に開いているか（出発時刻とルートの所要時間から、進んだ距離の割合で見積もる）
function arriveOpen(s) {
  if (!s.oh || !tour.route) return '';
  const rt = tour.route, at = departMs() + rt.min * 60e3 * Math.min(1, s.alongKm / (rt.km || 1));
  const open = Lib.openState(s.oh, new Date(at));
  return open === true ? ' <span class="badge open">着く頃は営業中</span>' : open === false ? ' <span class="badge closed">着く頃は営業時間外</span>' : '';
}
// 立ち寄り候補の種類 [キー, 表示名, ふだん出すか]。カフェ・ごはん・GS は、寄るなら道のすぐ近くなのでルートから 1km 以内
const STOP_KINDS = [['pick', '★厳選', true], ['michi', '🚏道の駅', true], ['onsen', '♨温泉', true], ['view', '🔭展望・絶景', true],
  ['sight', '🏛観光名所', false], ['cafe', '☕カフェ', false], ['food', '🍴ごはん', false], ['fuel', '⛽24時間GS', false]];
const MANY_KINDS = new Set(['sight', 'cafe', 'food']); // 件数が多いので、一覧ではルート全体から均等に選んで出す
const stopKinds = () => new Set(store.get('stopKinds') || STOP_KINDS.filter((k) => k[2]).map((k) => k[0]));
function stopKindOf(s) {
  if (s.poi) return { michinoeki: 'michi', onsen: 'onsen', fuel24: 'fuel' }[s.kind] || 'view';
  if (s.g === 'food') return s.k === 'cafe' || s.k === 'sweets' ? 'cafe' : 'food';
  if (isCurated(s)) return 'pick';
  const g = s.genres || [];
  return g.includes('onsen') ? 'onsen' : g.some((x) => x === 'scenic' || x === 'viewpoint' || x === 'nightview') ? 'view' : 'sight';
}
function getStops() {
  if (!tour.route) return [];
  if (!tour.stops) {
    const kinds = stopKinds(), line = tour.route.line;
    const want = (s) => kinds.has(stopKindOf(s)) || tour.picked.has(s.id); // 選んだ立ち寄りは、その種類を外しても残す
    // 山頂は車・バイクで寄れないことが多いので除く
    const wide = DATA.spots.concat(DATA.osm, poiSpotList().filter((p) => p.kind !== 'peak')).filter(want);
    let near = DATA.pois.filter((p) => p.kind === 'fuel24').map(poiAsSpot);
    if (kinds.has('cafe') || kinds.has('food')) {
      const cids = routeCells(line, 1);
      near = near.concat(cellItemsIn(['food'], cids).filter((s) => !s.chain));
      loadStopCells(cids);
    }
    // 選んだカフェ・ごはん（升目のデータ）は、読み込む前や種類を外したときのために控えも使う
    near = near.concat(tour.kept).filter(want);
    if (tour.foodCat) near = near.filter((s) => stopKindOf(s) !== 'food' || Lib.inFoodCat(s, tour.foodCat) || tour.picked.has(s.id));
    // 同じ場所が厳選・OpenStreetMap・展望台の一覧などに重なって入っていることがあるので、名前と位置（約100m）が同じものは 1 件に
    const seen = new Set(), dup = (s) => [s.id, `${s.name}|${s.lat.toFixed(3)}|${s.lon.toFixed(3)}`].some((k) => seen.has(k) || !seen.add(k));
    tour.stops = Lib.stopsAlongRoute(wide, line, tour.radius).concat(Lib.stopsAlongRoute(near, line, Math.min(1, tour.radius)))
      .sort((a, b) => a.alongKm - b.alongKm)
      .filter((s) => s.alongKm > 1 && !dup(s));
  }
  return tour.stops;
}
// ルート沿いの飲食の升目を読み込み、そろったら立ち寄り候補を作り直す
// （同じ升目を何度も読みに行かないのは ensureCellIds が防ぐ。読み込み中に別のタブへ移ったりルート候補を替えたりしても、
// そのルートのまま読み終わったら候補を作り直す。タブが違えば、戻ったときに作り直した一覧が出る）
function loadStopCells(cids) {
  const rt = tour.route;
  ensureCellIds(['food'], cids).then((changed) => {
    if (!changed || tour.route !== rt) return;
    tour.stops = null; tour.key = '';
    if (state.tab === 'touring') renderTouring();
  });
}
// 一覧と地図に出す分。選んだものは全部、ほかは種類ごとに上限まで、ルート全体から均等に選ぶ
// （出発地の近くだけで埋まらないように。カフェ・ごはんを足しても、道の駅などに枠を取られて出ないことがないように）
const STOP_SHOW = 100, MANY_SHOW = 30;
// 街なかの銭湯（OpenStreetMap で温泉の印がない入浴施設）・サウナ・温泉宿（日帰り入浴できるか分からない）。大阪・東京・箱根などの
// ルートでは何十件も並び、道の駅や展望を押し出すので別枠にする（温泉の印がある所・温泉地・★は今までどおり）
const MINOR_BATHS = new Set(['銭湯・入浴施設', '入浴施設（サウナ）', '温泉宿（日帰り入浴は要確認）']);
const isSento = (s) => MINOR_BATHS.has(s.note);
const SENTO_SHOW = 10;
function shownStops() {
  const all = getStops(), k = tour.stopsAll ? 5 : 1;
  const spread = (xs, n) => (xs.length <= n ? xs : Lib.spreadAlong(xs.map((s) => ({ ...s, along: s.alongKm })), n));
  const out = all.filter((s) => tour.picked.has(s.id)), rest = all.filter((s) => !tour.picked.has(s.id));
  out.push(...spread(rest.filter((s) => !MANY_KINDS.has(stopKindOf(s)) && !isSento(s)), STOP_SHOW * k));
  out.push(...spread(rest.filter(isSento), SENTO_SHOW * k));
  for (const kind of MANY_KINDS) out.push(...spread(rest.filter((s) => stopKindOf(s) === kind), MANY_SHOW * k));
  return out.sort((a, b) => a.alongKm - b.alongKm);
}
// Google マップへ渡すナビのリンク。経由地（コースを固定する点＋立ち寄り）が 9 件を超えるときは、立ち寄りの所で区切って複数にする
function navLegs() {
  const dest = currentDest(), line = tour.route.line;
  // 並べる順はすべて同じ物差し（distToRoute の進行距離）で測る
  const along = (p) => Lib.distToRoute(p, line).along;
  const picked = getStops().filter((s) => tour.picked.has(s.id)).slice(0, room()).map((s) => ({ ...s, along: s.alongKm, stop: true }));
  const fixed = fixedWaypoints().map((p) => ({ ...p, along: along(p) }));
  // 残りの枠でルート上の地点を等間隔に足し、Google マップが別の道（有料道路など）を選ばないようにする。
  // 走り方を変えた後は古いルートに沿わせない
  const spare = MAX_WAYPOINTS - fixed.length - picked.length;
  const pins = routeStale() || (dest.loop && Array.isArray(dest.road.hw)) || spare <= 0 ? [] : Lib.pinWaypoints(line, Math.min(4, spare)).map((p) => ({ ...p, along: along(p) }));
  const wps = [...fixed, ...picked, ...pins].sort((a, b) => a.along - b.along);
  const end = dest.loop ? DATA.cfg.origin : dest;
  let from = DATA.cfg.origin;
  return Lib.splitLegs(wps, MAX_WAYPOINTS).map((leg) => {
    const to = leg.end || end;
    const out = { url: Lib.gmapsDirUrl(from, to, leg.waypoints, 'driving'), to: leg.end ? leg.end.name || '次の地点' : dest.loop ? esc(DATA.cfg.origin.name) + 'へ帰る' : dest.name };
    from = to;
    return out;
  });
}
const navUrl = () => navLegs()[0].url;
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
    const waiting = tour.route && (!DATA.eventsLoaded || !DATA.osmLoaded); // 道の駅・観光名所などの読み込み前に押すと経由地が抜けるため
    const d = currentDest();
    const legs = tour.route && !waiting ? navLegs() : null;
    nav.href = waiting ? '#' : legs ? legs[0].url
      : Lib.gmapsDirUrl(DATA.cfg.origin, d.loop ? DATA.cfg.origin : d, fixedWaypoints(), 'driving'); // ルート未検索でも周回・コースの道を渡す
    nav.textContent = waiting ? '立ち寄り候補を読み込み中…' : legs && legs.length > 1 ? `ナビ開始 1/${legs.length}（${legs[0].to}まで）` : `ナビ開始（立ち寄り ${n}/${room()}）`;
    nav.toggleAttribute('aria-disabled', !!waiting);
    // 2 つ目以降のナビ（前のナビの目的地＝立ち寄り先に着いたら開く）
    const more = $('#nav-legs');
    if (more) {
      more.hidden = !(legs && legs.length > 1);
      more.innerHTML = legs && legs.length > 1 ? `<p class="notice">経由地が 9 件を超えるため、ナビを ${legs.length} つに分けています。立ち寄り先に着いたら次のナビを開いてください。</p>`
        + legs.slice(1).map((l, i) => `<a class="btn" target="_blank" rel="noopener" href="${esc(l.url)}">ナビ ${i + 2}/${legs.length}（${esc(legs[i].to)} → ${esc(l.to)}）</a>`).join('') : '';
    }
  }
  const lim = $('#limit-msg'); if (lim) lim.hidden = !full;
  const sp = $('#stops-picked'); if (sp) sp.textContent = n ? `・${n}件選択中` : '';
  styleMarkers();
}
function styleMarkers() {
  let i = 0;
  for (const s of getStops()) {
    const m = markers.get(s.id); if (!m) continue;
    const on = tour.picked.has(s.id);
    if (on) { i++; m.pinOpts = [s, { top: false, picked: true, num: i }]; m.setZIndexOffset(1000); }
    else { m.pinOpts = [s, { top: false }]; m.setZIndexOffset(0); }
    // 選んだ立ち寄りはほかのアイコンより上に
    const pane = on ? 'pickPane' : 'markerPane';
    if (m.options.pane !== pane && m._map && m._map.getPane('pickPane')) { const mm = m._map; m.remove(); m.options.pane = pane; m.addTo(mm); }
  }
  layoutPins();
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
    ・カーブ ${'★'.repeat(curvOf(c))}${'☆'.repeat(5 - curvOf(c))}</span>
  ${c.rain ? `<span class="cand-rain">${c.rainBest ? '<span class="badge open">☂雨が少ない</span> ' : ''}${rainText(c.rain)}</span>` : ''}</button>`;
const curvOf = (c) => (c.curvStars = c.curvStars || Lib.curvStars(Lib.curviness(c.line)));

// ---- 地図を全画面にして、ほかの情報は下から引き出すパネルに（Google マップのアプリのように）。上にはルートの要約 ----
const tourFull = () => store.get('tourFull') !== false;
store.set('tourFull', true); // 「通常表示に戻す」はそのときだけ。次に開いたときは全画面に戻る
// パネルの高さ。min はつまみだけ（地図をほぼ全画面で見る。雨雲を見るときなど）
const SHEET = { min: () => 34, low: () => 132, half: () => Math.round(innerHeight * 0.5), high: () => innerHeight - 64 - (document.querySelector('.tabs').offsetHeight || 56) };
const SHEET_NEXT = { min: 'low', low: 'half', half: 'high', high: 'min' };
let sheetSnap = store.get('sheetSnap') || 'half';
function setSheet(snap, px) {
  if (snap) { sheetSnap = snap; store.set('sheetSnap', snap); }
  document.documentElement.style.setProperty('--sheet-h', `${Math.round(px != null ? px : SHEET[sheetSnap]())}px`);
}
const sheetPx = () => (document.body.classList.contains('tour-full') ? SHEET[sheetSnap]() : 0);
function placeTourMap(dest) {
  const full = tourFull() && state.tab === 'touring';
  document.body.classList.toggle('tour-full', full);
  if (!full) document.body.classList.remove('drawer-open');
  const box = $('#map-full'), top = $('#tour-top');
  box.innerHTML = '';
  document.querySelectorAll('body > .tour-drawer').forEach((e) => e.remove()); // 前に描いた分
  top.hidden = !full;
  if (!full) return;
  box.appendChild($('#view .map-wrap'));
  // 設定のパネルは下のパネルの外へ（中に置くと iPhone では下のパネルの枠の中しか見えない）
  document.body.appendChild($('#view #tour-drawer'));
  setSheet(null);
  $('#view').insertAdjacentHTML('afterbegin', '<div class="sheet-handle" role="button" tabindex="0" aria-label="パネルの高さを変える（ドラッグか、押して切り替え）"><span></span></div>');
  const rt = tour.route;
  top.innerHTML = `<div class="tt-main"><strong>${dest ? esc(dest.loop ? dest.road.name : dest.name) : '目的地を選んでください'}</strong>
      <span>${rt ? `約${Math.round(rt.km)}km・${fmtMin(Math.round(rt.min))}${rt.toll ? '・有料あり' : ''}` : dest ? '「ルート候補を探す」で道を引きます' : '下のパネルで選ぶか、地図のコースを押す'}</span></div>
    ${rt ? '<button type="button" class="btn primary" id="tt-nav">ナビ</button>' : ''}
    <button type="button" class="icon" id="tt-menu" aria-label="走り方・立ち寄りの範囲・ドライブコースの表示" aria-expanded="${document.body.classList.contains('drawer-open')}">☰</button>`;
  if ($('#tt-nav')) $('#tt-nav').onclick = () => { buzz(); const n = $('#nav'); if (n) n.click(); };
  // ☰: 横から設定のパネル（走り方・立ち寄りの範囲・ドライブコースの表示）を出す
  const drawer = (on) => { document.body.classList.toggle('drawer-open', on); $('#tt-menu').setAttribute('aria-expanded', on); };
  $('#tt-menu').onclick = () => { buzz(); drawer(!document.body.classList.contains('drawer-open')); };
  $('#dr-close').onclick = () => { buzz(); drawer(false); };
  $('#dr-normal').onclick = () => { buzz(); drawer(false); store.set('tourFull', false); setOutdoor(!!store.get('outdoor'), false); tour.key = ''; renderTouring(); window.scrollTo(0, 0); };
  bindSheetHandle();
}
// パネルのつまみ: 上下にドラッグ（離すと近い高さに止まる）・押すと 低い → 半分 → 高い と切り替え
function bindSheetHandle() {
  const h = $('#view .sheet-handle'); if (!h) return;
  let startY = null, startH = 0, moved = false;
  h.onpointerdown = (e) => { startY = e.clientY; startH = SHEET[sheetSnap](); moved = false; h.setPointerCapture(e.pointerId); };
  h.onpointermove = (e) => {
    if (startY == null) return;
    const dy = startY - e.clientY; if (Math.abs(dy) > 6) moved = true;
    setSheet(null, Math.max(SHEET.min(), Math.min(SHEET.high(), startH + dy)));
  };
  h.onpointerup = (e) => {
    if (startY == null) return;
    const now = startH + (startY - e.clientY); startY = null;
    if (!moved) { setSheet(SHEET_NEXT[sheetSnap]); return; }
    const best = Object.keys(SHEET).sort((a, b) => Math.abs(SHEET[a]() - now) - Math.abs(SHEET[b]() - now))[0];
    setSheet(best);
  };
  h.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSheet(SHEET_NEXT[sheetSnap]); } };
}
addEventListener('resize', () => { if (document.body.classList.contains('tour-full')) setSheet(null); });
function renderTouring() {
  const dest = currentDest();
  // 保存してあったルートの目的地が、今の地方のデータにない（起点を変えた・自動で集めた道が範囲の外）ときは、ルートも出さない
  if (!dest && tour.cands && DATA.osmLoaded) { tour.cands = null; tour.stops = null; tour.picked.clear(); saveTour(); }
  const key = JSON.stringify([tour.destId, tour.custom, tour.roadId, tour.route && tour.route.at, tour.sel, tour.radius, tour.error, tour.busy, DATA.ver,
    !!DATA.touring.length, DATA.roads.length, DATA.courses.length, tour.showCourses, store.get('courseTypes'), store.get('nightRoads'), myRoutes().length, savedChains().length, tourFull(), navigator.onLine, tour.restored, tour.opts,
    store.get('stopKinds'), tour.foodCat, tour.stopsAll]);
  // 変化がなければ作り直さない（地図のズームと位置、スクロール位置を保つ）
  // （全画面では地図がパネルの外 #map-full にあるので、#map の有無ではなくパネルの中身で判断する。別のタブから戻ると空のままだった）
  if (key === tour.key && $('#view #dest') && $('#map')) { if (map) map.invalidateSize(); updateTourSelection(); return; }
  tour.key = key;
  // 地図は、入れ物（#map）を作り直す前に片づける（後から片づけると、Leaflet の描画が消えたキャンバスに届いてエラーになる）
  if (map) { try { map.remove(); } catch { /* 既に消えている */ } map = null; }
  const stops = getStops(), shown = shownStops(), kinds = stopKinds();
  const offline = navigator.onLine === false;
  const sns = dest && !tour.custom ? Lib.snsLinks({ name: dest.loop ? dest.road.name : dest.name, tags: dest.tags }) : null;
  const road = dest && dest.loop ? dest.road : null;
  const closedNow = road && (road.closedMonths || []).includes(thisMonth());
  // 近い順。厳選のコース（関東）が 150km 以内に少ないとき（全国のほかの地方）は、自動で集めた景色の道で補う
  const roadKm = (r) => Lib.haversineKm(DATA.cfg.origin, { lat: r.points[0][0], lon: r.points[0][1] });
  const byKm = (xs) => xs.map((r) => [roadKm(r), r]).sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  const nearOwn = byKm(DATA.roads).filter((r) => roadKm(r) <= 150);
  const names = new Set(nearOwn.map((r) => r.name)); // 自動で集めた道は、同じ名前の別の区間が並ばないように
  const roadsByDist = nearOwn.length >= 20 ? byKm(DATA.roads) : nearOwn.concat(byKm(DATA.courses).filter((r) => !names.has(r.name) && names.add(r.name)).slice(0, 20 - nearOwn.length));
  const viaRoads = tour.route ? (tour.route.via || []).map(roadById).filter(Boolean) : [];
  $('#view').innerHTML = `
    <label for="dest"><strong>目的地</strong></label> <details class="help"><summary aria-label="説明を見る">i</summary>目的地は、選ぶ・検索する・地図を長押し（または中央の＋を合わせて「中心を目的地に」）で指定できます。</details>
    <select id="dest"><option value="">選んでください</option>
      <optgroup label="目的地まで走る">${DATA.touring.map((t) => [Lib.haversineKm(DATA.cfg.origin, t), t]).filter(([km, t]) => t.id === tour.destId || km <= DATA.cfg.poiRadiusKm)
        .sort((a, b) => a[0] - b[0]).map(([, t]) =>
        `<option value="${esc(t.id)}" ${t.id === tour.destId && !tour.custom && !tour.roadId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</optgroup>
      ${roadsByDist.length ? `<optgroup label="おすすめの道を走る（近い20本・ほかは下の検索か地図で）">${roadsByDist.slice(0, 20).concat(
        road && !roadsByDist.slice(0, 20).includes(road) && !chainName(road.id) ? [road] : []).map((r) =>
        `<option value="road:${esc(r.id)}" ${r.id === tour.roadId ? 'selected' : ''}>${esc(r.name)}${r.toll ? '（有料）' : ''}</option>`).join('')}</optgroup>` : ''}
      ${savedChains().length ? `<optgroup label="保存したつなぎコース">${savedChains().map((c) =>
        `<option value="road:${esc(c.id)}" ${c.id === tour.roadId ? 'selected' : ''}>🔗${esc(c.name)}</option>`).join('')}</optgroup>` : ''}
      ${myRoutes().length ? `<optgroup label="登録したルート">${myRoutes().map((t) =>
        `<option value="${esc(t.id)}" ${t.id === tour.destId && !tour.custom && !tour.roadId ? 'selected' : ''}>📌${esc(t.name)}</option>`).join('')}</optgroup>` : ''}
      ${tour.custom ? `<option selected>${esc(tour.custom.name)}</option>` : ''}</select>
    <div class="dest-search"><input id="dq" type="search" enterkeyhint="search" autocomplete="off" placeholder="目的地を検索（例：じんだいじ、河口湖、箱根町）" aria-label="目的地を検索">
      <button type="button" class="btn" id="dq-go">検索</button></div>
    <div id="dq-results"></div>
    <details class="tools" id="my-route" ${store.get('myRouteOpen') ? 'open' : ''}><summary>📌Google マップのルートを登録（${myRoutes().length}件）</summary>
      <details class="help"><summary aria-label="説明を見る">i</summary>Google マップで経路（経由地つき）を作り、「共有」→「リンクをコピー」して貼り付けてください。登録したルートは上の「目的地」から選べます（この端末の中にだけ保存）。</details>
      <textarea id="mr-url" rows="2" placeholder="https://maps.app.goo.gl/… を貼り付け"></textarea>
      <input id="mr-name" type="text" placeholder="名前（空なら「出発地 → 目的地」）" aria-label="ルートの名前">
      <div class="actions"><button type="button" class="btn primary" id="mr-add">登録する</button></div>
      <p class="status" id="mr-msg"></p>
      ${myRoutes().length ? `<ul class="rel">${myRoutes().map((t) => `<li>📌${esc(t.name)}（${t.stops.length}地点）
        <button type="button" class="btn" data-mr-go="${esc(t.id)}">走る</button><button type="button" class="btn" data-mr-del="${esc(t.id)}">削除</button></li>`).join('')}</ul>` : ''}
    </details>
    <div class="actions"><button type="button" class="btn primary" id="route-go" ${dest && !tour.busy ? '' : 'disabled'}>${tour.busy ? '検索中…（候補を比べています）' : dest ? 'ルート候補を探す' : '目的地を選ぶと押せます'}</button></div>
    <div class="map-wrap"><div id="map"></div><span class="crosshair" aria-hidden="true">＋</span>
      <button type="button" class="btn map-pick" id="pick-center">中心を目的地に</button>
      <button type="button" class="btn map-radar" id="radar-toggle" aria-pressed="${RADAR.on}" title="雨雲レーダー（気象庁）">🌧雨雲</button>
      <div class="radar-bar" id="radar-bar" hidden></div>
      ${tourFull() ? '' : '<button type="button" class="btn map-full-btn" id="to-full" title="地図を全画面に">⤢ 全画面</button>'}</div>
    <div id="radar-plan" class="radar-plan">${RADAR.on ? RADAR.planHtml : ''}</div>
    <div id="course-info" class="course-info" hidden></div>
    <div id="chain-box" class="chain-box" hidden></div>
    <details class="tools" id="sx-box" ${store.get('sxOpen') ? 'open' : ''}><summary>🛣首都高ルートを組み立てる</summary><div id="sx-body"></div></details>
    ${road ? `<p class="notice">${closedNow ? '⚠ <strong>今月は通行止め・閉鎖の期間です。</strong>' : ''}${road.toll ? `有料道路（${road.fee ? esc(road.fee) : '料金は公式サイトで確認'}）。` : ''}${esc(road.note)}${road.closed ? `<br>⚠ ${esc(road.closed)}` : ''}${(road.alerts || []).map((a) => `<br>⚠ <strong>${esc(a)}</strong>`).join('')}${noBikeHtml(road)}${routeIssueHtml(road)}${road.noBike && tour.opts.bike ? '<br>⚠ <strong>「バイク向け」で探していますが、このコースはバイクでは走れません。</strong>' : ''}</p>${courseSources(road)}`
      : dest && dest.note ? `<p class="notice">⚠ ${esc(dest.note)}</p>` : ''}
    ${sns ? `<div class="actions"><a class="btn" href="${esc(sns.x)}" target="_blank" rel="noopener">#X で最新情報</a><a class="btn" href="${esc(sns.instagram)}" target="_blank" rel="noopener">#Instagram</a></div>` : ''}
    <div class="tour-drawer" id="tour-drawer">${tourFull() ? `<div class="drawer-head"><strong>表示と走り方</strong>
      <button type="button" class="btn" id="dr-normal">通常表示に戻す</button><button type="button" class="icon" id="dr-close" aria-label="閉じる">✕</button></div>` : ''}
    <details class="tools" id="tour-opts" ${tourFull() || store.get('tourOptsOpen') ? 'open' : ''}><summary>⚙走り方・立ち寄りの範囲（${optSummary()}）</summary>
    <fieldset class="opts"><legend><strong>走り方</strong></legend>
      <label class="check"><input type="checkbox" data-opt="noToll" ${tour.opts.noToll ? 'checked' : ''}>有料道路を使わない</label>
      <label class="check"><input type="checkbox" data-opt="fewHighways" ${tour.opts.fewHighways ? 'checked' : ''}>高速道路をなるべく使わない</label>
      <label class="check"><input type="checkbox" data-opt="bike" ${tour.opts.bike ? 'checked' : ''}>バイク向け（幹線を避け、地方の道を好む）</label>
    </fieldset>
    <div class="row"><span class="label">立寄</span><div id="radius" class="chips"></div></div>
    <label class="check"><input type="checkbox" id="awake" ${tour.awake ? 'checked' : ''}>このタブを開いている間は画面を消さない</label></details>
    <label class="check"><input type="checkbox" id="show-courses" ${tour.showCourses ? 'checked' : ''}>ドライブコース（${(DATA.roads.length + DATA.courses.length).toLocaleString()}本）と峠（${DATA.passes.length.toLocaleString()}か所）を地図に表示</label>
    ${tour.showCourses ? courseLegendHtml() : ''}</div>
    ${tour.showCourses ? curvyHtml() : ''}
    <details class="tools"><summary>🧭方面別の雨・🏍走行記録・閉鎖中の道</summary>
      <div class="actions"><button type="button" class="btn" id="dir-rain">🧭方面別の雨（出発日の9〜17時）</button></div><div id="dir-out"></div>
      <h4>🏍走行記録（GPS）</h4><p class="status" id="trk-msg">${trackText()}</p>
      <div class="actions"><button type="button" class="btn ${track.on ? '' : 'primary'}" id="trk-toggle">${track.on ? '⏹記録を止める' : '⏺記録を始める'}</button>
        <button type="button" class="btn" id="trk-gpx" ${track.pts.length > 1 ? '' : 'disabled'}>記録をGPXで保存</button>
        <button type="button" class="btn" id="trk-clear" ${track.pts.length ? '' : 'disabled'}>記録を消す</button></div>
      <details class="help"><summary aria-label="説明を見る">i</summary>記録中は画面をつけたままにしてください（画面が消えると止まる端末があります）。記録は端末の中にだけ保存します。</details>
      ${closedListHtml()}</details>
    ${tour.error ? `<p class="notice">${esc(tour.error)}</p>` : ''}
    ${tour.route && (tour.restored || offline) ? `<p class="notice">${offline ? '📴 圏外のため、' : ''}${fmtStamp(tour.route.at || 0)} に検索して保存したルートを表示しています${offline ? '' : '（再検索で更新）'}。</p>` : ''}
    ${routeStale() ? '<p class="notice">⚠ 走り方を変えました。「ルート候補を探す」で探し直してください（このままナビを開くと、ルートを固定する地点なしで Google マップに渡します）。</p>' : ''}
    ${tour.cands && tour.cands.length ? `<h2>ルート候補（${tour.cands.length}本${tour.cands.length > 1 ? '・押して切り替え' : ''}）</h2>
      <div class="actions"><button type="button" class="btn" id="rain-route" ${tour.rainBusy ? 'disabled' : ''}>☂雨に合いにくいルートを探す</button></div>
      <p class="status" id="rain-msg" aria-live="polite">${esc(tour.rainMsg || '')}</p>
      ${tour.rainAt && tour.cands.some((c) => c.rain) && Math.abs(tour.rainAt - departMs()) > 60e3 ? `<p class="notice">雨は ${hhmm(tour.rainAt)} に出発したときのものです。出発時刻を変えたので、もう一度「☂雨に合いにくいルートを探す」を押してください。</p>` : ''}
      <div class="cands">${tour.cands.map(candCard).join('')}</div>` : ''}
    ${tour.route ? `${dest && !dest.loop ? viaRoads.map((r) => `<p class="notice">「${esc(r.name)}」${(r.closedMonths || []).includes(thisMonth()) ? '⚠ <strong>今月は通行止め・閉鎖の期間です。</strong>' : ''}${r.toll ? `有料道路（${r.fee ? esc(r.fee) : '料金は公式サイトで確認'}）。` : ''}${r.closed ? `⚠ ${esc(r.closed)}` : ''}</p>`).join('') : ''}
      <div class="row"><span class="label">ルート</span><span class="status">${esc(tour.route.engine || 'OSRM')} による推定${tour.route.note ? '。' + esc(tour.route.note) : ''}</span>
        <details class="help"><summary aria-label="説明を見る">i</summary>${tour.opts.noToll || tour.opts.fewHighways ? 'Google マップでは「ルートオプション」でも同じ設定にしてください。' : ''}ナビは Google マップのアプリで開いてください（ブラウザ版の Google マップは経由地が 3 件までしか使えません）。</details></div>
      <div class="row"><label for="depart" class="label">出発</label><input type="datetime-local" id="depart" value="${esc(departValue())}"></div>
      <p class="status" id="eta">${etaText()}</p>
      <p class="status">${routeCostText(tour.route, !!(dest && dest.loop), !!tour.opts.bike)}</p>
      <div class="actions"><button type="button" class="btn" id="rt-rain">☔ルート上の雨</button><button type="button" class="btn" id="rt-elev">⛰標高</button>
        <button type="button" class="btn" id="rt-photo">📷ルート沿いの写真</button>
        <button type="button" class="btn" id="rt-onsen">♨帰りに寄れる温泉</button>
        <button type="button" class="btn" id="rt-park">🅿目的地の駐車場</button>
        <button type="button" class="btn" id="rt-fuel">⛽24時間ガソリンスタンド</button>
        ${(tour.route.guide || []).length ? `<button type="button" class="btn${dest && dest.loop && dest.road.hw ? ' primary' : ''}" id="rt-jct">🔀分岐（JCT）の案内（${tour.route.guide.length}か所）</button>` : ''}</div>
      ${dest && dest.loop && dest.road.hw ? `<p class="notice">🛣 高速道路のコースです。分岐で迷わないよう「🔀分岐（JCT）の案内」を走る前に確認してください。
        Google マップには${tour.route.gVerified ? `、Google マップで経路を開いて途中で高速を降りないことを確かめた地点（${esc(gFrom(dest.road).name)}発着で確認）` : tour.route.hwPins ? '、下の一般道や反対車線と重ならない高速道路の上の地点' : '高速道路の上の地点'}を経由地として渡します。
        Google マップで表示された距離が<strong>約${Math.round((tour.route.gVerified && atGFrom(dest.road) && dest.road.gkm) || tour.route.gmKm || tour.route.km)}km</strong>前後なら同じルートです（大きく違うときは、途中で高速を降りるルートになっています）。</p>${(tour.route.tollSpans || []).length > 1 ? `<p class="notice">⚠ <strong>このルートは途中で一度高速を降りて乗り直します</strong>（コースの向きどうしがうまくつながらないため）。つなげたコースなら「走り方」で外周を選ぶと、降りずに回れることがあります。</p>` : ''}` : ''}
      <div class="actions"><button type="button" class="btn" id="rt-save-map">📥ルート沿いの地図を保存（圏外用）</button></div>
      <p class="status" id="rt-save-msg"></p>
      <div id="rt-out"></div>
      ${closedHtml()}` : ''}
    ${tour.route ? `<details class="stops-box" id="stops-box" ${store.get('stopsOpen') ? 'open' : ''}>
      <summary>🛍立ち寄り候補（${stops.length}件・走る順）<span id="stops-picked"></span></summary>
      <div class="chips wrap" id="stop-kinds" aria-label="立ち寄り候補の種類"></div>
      ${kinds.has('food') ? `<div class="row"><label for="stop-cat" class="label">料理</label><select id="stop-cat">${[['', 'すべて']].concat(Lib.FOOD_CATS.map(([l]) => [l, l])).map(([v, l]) =>
        `<option value="${esc(v)}" ${(tour.foodCat || '') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>` : ''}
      <details class="help"><summary aria-label="説明を見る">i</summary>上の種類を押すと、出す候補を切り替えられます。カフェ・ごはん・24時間GSは、ルートから1km以内のお店です（ごはんはチェーン店を除きます。味の評価は入っていないので、▼詳しくの「写真・口コミ・GoogleMapで確認」で確かめてください）。名前を押すと地図でその場所を強調します。□で選ぶと、Google マップに経由地として渡します。</details>
      ${(kinds.has('cafe') || kinds.has('food')) && [...cellLoading.keys()].some((k) => k.startsWith('food/')) ? '<p class="hint">カフェ・ごはん屋さんを読み込み中…</p>' : ''}
      ${shown.length < stops.length ? `<p class="hint">${stops.length.toLocaleString()}件のうち${shown.length}件を、種類ごとにルート全体から均等に選んで表示しています（選んだものは全部）。${tour.stopsAll ? '' : '<button type="button" class="btn" id="stops-all">もっと表示</button>'}</p>` : ''}
      <p id="limit-msg" class="notice" hidden>立ち寄りは${room()}件まで選べます。ほかを外すと選べます。</p>`
      + (stops.length ? shown.map((s) => `
      <div class="card stop" data-focus="${esc(s.id)}"><input type="checkbox" data-stop="${esc(s.id)}" ${tour.picked.has(s.id) ? 'checked' : ''} aria-label="${esc(s.name)}を経由地に選ぶ">
        <span class="km">${Math.round(s.alongKm)}<small>km</small></span>
        <span class="name"><span class="nm">${s.poi || s.g ? emojiOf(s) : s.genres.map((g) => icon(GENRES[g] || '・')).join('')} ${esc(s.name)}${parkText(s) ? ` <strong>${parkText(s)}</strong>` : ''}</span>
          <span class="sub">道から${s.offKm.toFixed(1)}km${s.note ? '・' + esc(s.note) : ''}${arriveOpen(s)}</span></span>${infoButton(s)}</div>
      <div class="info stop-info" hidden></div>`).join('')
        : '<p class="empty">この範囲に立ち寄り候補はありません。範囲を広げるか、上の種類を増やしてみてください。</p>') + '</details>' : ''}
    ${dest ? `<div id="nav-legs" class="actions" hidden></div><div class="tour-bar"><a class="btn primary" id="nav" target="_blank" rel="noopener" href="#">ナビ開始</a>
      ${tour.route ? '<button type="button" class="btn" id="gpx">GPXで保存</button>' : ''}</div>` : ''}`;
  placeTourMap(dest);

  if ($('#stop-kinds')) {
    chips($('#stop-kinds'), STOP_KINDS.map(([k, label]) => [k, label]), (v) => kinds.has(v), (v) => {
      toggle(kinds, v); store.set('stopKinds', [...kinds]); tour.stops = null; tour.stopsAll = false;
    });
    const sc = $('#stop-cat'); if (sc) sc.onchange = (e) => { buzz(); tour.foodCat = e.target.value; tour.stops = null; renderTouring(); };
    const sa = $('#stops-all'); if (sa) sa.onclick = () => { buzz(); tour.stopsAll = true; renderTouring(); };
  }
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
  $('#my-route').addEventListener('toggle', (e) => store.set('myRouteOpen', e.target.open));
  if ($('#to-full')) $('#to-full').onclick = () => { buzz(); store.set('tourFull', true); setOutdoor(!!store.get('outdoor'), false); tour.key = ''; renderTouring(); };
  renderChainBox();
  renderSxBox();
  $('#sx-box').addEventListener('toggle', (e) => store.set('sxOpen', e.target.open));
  $('#mr-add').onclick = () => { buzz(); addMyRoute(); };
  document.querySelectorAll('[data-mr-go]').forEach((b) => { b.onclick = () => { buzz(); setDest(() => { tour.custom = null; tour.roadId = null; tour.destId = b.dataset.mrGo; }); }; });
  document.querySelectorAll('[data-mr-del]').forEach((b) => { b.onclick = () => {
    const r = myRoutes().find((t) => t.id === b.dataset.mrDel);
    if (!r || !confirm(`「${r.name}」を削除しますか？`)) return;
    store.set('myRoutes', myRoutes().filter((t) => t.id !== r.id));
    if (tour.destId === r.id) setDest(() => { tour.destId = null; }); else { tour.key = ''; renderTouring(); }
  }; });
  const pc = $('#pick-center');
  if (pc) pc.onclick = () => { if (!map) return; buzz(); const ce = map.getCenter(); setCustomDest(ce.lat, ce.lng); };
  document.querySelectorAll('[data-opt]').forEach((cb) => {
    // 変えたら描き直して「探し直して」を出す（古いルートのまま固定の地点を渡さない）
    cb.onchange = () => { buzz(); tour.opts = { ...tour.opts, [cb.dataset.opt]: cb.checked }; saveTour(); renderTouring(); };
  });
  $('#awake').onchange = (e) => { tour.awake = e.target.checked; store.set('awake', tour.awake); keepAwake(tour.awake); };
  const dp = $('#depart');
  if (dp) {
    dp.onchange = (e) => {
      tour.depart = e.target.value; saveTour(); $('#eta').textContent = etaText(); if (RADAR.on) showRadarFrame();
      const rm = $('#rain-msg'); if (rm && tour.cands && tour.cands.some((c) => c.rain)) rm.textContent = '出発時刻を変えたので、候補の雨はもう一度「☂雨に合いにくいルートを探す」で調べ直してください。';
    };
    $('#rt-rain').onclick = () => { buzz(); routeRain(); };
    $('#rt-elev').onclick = () => { buzz(); routeElevation(); };
    $('#rt-photo').onclick = () => { buzz(); routePhotos(); };
    $('#rt-onsen').onclick = () => { buzz(); routeOnsen(); };
    if ($('#rt-jct')) $('#rt-jct').onclick = () => { buzz(); renderJctGuide(); };
    $('#rt-fuel').onclick = () => { buzz(); routeFuel(); };
    $('#rt-park').onclick = () => {
      buzz();
      const d = currentDest(); if (!d) return;
      renderParking($('#rt-out'), { name: d.loop ? d.road.name : d.name, lat: d.lat, lon: d.lon, parking: d.parking }, tour.opts.bike ? 'bike' : null);
    };
  }
  $('#dir-rain').onclick = () => { buzz(); dirRain(); };
  $('#trk-toggle').onclick = () => { buzz(); toggleTrack(); };
  $('#trk-gpx').onclick = () => { buzz(); saveTrackGpx(); };
  $('#trk-clear').onclick = () => { if (confirm('走行記録を消しますか？')) { track.pts = []; saveTrack(); tour.key = ''; renderTouring(); } };
  const sm = $('#rt-save-map'); if (sm) sm.onclick = () => { buzz(); saveRouteTiles(); };
  bindCourseBtns($('#curvy'));
  bindCourseLegend();
  $('#tour-opts').addEventListener('toggle', (e) => store.set('tourOptsOpen', e.target.open));
  $('#show-courses').onchange = (e) => { tour.showCourses = e.target.checked; store.set('showCourses', tour.showCourses); renderTouring(); };
  const rr = $('#rain-route'); if (rr) rr.onclick = () => { buzz(); rainRoutes(); };
  $('#route-go').onclick = async () => {
    buzz(); tour.error = ''; tour.busy = true; renderTouring();
    // 地図で指定した地点は id がいつも 'custom' なので、地点そのものと走り方で同じ検索かを見分ける
    const sig = () => JSON.stringify([tour.destId, tour.roadId, tour.custom, tour.opts, DATA.cfg.origin]);
    const d = currentDest(), at = sig();
    try {
      const cands = await fetchCandidates(d);
      if (sig() === at) { tour.cands = cands; tour.sel = 0; tour.restored = false; tour.stops = null; tour.picked.clear(); tour.rainMsg = ''; tour.rainAt = 0; saveTour(); }
      else tour.error = '検索中に目的地か走り方が変わったため、結果を使いませんでした。もう一度探してください。';
    } catch (err) {
      if (sig() === at) tour.error = err.mine ? err.message : 'ルートを取得できませんでした。Google マップのボタンから確認してください。';
    }
    tour.busy = false;
    if (state.tab !== 'touring') return; // 検索中に別のタブへ移っていたら描かない
    renderTouring();
    // 結果（ルート候補）が見えるところまで送る。全画面ではパネルの中を、通常の表示では画面を
    const c = $('#view .cands') || (tour.error && $('#view .notice'));
    if (c) { if (document.body.classList.contains('tour-full')) { if (sheetSnap === 'low' || sheetSnap === 'min') setSheet('half'); $('#view').scrollTo({ top: c.offsetTop - 44, behavior: 'smooth' }); } else c.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
  };
  $('#view').onclick = (e) => {
    const b = e.target.closest('[data-cand]');
    if (b) { // 選択中をもう一度押しても何も変えない
      if (+b.dataset.cand !== tour.sel) { buzz(); tour.sel = +b.dataset.cand; tour.stops = null; tour.picked.clear(); saveTour(); renderTouring(); }
      return;
    }
    // 立ち寄り候補の行を押す（□・ボタン以外）→ 地図のアイコンを強調
    const row = e.target.closest('[data-focus]');
    if (!row || e.target.closest('input, button, a, .info')) return;
    buzz(); focusStop(row.dataset.focus);
  };
  const g = $('#gpx'); if (g) g.onclick = () => { buzz(); saveGpx(); };
  // チェックの変更では地図も一覧も作り直さない（マーカーとナビボタンだけ更新）
  const sb = $('#stops-box'); if (sb) sb.addEventListener('toggle', () => store.set('stopsOpen', sb.open));
  $('#view').onchange = (e) => {
    const cb = e.target.closest('[data-stop]'); if (!cb) return;
    buzz();
    togglePick(cb.dataset.stop, cb.checked);
  };
  drawMap(dest, shown);
  updateTourSelection();
}

// 目的地を変える。保存したルートがあるときは消えてよいか確かめる（圏外では取り直せないため）
// 短縮リンク（maps.app.goo.gl）は、ブラウザからは転送先を読めないため、外部の中継（allorigins）で展開する
async function expandMapsLink(text) {
  if (!Lib.isShortMapsUrl(text)) return text;
  const short = text.match(/https?:\/\/\S+/)[0];
  const r = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(short)}`, { signal: timeoutSignal(20000) });
  const j = r.ok ? await r.json() : {};
  return (j.status && j.status.url) || '';
}
async function addMyRoute() {
  const msg = $('#mr-msg'), text = $('#mr-url').value.trim();
  if (!text) { msg.textContent = 'リンクを貼り付けてください。'; return; }
  msg.textContent = '読み取っています…';
  let pts = null;
  try { pts = Lib.parseGmapsRoute(await expandMapsLink(text)); } catch { /* 下で案内 */ }
  if (!pts) {
    msg.textContent = Lib.isShortMapsUrl(text)
      ? '短縮リンクを展開できませんでした（中継サービスが混雑している可能性）。パソコンのブラウザでリンクを開き、アドレス欄の長い URL を貼り付けると登録できます。'
      : 'Google マップの経路のリンクとして読み取れませんでした。';
    return;
  }
  // 座標のない地点は住所（なければ名前）で国土地理院の検索から
  for (const p of pts.filter((x) => x.lat == null)) {
    try {
      const r = await fetch(Lib.gsiSearchUrl(p.addr || p.name), { signal: timeoutSignal(8000) });
      const hit = r.ok ? Lib.parseGsi(await r.json(), 1)[0] : null;
      if (hit) Object.assign(p, { lat: hit.lat, lon: hit.lon });
    } catch { /* その地点は飛ばす */ }
  }
  const missing = pts.filter((x) => x.lat == null).map((x) => x.name);
  const rt = Lib.routeFromPlaces(pts, MAX_WAYPOINTS - 2);
  if (!rt) { msg.textContent = '地点の位置が分かりませんでした。'; return; }
  const name = $('#mr-name').value.trim() || rt.name;
  const item = { ...rt, id: `my:${Date.now()}`, name, mine: true };
  store.set('myRoutes', [...myRoutes(), item]);
  setDest(() => { tour.custom = null; tour.roadId = null; tour.destId = item.id; });
  const m = $('#mr-msg');
  if (m) m.textContent = `「${name}」を登録しました（${rt.stops.length}地点）。${rt.cut ? `経由地が多いため ${rt.cut} 地点を間引きました。` : ''}${missing.length ? `位置が分からず飛ばした地点：${missing.join('、')}` : ''}「ルート候補を探す」で道を確認できます。`;
}
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
  const net = openPoiFor(q, DATA.cfg.origin, 60, () => { if (state.tab === 'touring') renderDestResults(); });
  const netPlaces = (net.items ? Lib.notInLocal(net.items, DATA.spots.concat(DATA.osm)) : []).slice(0, 6)
    .map((x) => ({ name: x.name, lat: x.lat, lon: x.lon, sub: `🌐 ${x.note || 'OpenPOI'}` }));
  dqState.items = roads.concat(spots, netPlaces, places);
  box.innerHTML = `<div class="dq-list">${dqState.items.map((x, i) => `<button type="button" class="card dq-item" data-dq="${i}">
      <strong>${esc(x.name)}</strong><span class="status">${esc(x.sub)}</span></button>`).join('')}</div>
    ${dqState.busy ? '<p class="hint">地名・住所を検索中…</p>' : dqState.error ? `<p class="hint">${esc(dqState.error)}</p>`
      : dqState.places ? (places.length ? '' : '<p class="hint">地名・住所では見つかりませんでした。</p>')
      : '<details class="help"><summary aria-label="説明を見る">i</summary>見つからないときは「検索」を押すと、地名・住所（国土地理院）でも探します。</details>'}`;
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

const radarPx = () => { const b = RADAR.on && $('#radar-bar'); return b ? b.offsetHeight + 8 : 0; };
// ツーリングの地図: ルートの線に重なる立ち寄りのアイコンを、ルートと直角に横へずらす（本当の位置は点と細い線で示す）。
// 重なるかは画面の上の距離で決まるので、ズームを変えるたびに置き直す
function layoutPins() {
  if (!map || !tour.route || !markers.size) return;
  const z = map.getZoom(), sc = z <= 9 ? 0.7 : z <= 11 ? 0.85 : 1; // style.css の --pin-s と同じ
  const pts = tour.route.line.map(([lon, lat]) => map.latLngToLayerPoint([lat, lon]));
  for (const m of markers.values()) {
    if (!m.pinOpts) continue;
    const [s, opts] = m.pinOpts, p = map.latLngToLayerPoint(m.getLatLng());
    const R = (opts.picked ? 17 : 15 * sc) + 7; // アイコンの半径＋ルートの線の太さの半分＋すき間
    let best = null; // 一番近い線分の点と向き
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy;
      const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2)) : 0;
      const cx = a.x + vx * t, cy = a.y + vy * t, d = Math.hypot(p.x - cx, p.y - cy);
      if (!best || d < best.d) best = { d, cx, cy, vx, vy };
    }
    let dx = 0, dy = 0;
    if (best && best.d < R) {
      const len = Math.hypot(best.vx, best.vy) || 1;
      let nx = -best.vy / len, ny = best.vx / len; // 線に直角
      if (best.d > 0.5 ? nx * (p.x - best.cx) + ny * (p.y - best.cy) < 0 : ny > 0) { nx = -nx; ny = -ny; } // その場所がある側へ（線の上なら上側へ）
      dx = Math.round(best.cx + nx * (R + 2) - p.x); dy = Math.round(best.cy + ny * (R + 2) - p.y);
    }
    if (m.pinShift !== `${dx},${dy}` || m.pinIconOpts !== opts) {
      m.pinShift = `${dx},${dy}`; m.pinIconOpts = opts;
      const hi = m.getElement() && m.getElement().classList.contains('pin-hi');
      m.setIcon(pinIcon(s, { ...opts, dx, dy }));
      if (hi && m.getElement()) m.getElement().classList.add('pin-hi');
    }
  }
}
const fitPad = () => (document.body.classList.contains('tour-full') ? { paddingTopLeft: [16, 72], paddingBottomRight: [16, sheetPx() + radarPx() + 16] }
  : { paddingTopLeft: [16, 16], paddingBottomRight: [16, radarPx() + 16] });
function drawMap(dest, stops) {
  if (typeof L === 'undefined') { $('#map').textContent = '地図を読み込めませんでした（圏外の可能性があります）。'; return; }
  if (map) map.remove();
  markers = new Map(); RADAR.layer = RADAR.rider = null; // 前の地図の雨雲は地図と一緒に消えた
  map = L.map('map', { renderer: L.canvas({ tolerance: 8 }) }).setView([DATA.cfg.origin.lat, DATA.cfg.origin.lon], 9);
  baseLayers(map, ' / ルート: Valhalla (FOSSGIS)・OSRM');
  // 重なり順: ほかの線（400）＜ ルートの線（450。押せない）＜ 立ち寄りのアイコン（600）＜ 選んだ立ち寄り・出発地・目的地（640）。
  // ルートに重なるアイコンは、横へずらして本当の位置を点と線で示す（layoutPins）
  const rp = map.createPane('routePane'); rp.style.zIndex = 450; rp.style.pointerEvents = 'none';
  map.createPane('pickPane').style.zIndex = 640;
  L.marker([DATA.cfg.origin.lat, DATA.cfg.origin.lon], { pane: 'pickPane', bubblingMouseEvents: false }).addTo(map).bindPopup(esc(DATA.cfg.origin.name));
  if (dest) L.marker([dest.lat, dest.lon], { pane: 'pickPane', bubblingMouseEvents: false }).addTo(map).bindPopup(esc(dest.name));
  // 地図を引いて見ているときは、選んでいないアイコンを小さく（道が見えるように）。寄ると元の大きさ
  const zoomCls = () => { const z = map.getZoom(), c = map.getContainer(); c.classList.toggle('zoom-far', z <= 9); c.classList.toggle('zoom-mid', z >= 10 && z <= 11); };
  map.on('zoomend', zoomCls); zoomCls();
  if (tour.route) {
    // ほかの候補は細い灰色の破線で比べられるように
    (tour.cands || []).forEach((c, i) => {
      if (i !== tour.sel) L.polyline(c.line.map(([lon, lat]) => [lat, lon]), { color: '#666', weight: 4, opacity: 0.8, dashArray: '6 8', bubblingMouseEvents: false }).addTo(map);
    });
    const latlngs = tour.route.line.map(([lon, lat]) => [lat, lon]);
    // 白い縁取りの上に濃い線を重ね、色の多い地図の上でも浮き上がらせる
    const rr = L.canvas({ pane: 'routePane' });
    L.polyline(latlngs, { color: '#fff', weight: 11, opacity: 0.95, renderer: rr, interactive: false }).addTo(map);
    const line = L.polyline(latlngs, { color: keyColor(), weight: 6, opacity: 1, renderer: rr, interactive: false }).addTo(map);
    stops.forEach((s) => {
      const m = L.marker([s.lat, s.lon], { icon: pinIcon(s, { top: false }), title: s.name, bubblingMouseEvents: false, riseOnHover: true }).addTo(map)
        .bindPopup(() => popupHtml(s, infoCache()[s.id] || null), { maxWidth: 280, minWidth: 220, maxHeight: 240, autoPanPaddingTopLeft: [16, 112], autoPanPaddingBottomRight: [16, 40] });
      m.on('popupopen', async () => {
        if (!infoCache()[s.id] || infoCache()[s.id].ver !== 4) {
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
      m.pinOpts = [s, { top: false }];
      markers.set(s.id, m);
    });
    map.fitBounds(line.getBounds(), fitPad());
    map.on('zoomend', layoutPins); map.whenReady(layoutPins);
  } else if (dest && dest.loop) {
    map.fitBounds(L.latLngBounds(dest.road.points.concat([[DATA.cfg.origin.lat, DATA.cfg.origin.lon]])), fitPad());
  }
  if (tour.showCourses) drawCourses();
  track.line = track.pts.length ? L.polyline(track.pts.map((p) => [p[0], p[1]]), { color: '#2f9e44', weight: 5 }).addTo(map) : null;
  // 誤操作を防ぐため、目的地の指定は長押し（スマホでは contextmenu として届く）か「中心を目的地に」ボタンだけ。
  // 長押し中（指が触れている間）に地図を作り直すと iPhone で次のタップが効かなくなることがあるので、少し遅らせる
  map.on('contextmenu', (e) => { buzz(); setTimeout(() => setCustomDest(e.latlng.lat, e.latlng.lng), 350); });
  renderRadarBar();
  if (RADAR.on) showRadarFrame();
}

// ---- 雨雲レーダー（気象庁の高解像度降水ナウキャスト・降水短時間予報）: ツーリングの地図に雨雲を重ね、下の時刻のバーでずらして見る。
// ルートがあれば、その時刻に走っている所（🏍）と、何時に出れば雨に合わないかも出す ----
const RADAR = { on: false, frames: null, at: 0, idx: 0, layer: null, rider: null, timer: null, err: '', planHtml: '', planSum: '', busy: false };
const RTILES = new Map(); // タイルの URL → 画素（の Promise）。雨の強さを読むため
async function radarFrames() {
  if (RADAR.frames && Date.now() - RADAR.at < 5 * 60e3) return RADAR.frames;
  const [n1, n2, rs] = await Promise.all(Lib.JMA_TIMES.map((u) => fetch(u, { cache: 'no-store', signal: timeoutSignal(10000) })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))));
  const prev = RADAR.frames && RADAR.frames[RADAR.idx];
  RADAR.frames = Lib.jmaFrames(n1, n2, rs, 60); RADAR.at = Date.now(); RTILES.clear();
  // 選んでいた時刻をできるだけ保つ（初めては、ルートの出発時刻が予報の範囲なら出発時刻、なければ現在）
  const want = prev ? prev.t : tour.route ? departMs() : Date.now();
  const f = Lib.frameAt(RADAR.frames, want) || RADAR.frames.find((x) => x.kind === 'now');
  RADAR.idx = Math.max(0, RADAR.frames.indexOf(f));
  return RADAR.frames;
}
function radarTile(url) {
  if (!RTILES.has(url)) {
    RTILES.set(url, new Promise((ok) => {
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = () => {
        try { const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0); ok(g.getImageData(0, 0, 256, 256).data); } catch { ok(null); }
      };
      img.onerror = () => ok(null);
      img.src = url;
    }));
  }
  return RTILES.get(url);
}
// その地点の雨の強さの段階（Lib.RAIN_LABELS）。まわり 1 画素（約 0.6km）も見て、ルートのすぐ横の雨も拾う。読めなければ null
async function rainLevelAt(f, lat, lon, z = 8) {
  const p = Lib.tilePixel(lat, lon, z);
  const d = await radarTile(f.url.replace('{z}', z).replace('{x}', p.x).replace('{y}', p.y));
  if (!d) return null;
  let lv = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const i = (Math.min(255, Math.max(0, p.py + dy)) * 256 + Math.min(255, Math.max(0, p.px + dx))) * 4;
      lv = Math.max(lv, Lib.rainLevel(d[i], d[i + 1], d[i + 2], d[i + 3]));
    }
  }
  return lv;
}
const hhmm = (ms) => { const d = new Date(ms); return `${d.toDateString() === new Date().toDateString() ? '' : '翌'}${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
// そのコマの時刻に走っている所を見る時刻。1 時間の予報のコマは、その 1 時間のうち走っている時間（なければ真ん中）
function riderTime(f) {
  if (f.kind !== 'fcst' || !tour.route) return f.t;
  const a = Math.max(departMs(), f.from), b = Math.min(departMs() + tour.route.min * 60e3, f.to);
  return a <= b ? Math.min(Math.max((f.from + f.to) / 2, a), b) : (f.from + f.to) / 2;
}
const relText = (ms) => {
  const m = Math.round((ms - Date.now()) / 60e3), a = Math.abs(m);
  return a < 3 ? '現在' : `${m < 0 ? '-' : '+'}${a >= 60 ? `${Math.floor(a / 60)}時間${a % 60 ? (a % 60) + '分' : ''}` : `${a}分`}`;
};
function radarLabel(f) {
  return f.kind === 'fcst' ? `${hhmm(f.from)}〜${hhmm(f.to)}<small>予報（1時間の雨量）</small>`
    : `${hhmm(f.t)}<small>${f.kind === 'past' ? '実況' : f.kind === 'now' ? '実況（最新）' : '予報'}</small>`;
}
// 時刻のバー（Yahoo!天気の雨雲レーダーのように、再生・つまみ・「現在」と「+1時間」などの目盛り）
function radarBarHtml() {
  if (RADAR.err) return `<p class="hint">${esc(RADAR.err)}</p><button type="button" class="icon radar-x" data-radar="off" aria-label="雨雲を閉じる">✕</button>`;
  const fr = RADAR.frames;
  if (!fr) return '<p class="hint">雨雲を読み込んでいます…</p>';
  const n = fr.length - 1, nowI = fr.findIndex((f) => f.kind === 'now');
  const pos = (i) => `${(i / Math.max(1, n)) * 100}%`;
  // 目盛り: 左端（1時間前）・現在・1・3・6・9・12・15時間後（それぞれに一番近いコマの位置）
  const ticks = [[0, `-${Math.round((fr[nowI].t - fr[0].t) / 3600e3)}h`], [nowI, '現在']];
  for (const h of [1, 3, 6, 9, 12, 15]) {
    let best = -1;
    fr.forEach((f, i) => { if (i > nowI && (best < 0 || Math.abs(f.t - fr[nowI].t - h * 3600e3) < Math.abs(fr[best].t - fr[nowI].t - h * 3600e3))) best = i; });
    if (best > 0 && Math.abs(fr[best].t - fr[nowI].t - h * 3600e3) < 45 * 60e3 && !ticks.some(([i]) => i === best)) ticks.push([best, `+${h}h`]);
  }
  // 前の目盛りに近すぎて文字が重なるものは省く（バーの幅の 7% 未満。「現在」は残す）
  ticks.sort((a, b) => a[0] - b[0]);
  for (let k = 1; k < ticks.length; k++) if (ticks[k][1] !== '現在' && (ticks[k][0] - ticks[k - 1][0]) / Math.max(1, n) < 0.07) ticks.splice(k--, 1);
  const pastEnd = pos(nowI);
  return `<div class="radar-top"><button type="button" class="icon radar-play" data-radar="play" aria-label="${RADAR.timer ? '止める' : '再生'}">${RADAR.timer ? '⏸' : '▶'}</button>
      <div class="radar-time" id="radar-time" aria-live="polite"></div>
      ${tour.route ? '<button type="button" class="btn radar-plan-btn" data-radar="plan">🕒雨に合わない出発時刻</button>' : ''}
      <button type="button" class="icon radar-x" data-radar="off" aria-label="雨雲を閉じる">✕</button></div>
    <div class="radar-track" style="--past:${pastEnd}">
      <input type="range" id="radar-range" min="0" max="${n}" step="1" value="${RADAR.idx}" aria-label="雨雲の時刻">
      <div class="radar-ticks" aria-hidden="true">${ticks.map(([i, l]) => `<span style="left:${pos(i)}"${l === '現在' ? ' class="now"' : ''}>${l}</span>`).join('')}</div></div>
    ${RADAR.planSum ? `<button type="button" class="radar-sum" data-radar="list">${esc(RADAR.planSum)} <span>一覧 ▸</span></button>` : ''}
    <div class="radar-foot"><p class="radar-here" id="radar-here"></p>
      <div class="radar-legend" aria-label="雨の強さ（mm/時）">${Lib.RAIN_COLORS.slice(1).map(([r, g, b], i) => `<span style="background:rgb(${r},${g},${b})"></span>${[1, 5, 10, 20, 30, 50, 80][i]}`).join('')}<em>mm/h 気象庁</em></div></div>`;
}
function renderRadarBar() {
  const el = $('#radar-bar'); if (!el) return;
  el.hidden = !RADAR.on;
  if (!RADAR.on) return;
  el.innerHTML = radarBarHtml();
  updateRadarText();
}
// 選んだ時刻の表示と、その時刻に走っている所の雨
async function updateRadarText() {
  const f = RADAR.frames && RADAR.frames[RADAR.idx];
  const tm = $('#radar-time'), here = $('#radar-here');
  if (!f || !tm) return;
  tm.innerHTML = `<strong>${radarLabel(f)}</strong><span class="rel">${relText(f.t)}</span>`;
  const r = $('#radar-range'); if (r && +r.value !== RADAR.idx) r.value = RADAR.idx;
  if (!here) return;
  if (!tour.route) { here.textContent = ''; return; }
  const p = Lib.routeAt(tour.route.line, tour.route.min, departMs(), riderTime(f));
  if (!p) { here.textContent = f.to < departMs() ? `出発（${hhmm(departMs())}）より前の時刻です。` : `到着（${hhmm(departMs() + tour.route.min * 60e3)}）より後の時刻です。`; return; }
  here.textContent = `🏍 この時刻は出発から約${Math.round(p.km)}kmの所…`;
  const lv = await rainLevelAt(f, p.lat, p.lon);
  if (RADAR.frames[RADAR.idx] !== f || !$('#radar-here')) return;
  $('#radar-here').textContent = `🏍 この時刻は出発から約${Math.round(p.km)}kmの所：${lv == null ? '雨雲を読めませんでした' : lv === 0 ? '雨なし' : `☔ ${Lib.RAIN_LABELS[lv]}`}`;
}
// 気象庁の雨雲タイルは偶数のズーム（4・6・8・10）にしかない（奇数は空の画像）。奇数のズームや 10 より拡大したときは、
// 上の偶数ズームのタイルを切り出して拡大する
let RadarLayer = null;
const radarLayer = (opts) => {
  if (!RadarLayer) {
    RadarLayer = L.GridLayer.extend({
      createTile(c, done) {
        const tile = document.createElement('canvas'); tile.width = tile.height = 256;
        const nz = Math.min(10, c.z - (c.z % 2)), k = 2 ** (c.z - nz), s = 256 / k;
        const img = new Image(); img.crossOrigin = 'anonymous';
        img.onload = () => { const g = tile.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(img, (c.x % k) * s, (c.y % k) * s, s, s, 0, 0, 256, 256); done(null, tile); };
        img.onerror = () => done(null, tile);
        img.src = this.options.url.replace('{z}', nz).replace('{x}', Math.floor(c.x / k)).replace('{y}', Math.floor(c.y / k));
        return tile;
      },
    });
  }
  return new RadarLayer(opts);
};
// 地図に選んだ時刻の雨雲と、その時刻に走っている所（🏍）を出す
function showRadarFrame() {
  if (!map || !RADAR.on || !RADAR.frames) return;
  const f = RADAR.frames[RADAR.idx]; if (!f) return;
  const old = RADAR.layer;
  RADAR.layer = radarLayer({ url: f.url, opacity: 0.65, minZoom: 4, maxZoom: 18, zIndex: 450, className: 'radar-tiles',
    attribution: '雨雲: <a href="https://www.jma.go.jp/bosai/nowc/" target="_blank" rel="noopener">気象庁</a>' });
  // 新しいコマが読み込めてから前のコマを消す（ちらつかないように）
  const drop = () => { if (old && old !== RADAR.layer && old._map) old.remove(); };
  RADAR.layer.once('load', drop); setTimeout(drop, 1500);
  RADAR.layer.addTo(map);
  const p = tour.route && Lib.routeAt(tour.route.line, tour.route.min, departMs(), riderTime(f));
  if (RADAR.rider && RADAR.rider._map) RADAR.rider.remove();
  RADAR.rider = p ? L.marker([p.lat, p.lon], { pane: map.getPane('pickPane') ? 'pickPane' : 'markerPane', icon: L.divIcon({ className: 'radar-rider', html: '🏍', iconSize: [30, 30] }), interactive: false, zIndexOffset: 1000 }).addTo(map) : null;
  updateRadarText();
}
let radarDrag = 0;
async function radarOn(on) {
  RADAR.on = on; RADAR.err = '';
  clearInterval(RADAR.timer); RADAR.timer = null;
  const b = $('#radar-toggle'); if (b) b.setAttribute('aria-pressed', on);
  if (!on) { if (RADAR.layer && RADAR.layer._map) RADAR.layer.remove(); if (RADAR.rider && RADAR.rider._map) RADAR.rider.remove(); RADAR.layer = RADAR.rider = null; renderRadarBar(); return; }
  // 全画面のときは下のパネルをつまみだけにして、地図をほぼ全画面で見せる（つまみを引けば戻せる）
  if (document.body.classList.contains('tour-full') && sheetSnap !== 'min') setSheet('min');
  renderRadarBar();
  try { await radarFrames(); } catch { RADAR.err = '雨雲を読み込めませんでした（圏外の可能性があります）。'; }
  renderRadarBar(); showRadarFrame();
  // ルートが下のパネル・時刻のバーに隠れない所に収まるように
  if (map && tour.route) map.fitBounds(L.latLngBounds(tour.route.line.map(([lon, lat]) => [lat, lon])), fitPad());
}
function radarStep(i) {
  RADAR.idx = Math.max(0, Math.min(RADAR.frames.length - 1, i));
  updateRadarText();
  clearTimeout(radarDrag); radarDrag = setTimeout(showRadarFrame, 120); // つまみを動かしている間は少し待ってから読み込む
}
document.addEventListener('input', (e) => { if (e.target.id === 'radar-range' && RADAR.frames) radarStep(+e.target.value); });
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-radar], #radar-toggle'); if (!b) return;
  buzz();
  const act = b.id === 'radar-toggle' ? (RADAR.on ? 'off' : 'on') : b.dataset.radar;
  if (act === 'on' || act === 'off') radarOn(act === 'on');
  else if (act === 'play' && RADAR.frames) {
    if (RADAR.timer) { clearInterval(RADAR.timer); RADAR.timer = null; } else {
      if (RADAR.idx >= RADAR.frames.length - 1) RADAR.idx = 0;
      RADAR.timer = setInterval(() => {
        if (!RADAR.on || !$('#radar-bar') || RADAR.idx >= RADAR.frames.length - 1) { clearInterval(RADAR.timer); RADAR.timer = null; renderRadarBar(); return; }
        RADAR.idx++; updateRadarText(); showRadarFrame();
      }, 800);
    }
    renderRadarBar();
  } else if (act === 'plan') radarPlan();
  else if (act === 'list') showRadarPlan();
  else if (act === 'dep') {
    // 一覧で選んだ出発時刻にする（地図の時刻もその出発に合わせる）
    const t = +b.dataset.t, d = new Date(t);
    tour.depart = `${Lib.ymd(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    saveTour();
    const dp = $('#depart'); if (dp) dp.value = tour.depart;
    const eta = $('#eta'); if (eta) eta.textContent = etaText();
    document.querySelectorAll('.rplan [data-radar="dep"]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    const f = Lib.frameAt(RADAR.frames, t); if (f) radarStep(RADAR.frames.indexOf(f));
  }
});
// 出発時刻の一覧を見せる（全画面では下のパネルを半分まで上げて一覧の所へ）
function showRadarPlan() {
  const out = $('#radar-plan'); if (!out) return;
  if (document.body.classList.contains('tour-full') && (sheetSnap === 'min' || sheetSnap === 'low')) setSheet('half');
  setTimeout(() => out.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
}
// 何時に出れば雨に合わないか: 今から 30 分ごとの出発で、ルート上の地点を通る時刻の雨雲（ナウキャスト・降水短時間予報）を見る
async function radarPlan() {
  const out = $('#radar-plan'); if (!out || !tour.route || RADAR.busy) return;
  RADAR.busy = true;
  out.innerHTML = '<p class="hint">🕒 出発時刻ごとに、ルート上の雨雲を調べています…</p>';
  RADAR.planSum = '🕒 調べています…'; renderRadarBar();
  try {
    const fr = await radarFrames();
    const last = fr[fr.length - 1].to, rt = tour.route;
    const opts = Lib.departOptions(Date.now(), last, 30, 30);
    const n = Math.max(20, Math.min(120, Math.round(rt.km / 2))); // 約 2km ごと
    const rows = [];
    for (const d of opts) {
      const pts = Lib.routeSamples(rt.line, rt.min, d, n);
      const levels = await Promise.all(pts.map((p) => { const f = Lib.frameAt(fr, p.at); return f ? rainLevelAt(f, p.lat, p.lon) : null; }));
      const v = Lib.rainVerdict(levels);
      rows.push({ d, v, first: v.firstWet >= 0 ? pts[v.firstWet] : null, lastKnown: pts.filter((p, i) => levels[i] != null).pop() });
      out.innerHTML = `<p class="hint">🕒 調べています…（${rows.length}/${opts.length}）</p>`;
    }
    const ok = rows.filter((r) => r.v.wet === 0 && r.v.unknown === 0); // 全区間が予報の範囲内で、雨なし（ぱらつく程度は含める）
    const runs = []; // 雨に合わない出発時刻を「15:00〜16:30」のようにまとめる
    for (const r of ok) { const l = runs[runs.length - 1]; if (l && r.d - l[1] === 1800e3) l[1] = r.d; else runs.push([r.d, r.d]); }
    const dot = (lv) => (lv == null ? '#ccc' : lv === 0 ? '#2f9e44' : `rgb(${Lib.RAIN_COLORS[lv - 1].join(',')})`);
    RADAR.planSum = !rows.length ? '🕒 予報の範囲に収まる出発時刻がありません'
      : ok.length ? `✓ 雨に合わない出発: ${runs.slice(0, 2).map(([a, b]) => (a === b ? hhmm(a) : `${hhmm(a)}〜${hhmm(b)}`)).join('・')}${runs.length > 2 ? '…' : ''}`
        : '☔ どの時刻に出ても、どこかで雨に合いそう';
    RADAR.planHtml = `<h4>🕒何時に出れば雨に合わない？（${esc(currentDest() ? currentDest().name : 'ルート')}・約${Math.round(rt.km)}km・${fmtMin(Math.round(rt.min))}）</h4>
      ${!rows.length ? '<p class="notice">雨雲の予報（15時間先まで）の中に収まる出発時刻がありません（ルートが長いため）。</p>'
    : ok.length ? `<p class="status">✓ 雨に合わずに走れそうな出発: <strong>${runs.map(([a, b]) => (a === b ? hhmm(a) : `${hhmm(a)}〜${hhmm(b)}`)).join('・')}</strong>（いちばん早いのは ${hhmm(ok[0].d)}）</p>`
      : '<p class="notice">☔ 今から15時間の間は、どの時刻に出てもルートのどこかで雨に合いそうです。雨の少ない時刻を選ぶか、カッパの用意を。</p>'}
      <div class="rplan">${rows.map((r) => `<button type="button" class="rp" data-radar="dep" data-t="${r.d}" aria-pressed="${Math.abs(r.d - departMs()) < 60e3}">
        <span class="rp-dot" style="background:${dot(r.v.wet ? r.v.max : r.v.max == null ? null : 0)}"></span><strong>${hhmm(r.d)}</strong>
        <span>${r.v.max == null ? '予報の範囲外' : r.v.wet ? `☔ ${hhmm(r.first.at)}ごろ ${Math.round(r.first.km)}km付近から雨（最大 ${Lib.RAIN_LABELS[r.v.max]}・雨の区間 約${Math.max(1, Math.round(r.v.wet * rt.km / n))}km）`
    : r.v.drizzle ? '🌂 ぱらつく程度（1mm未満）' : '✓ 雨なし'}${r.v.unknown && r.v.max != null ? `（${hhmm(r.lastKnown.at)}より後は予報の範囲外）` : ''}</span>
        <small>着 ${hhmm(r.d + rt.min * 60e3)}</small></button>`).join('')}</div>
      <details class="help"><summary aria-label="説明を見る">i</summary>気象庁の高解像度降水ナウキャスト（1時間先まで5分ごと）と降水短時間予報（15時間先まで1時間ごと）の雨雲で、ルート上の約${(rt.km / n).toFixed(1)}kmごとの地点を通る時刻の雨を見ています（1mm/時以上を「雨」）。休憩・立ち寄りの時間は含みません。予報なので外れることがあります。押すとその時刻を出発にし、地図の雨雲もその時刻にします。</details>`;
  } catch { RADAR.planHtml = '<p class="hint">雨雲を読み込めませんでした（圏外の可能性があります）。</p>'; RADAR.planSum = ''; }
  RADAR.busy = false;
  const o = $('#radar-plan'); if (o) o.innerHTML = RADAR.planHtml;
  renderRadarBar();
}

// ---- 雨に合いにくいルート: ルート候補ごとに、出発時刻に走ったときの雨（雨雲レーダー）を調べる。標準のルートが雨に当たるなら、
// 雨の区間の左右へ回る迂回ルートも探して候補に足し、いちばん雨の少ない候補を選ぶ ----
async function routeRainOf(c, depart, fr) {
  const n = Math.max(20, Math.min(120, Math.round(c.km / 2)));
  const pts = Lib.routeSamples(c.line, c.min, depart, n);
  const levels = await Promise.all(pts.map((p) => { const f = Lib.frameAt(fr, p.at); return f ? rainLevelAt(f, p.lat, p.lon) : null; }));
  const v = Lib.rainVerdict(levels);
  return { wetKm: v.wet ? Math.max(1, Math.round(v.wet * c.km / n)) : 0, max: v.max, unknown: v.unknown, n, at: depart,
    wetPts: pts.filter((p, i) => levels[i] >= 2).map(({ lat, lon }) => ({ lat, lon })) };
}
const rainText = (r) => (!r ? '' : r.max == null ? '雨の予報の範囲外' : r.wetKm ? `☔ 雨の区間 約${r.wetKm}km（最大 ${Lib.RAIN_LABELS[r.max]}）`
  : `${r.max === 1 ? '🌂 ぱらつく程度' : '☀ 雨なし'}${r.unknown ? '（後半は予報の範囲外）' : ''}`);
async function rainRoutes() {
  const d = currentDest();
  if (!tour.cands || !d || tour.rainBusy) return;
  const msg = (t) => { tour.rainMsg = t; const el = $('#rain-msg'); if (el) el.textContent = t; };
  tour.rainBusy = true; msg('☂ ルート候補ごとに雨を調べています…');
  const sig = () => JSON.stringify([tour.destId, tour.roadId, tour.custom, tour.opts, DATA.cfg.origin, tour.cands.length]);
  const at = sig();
  try {
    const fr = await radarFrames(), dep = departMs();
    if (dep > fr[fr.length - 1].to - 30 * 60e3) throw fail(`雨雲の予報は ${hhmm(fr[fr.length - 1].to)} までです。出発時刻を早めると調べられます。`);
    if (dep < fr[0].from) throw fail('出発時刻が過ぎています。出発時刻を今より後にしてください。');
    for (const c of tour.cands) c.rain = await routeRainOf(c, dep, fr);
    let best = Math.min(...tour.cands.map((c) => c.rain.wetKm));
    const std = tour.cands[0], added = [];
    let why = d.loop ? '周回コースなので回り道は探していません。' : '';
    if (best > 0 && !d.loop) {
      const vias = Lib.rainDetourVias(std.rain.wetPts, DATA.cfg.origin, d);
      if (!vias.length) why = '雨は出発地か目的地のそばなので、回り道では避けられません。';
      for (let k = 0; k < vias.length; k++) {
        const v = vias[k];
        msg(`☂ 雨を避ける回り道を探しています…（${k + 1}/${vias.length}・${v.side}側へ約${v.d}km）`);
        await new Promise((ok) => setTimeout(ok, 800)); // 公開のルートサーバーへの配慮
        try {
          const [rt] = await valhalla([DATA.cfg.origin, { lat: v.lat, lon: v.lon }, d], tour.opts);
          if (rt.min > std.min * 1.6 + 20) continue; // 遠回りすぎる
          if (tour.cands.concat(added).some((c) => Math.abs(c.km - rt.km) < Math.max(0.5, rt.km * 0.01) && Math.abs(c.min - rt.min) < 2)) continue; // ほぼ同じルート
          rt.rain = await routeRainOf(rt, dep, fr);
          if (rt.rain.wetKm >= best) continue;
          // Google マップには、道の上に置き直した経由地を渡す（回り道を通るように）
          added.push({ ...rt, label: `☂雨を避ける（${v.side}側を回る）`, via: [], fixed: [Lib.nearestOnLine(rt.line, v)], note: std.note, opts: std.opts });
        } catch { /* 引けなければ次の経由地へ */ }
      }
    }
    if (sig() !== at) throw fail('調べている間にルート候補が変わったため、結果を使いませんでした。');
    if (added.length) {
      tour.cands.push(...added.sort((a, b) => a.rain.wetKm - b.rain.wetKm || a.min - b.min).slice(0, 2));
      const scores = tour.cands.map((c) => Lib.scenicScore(c.line, scenicPoints(), DATA.roads));
      const stars = Lib.scenicStars(scores), fastest = Math.min(...tour.cands.map((c) => c.min));
      tour.cands.forEach((c, i) => Object.assign(c, scores[i], { stars: stars[i], fastest: c.min === fastest, at: c.at || Date.now() }));
    }
    best = Math.min(...tour.cands.map((c) => c.rain.wetKm));
    const bi = tour.cands.map((c, i) => [c.rain.wetKm, c.min, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1])[0][2];
    tour.cands.forEach((c, i) => { c.rainBest = i === bi; delete c.rain.wetPts; }); // 保存を小さく
    const b = tour.cands[bi];
    const plus = (c) => (c.min - std.min >= 1 ? `標準より +${Math.round(c.min - std.min)}分` : '標準と同じくらいの時間');
    msg(best === 0 ? `☀ ${hhmm(dep)} に出発なら「${b.label}」で雨に合わなそうです${bi === 0 ? '' : `（${plus(b)}。標準は ${rainText(std.rain)}）`}。`
      : bi !== 0 && b.rain.wetKm < std.rain.wetKm ? `☂ 「${b.label}」なら雨の区間 約${b.rain.wetKm}km（標準は約${std.rain.wetKm}km）・${plus(b)}。`
        : `☔ どのルートでも雨の区間があります（いちばん少なくて約${best}km）。${why}出発時刻をずらすと避けられるかもしれません（🌧雨雲 →「🕒雨に合わない出発時刻」）。`);
    if (bi !== tour.sel) { tour.sel = bi; tour.stops = null; tour.picked.clear(); }
    tour.rainAt = dep; saveTour();
  } catch (err) { msg(err.mine ? err.message : '雨雲かルートを読み込めませんでした（圏外の可能性があります）。'); }
  tour.rainBusy = false; tour.key = ''; renderTouring();
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
    <details class="help"><summary aria-label="説明を見る">i</summary>営業時間がわかる温泉だけ「営業中」を表示しています。最終受付は公式サイトで確認してください。</details>`;
  const bi = $('#back-time'); if (bi) bi.onchange = (e) => { tour.backTime = e.target.value || '15:00'; routeOnsen(tour.backTime); };
  fillAddr(out);
}
// ---- ルート沿い（1km 以内）の 24 時間営業のガソリンスタンド: 走る順に、通過する時刻の目安つき。地図にも ⛽ ----
let fuelLayer = null;
function routeFuel() {
  const out = $('#rt-out'), rt = tour.route;
  const all = DATA.pois.filter((p) => p.kind === 'fuel24');
  const xs = Lib.stopsAlongRoute(all, rt.line, 1);
  const lineKm = Lib.distToRoute({ lat: rt.line[rt.line.length - 1][1], lon: rt.line[rt.line.length - 1][0] }, rt.line).along || rt.km;
  const at = (x) => departMs() + rt.min * 60e3 * Math.min(1, x.alongKm / lineKm);
  if (fuelLayer) fuelLayer.remove();
  if (map) {
    const ic = L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13], html: '<span class="pin">⛽</span>' });
    fuelLayer = L.layerGroup(xs.map((x) => L.marker([x.lat, x.lon], { icon: ic, title: x.name })
      .bindPopup(`<div class="pop"><strong>⛽ ${esc(x.name)}</strong><span class="status">24時間営業${x.self === 1 ? '・セルフ' : x.self === 0 ? '・フルサービス' : ''}</span>
        <div class="actions"><a class="btn" ${gm(x)}>写真・口コミ・GoogleMapで確認</a></div></div>`))).addTo(map);
  }
  // 有料区間（高速道路）を走っている所の近くは、下や横の一般道のスタンド（SA・PA 以外は一度降りる）
  const onHw = (x) => Lib.inSpans(x.alongKm * rt.km / lineKm, rt.tollSpans);
  out.innerHTML = `<h4>⛽24時間営業のガソリンスタンド（ルートから1km以内・${xs.length}か所・走る順）</h4>`
    + (xs.length ? `<ul class="rel">${xs.map((x) => `<li><strong>${Math.round(x.alongKm)}km</strong>・<a ${gm(x)}>${esc(x.name)}</a>
      <span class="status">${x.brand ? esc(x.brand) + '・' : ''}${x.self === 1 ? 'セルフ・' : x.self === 0 ? 'フルサービス・' : ''}道から${x.offKm < 0.1 ? '0.1km未満' : x.offKm.toFixed(1) + 'km'}・${hm(at(x))}ごろ通過</span>${onHw(x) ? ' <span class="badge warn">🛣高速を走行中の区間（SA・PA 以外は一度降りて給油）</span>' : ''}</li>`).join('')}</ul>`
      : `<p class="hint">${all.length ? 'ルートから1km以内に見つかりませんでした。' : 'まだ収集されていません（次の自動更新で集めます）。'}</p>`)
    + '<details class="help"><summary aria-label="説明を見る">i</summary>OpenStreetMap で「24時間営業」と登録されている所です。営業時間が変わっていることがあるので、深夜は早めに給油してください。「🛣高速を走行中の区間」の印は、その付近ではルートが有料道路を走っているという意味です（印がない所は一般道から寄れます。ルートが OSRM のときは印が付きません）。</details>';
  fillAddr(out);
}
// ルートから km 以内にかかる升目（2km ごとの点から km+1 の範囲。頂点の間が長い直線でも升目を取りこぼさない）
function routeCells(line, km) {
  const set = new Set();
  for (let i = 0; i < line.length; i++) {
    const [lon, lat] = line[i], next = line[i + 1];
    const n = next ? Math.max(1, Math.ceil(Lib.haversineKm({ lat, lon }, { lat: next[1], lon: next[0] }) / 2)) : 1;
    for (let j = 0; j < n; j++) {
      const p = next ? { lat: lat + (next[1] - lat) * j / n, lon: lon + (next[0] - lon) * j / n } : { lat, lon };
      Lib.cellsInRadius(p, km + 1).forEach((c) => set.add(c));
    }
  }
  return [...set];
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
    : '<details class="help"><summary aria-label="説明を見る">i</summary>写真が見つかりませんでした。</details>') + '<p class="hint">写真: Wikimedia Commons（ルート上の地点から3km以内）</p>';
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
    <details class="help"><summary aria-label="説明を見る">i</summary>林道は狭い・未舗装の区間があることがあります。路面と通行止めは事前に確認してください。</details></details>`;
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
      <ul class="rel">${rows.map((x) => `<li>${esc(dirName(x.dir))}：${x.prob >= 50 ? '☔' : '☀'}${x.prob}%</li>`).join('')}</ul><details class="help"><summary aria-label="説明を見る">i</summary>起点から約70km先の地点の予報（Open-Meteo）</details>`;
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

// ---- 分岐（JCT・出口）の案内: 走る順に「どこで・どちらへ」。押すと地図でその場所へ ----
function renderJctGuide() {
  const out = $('#rt-out'), g = (tour.route && tour.route.guide) || [];
  if (!out) return;
  out.innerHTML = `<h4>🔀 分岐（JCT・出口）の案内（${g.length}か所・走る順）</h4>
    <ol class="jct-list">${g.map((x, i) => `<li><button type="button" class="linklike" data-jct="${i}"><strong>${x.km}km</strong>${x.jct ? `・<strong>${esc(x.jct)}</strong>` : ''}</button>：${esc(x.text || '分岐')}</li>`).join('')}</ol>
    <details class="help"><summary aria-label="説明を見る">i</summary>案内は OpenStreetMap の標識の情報から作っています（Valhalla）。実際の標識・車線の表示を優先してください。押すと地図でその場所を表示します。</details>`;
  out.querySelectorAll('[data-jct]').forEach((b) => { b.onclick = () => {
    const x = g[+b.dataset.jct];
    if (map && x.lat != null) { map.setView([x.lat, x.lon], 16); $('#map').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }; });
}

// ---- ドライブコースと峠を地図に（厳選は太線、自動収集は細線、峠は紫の点）。押すと説明と「このコースを走る」 ----
// 出典（調べたページ）へのリンク
// 二輪が通れない道（車で走るコース）
// 全コースを確かめて、ルートに往復・Uターンが残ったコースの注意
const routeIssue = (r) => {
  if (r.parts) return r.parts.map(routeIssue).find(Boolean) || '';
  return DATA.issues.courses[r.id] || (DATA.issues.auto[r.id] === 'back' ? 'この自動収集のコースは、ルート検索で一部を往復（Uターン）する区間があります（毎週の更新で直ることがあります）。' : '');
};
const routeIssueHtml = (r) => (routeIssue(r) ? `<br>↩ ${esc(routeIssue(r))}` : '');
const noBikeHtml = (r) => (r.noBike ? `<br>🚫 <strong>二輪通行不可（車で走るコース）</strong>：${esc(r.noBike)}` : '');
const courseSources = (r) => ((r.sources || []).length ? `<p class="hint">出典：${r.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`).join('、')}</p>` : '');
function courseHtml(r) {
  const closedNow = (r.closedMonths || []).includes(thisMonth());
  const [tLabel, tColor] = Lib.COURSE_TYPES[Lib.courseType(r)];
  return `<div class="pop"><strong>${r.pass ? '⛰' : '🛣'} ${esc(r.name)}</strong>
    <span class="status"><span class="swatch" style="--c:${tColor}"></span>${esc(tLabel)}${r.curv ? `・カーブ${'★'.repeat(Lib.curvStars(r.curv))}` : ''}${r.km ? `・約${Math.round(r.km)}km` : ''}</span>
    <p>${r.toll ? '<strong>有料</strong>・' : ''}${esc(r.note || '')}${r.closed ? `<br>⚠ ${esc(r.closed)}` : ''}${closedNow ? '<br>⚠ <strong>今月は通行止め・閉鎖の期間です</strong>' : ''}${(r.alerts || []).map((a) => `<br>⚠ <strong>${esc(a)}</strong>`).join('')}${noBikeHtml(r)}${routeIssueHtml(r)}</p>
    ${courseSources(r)}
    <div class="actions">${r.pass ? `<button type="button" class="btn primary" data-pass-go="${esc(r.id)}">ここを目的地に</button>`
      : `<button type="button" class="btn primary" data-course-go="${esc(r.id)}">このコースを走る（周回）</button>
        <button type="button" class="btn" data-course-add="${esc(r.id)}">${chainDraft().includes(r.id) ? '✓ つなげる一覧に入っています' : '🔗つなげる（連続で走る）'}</button>`}</div></div>`;
}
function bindCourseBtns(el) {
  if (!el) return;
  el.querySelectorAll('[data-course-go]').forEach((b) => { b.onclick = () => {
    buzz(); const id = b.dataset.courseGo;
    // コースを選んだらそのままルートを探す（「ルート候補を探す」を探して押す手間をなくす）
    if (setDest(() => { tour.custom = null; tour.roadId = id; tour.destId = null; }) && navigator.onLine !== false) { const g = $('#route-go'); if (g && !g.disabled) g.click(); }
  }; });
  el.querySelectorAll('[data-course-add]').forEach((b) => { b.onclick = () => {
    buzz(); const id = b.dataset.courseAdd, d = chainDraft();
    if (d.includes(id)) return;
    // 今走ろうとしているコースがあれば、それを 1 本目にする
    const cur = tour.roadId && !String(tour.roadId).startsWith('chain:') && !d.length && tour.roadId !== id ? [tour.roadId] : [];
    store.set('chainDraft', [...cur, ...d, id]);
    b.textContent = '✓ つなげる一覧に入っています';
    renderChainBox();
  }; });
  el.querySelectorAll('[data-pass-go]').forEach((b) => { b.onclick = () => {
    const p = DATA.passes.find((x) => x.id === b.dataset.passGo);
    if (p) { buzz(); setCustomDest(p.points[0][0], p.points[0][1], p.name); }
  }; });
}
// 立ち寄り候補を地図で強調（アイコンを大きく・前に、地図をその場所へ。全画面ならパネルの上に見えるように）
let focusedStop = null;
function focusStop(id) {
  const m = markers.get(id); if (!m || !map) return;
  if (focusedStop && focusedStop !== m) { focusedStop.setZIndexOffset(0); const el = focusedStop.getElement(); if (el) el.classList.remove('pin-hi'); }
  focusedStop = m;
  m.setZIndexOffset(2000);
  const el = m.getElement(); if (el) el.classList.add('pin-hi');
  document.querySelectorAll('.stop.is-focused').forEach((r) => r.classList.remove('is-focused'));
  const row = document.querySelector(`.stop[data-focus="${CSS.escape(id)}"]`); if (row) row.classList.add('is-focused');
  if (document.body.classList.contains('tour-full')) {
    if (sheetSnap === 'high') setSheet('half');
    map.setView(m.getLatLng(), Math.max(map.getZoom(), 12), { animate: false });
    map.panBy([0, Math.round(sheetPx() / 2)], { animate: false });
  } else {
    map.setView(m.getLatLng(), Math.max(map.getZoom(), 12));
    $('#map').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}
// ---- 首都高ルートを組み立てる: 区間を選ぶと、その先の JCT で降りずに直接つながる区間だけを次の候補に出す ----
const SX_MAX = 8; // ルート検索に渡せる経由地の数まで
const sxDraft = () => (store.get('sxDraft') || []).filter(sxSeg);
function renderSxBox() {
  const el = $('#sx-body'); if (!el) return;
  if (!DATA.sx) { el.innerHTML = '<p class="hint">首都高の区間データを読み込めませんでした（電波の良い場所で開き直してください）。</p>'; return; }
  const d = sxDraft(), last = d.length ? sxSeg(d[d.length - 1]) : null;
  const opts = last ? (DATA.sx.next[last.id] || []).map(sxSeg).filter(Boolean) : [];
  const groups = {};
  for (const s of DATA.sx.segs) (groups[s.route] = groups[s.route] || []).push(s);
  const optBtn = (s) => `<button type="button" class="btn sx-opt" data-sx-add="${esc(s.id)}">${esc(s.route)}<small>${esc(sxNode(s.to))}方面</small></button>`;
  el.innerHTML = `${d.length ? `<ol class="chain-list">${d.map((id) => `<li>${esc(sxName(sxSeg(id)))}</li>`).join('')}</ol>` : ''}
    ${!last ? `<details class="help"><summary aria-label="説明を見る">i</summary>走り始める区間（路線と向き）を選んでください。次からは、その先の JCT で高速を降りずに直接つながる区間だけが出ます。</details>
      <select id="sx-start" aria-label="走り始める区間"><option value="">走り始める区間を選ぶ</option>${Object.entries(groups).map(([route, xs]) =>
        `<optgroup label="${esc(route)}">${xs.map((s) => `<option value="${esc(s.id)}">${esc(sxNode(s.from))} → ${esc(sxNode(s.to))}</option>`).join('')}</optgroup>`).join('')}</select>`
      : d.length >= SX_MAX ? `<p class="hint">${SX_MAX}区間までつなげられます。</p>`
      : opts.length ? `<p class="hint"><strong>${esc(sxNode(last.to))}</strong>から次に進む区間：</p><div class="sx-opts">${opts.map(optBtn).join('')}</div>`
      : `<p class="hint">${esc(sxNode(last.to))}から先は、この一覧の首都高の区間につながりません（ここで首都高を出て、家へ向かいます）。</p>`}
    <div class="actions"><button type="button" class="btn primary" id="sx-go" ${d.length ? '' : 'disabled'}>このルートで走る</button>
      <button type="button" class="btn" id="sx-back" ${d.length ? '' : 'disabled'}>1つ戻す</button><button type="button" class="btn" id="sx-clear" ${d.length ? '' : 'disabled'}>やり直す</button></div>
    <details class="help"><summary aria-label="説明を見る">i</summary>JCT で直接つながるかは、ルート検索で前もって確かめています。Google マップに渡す経由地は自動で選ぶので、ナビの前に Google マップの距離がアプリと同じくらいか確かめてください。</details>`;
  const set = (x) => { store.set('sxDraft', x); renderSxBox(); };
  const st = $('#sx-start'); if (st) st.onchange = () => { if (st.value) { buzz(); set([st.value]); } };
  el.querySelectorAll('[data-sx-add]').forEach((b) => { b.onclick = () => { buzz(); set([...sxDraft(), b.dataset.sxAdd]); }; });
  $('#sx-back').onclick = () => { buzz(); set(sxDraft().slice(0, -1)); };
  $('#sx-clear').onclick = () => { buzz(); set([]); };
  $('#sx-go').onclick = () => { buzz(); const ids = sxDraft(); setDest(() => { tour.custom = null; tour.roadId = 'sx:' + ids.join('+'); tour.destId = null; }); };
}
// ---- 複数のコースをつなげる: 一覧（順番の入れ替え・外す）と「この順で走る」 ----
const chainDraft = () => (store.get('chainDraft') || []).filter((id) => roadById1(id));
const chainMode = () => store.get('chainMode') || 'seq';
const chainId = () => 'chain:' + chainDraft().join('+') + (chainMode() === 'seq' ? '' : '@' + chainMode());
const savedChains = () => (store.get('savedChains') || []).filter((c) => roadById(c.id));
const chainName = (id) => (savedChains().find((c) => c.id === id) || {}).name;
function renderChainBox() {
  const el = $('#chain-box'); if (!el) return;
  const d = chainDraft(), saved = savedChains();
  el.hidden = !d.length && !saved.length;
  const savedHtml = saved.length ? `<details class="chain-saved" ${d.length ? '' : 'open'}><summary>💾保存したつなぎコース（${saved.length}件）</summary>
    <ul class="rel">${saved.map((c, i) => `<li><span>${esc(c.name)}</span> <span class="chain-btns"><button type="button" class="btn" data-sc-go="${i}">走る</button>
      <button type="button" class="btn" data-sc-edit="${i}">並べ直す</button><button type="button" class="icon" data-sc-del="${i}" aria-label="削除">✕</button></span></li>`).join('')}</ul></details>` : '';
  const bindSaved = () => {
    el.querySelectorAll('[data-sc-go]').forEach((b) => { b.onclick = () => { buzz(); const c = savedChains()[+b.dataset.scGo]; setDest(() => { tour.custom = null; tour.roadId = c.id; tour.destId = null; }); }; });
    el.querySelectorAll('[data-sc-edit]').forEach((b) => { b.onclick = () => {
      buzz(); const c = savedChains()[+b.dataset.scEdit], [ids, mode] = c.id.slice(6).split('@');
      store.set('chainDraft', ids.split('+')); store.set('chainMode', mode || 'seq'); renderChainBox();
    }; });
    el.querySelectorAll('[data-sc-del]').forEach((b) => { b.onclick = () => {
      buzz(); const c = savedChains()[+b.dataset.scDel];
      if (!confirm(`「${c.name}」を削除しますか？`)) return;
      store.set('savedChains', savedChains().filter((x) => x.id !== c.id)); // 読むたびに別のオブジェクトになるので id で比べる（消えなかった）
      refreshDestOptions(); renderChainBox();
    }; });
  };
  if (!d.length) { el.innerHTML = savedHtml; bindSaved(); return; }
  el.innerHTML = `<strong>🔗つなげて走るコース（${d.length}本・上から順に）</strong>
    <ol class="chain-list">${d.map((id, i) => `<li><span>${esc(roadById1(id).name)}</span>
      <span class="chain-btns"><button type="button" class="icon" data-ch-up="${i}" ${i ? '' : 'disabled'} aria-label="上へ">▲</button>
      <button type="button" class="icon" data-ch-down="${i}" ${i < d.length - 1 ? '' : 'disabled'} aria-label="下へ">▼</button>
      <button type="button" class="icon" data-ch-del="${i}" aria-label="外す">✕</button></span></li>`).join('')}</ol>
    ${d.length >= 2 ? `<fieldset class="chain-mode"><legend>走り方</legend>${Object.entries(Lib.CHAIN_MODES).map(([k, label]) =>
      `<label class="check"><input type="radio" name="chain-mode" value="${k}" ${chainMode() === k ? 'checked' : ''}>${label}</label>`).join('')}
      <details class="help"><summary aria-label="説明を見る">i</summary>「順に1本ずつ一周」は 1 本目を一周してから次へ。「外周」は重なる真ん中の道を通らず、全体の外側をぐるっと回ります。</details></fieldset>` : ''}
    <div class="actions"><button type="button" class="btn primary" id="chain-go" ${d.length >= 2 ? '' : 'disabled'}>${d.length >= 2 ? 'この順で続けて走る' : 'もう1本以上つなげてください'}</button>
      <button type="button" class="btn" id="chain-clear">一覧を空にする</button></div>
    ${d.length >= 2 ? `<div class="chain-save"><input id="chain-name" type="text" placeholder="名前（例：首都高ナイト周回）" aria-label="つなぎコースの名前">
      <button type="button" class="btn" id="chain-save">💾保存</button></div><p class="status" id="chain-msg"></p>` : ''}
    <details class="help"><summary aria-label="説明を見る">i</summary>地図のコースを押して「🔗つなげる」で足せます。起点から1本目へ行き、順に走って起点へ戻ります。</details>${savedHtml}`;
  bindSaved();
  if ($('#chain-save')) $('#chain-save').onclick = () => {
    buzz();
    const id = chainId(), name = $('#chain-name').value.trim() || roadById(id).name;
    store.set('savedChains', [...savedChains().filter((c) => c.id !== id), { id, name }]);
    refreshDestOptions(); renderChainBox();
    const m = $('#chain-msg'); if (m) m.textContent = `「${name}」を保存しました。上の「目的地」からも選べます。`;
  };
  const move = (i, j) => { const x = chainDraft(); [x[i], x[j]] = [x[j], x[i]]; store.set('chainDraft', x); renderChainBox(); };
  el.querySelectorAll('[data-ch-up]').forEach((b) => { b.onclick = () => { buzz(); move(+b.dataset.chUp, +b.dataset.chUp - 1); }; });
  el.querySelectorAll('[data-ch-down]').forEach((b) => { b.onclick = () => { buzz(); move(+b.dataset.chDown, +b.dataset.chDown + 1); }; });
  el.querySelectorAll('[data-ch-del]').forEach((b) => { b.onclick = () => { buzz(); const x = chainDraft(); x.splice(+b.dataset.chDel, 1); store.set('chainDraft', x); renderChainBox(); }; });
  $('#chain-clear').onclick = () => { buzz(); store.set('chainDraft', []); renderChainBox(); };
  el.querySelectorAll('[name="chain-mode"]').forEach((r) => { r.onchange = () => { store.set('chainMode', r.value); }; });
  $('#chain-go').onclick = () => { buzz(); setDest(() => { tour.custom = null; tour.roadId = chainId(); tour.destId = null; }); };
}
// 「目的地」の選択肢の「保存したつなぎコース」を今の保存内容に合わせる（パネル全体は作り直さない）
function refreshDestOptions() {
  const sel = $('#dest'); if (!sel) return;
  let og = [...sel.querySelectorAll('optgroup')].find((g) => g.label === '保存したつなぎコース');
  const saved = savedChains();
  if (!saved.length) { if (og) og.remove(); return; }
  if (!og) { og = document.createElement('optgroup'); og.label = '保存したつなぎコース'; const after = [...sel.querySelectorAll('optgroup')].find((g) => g.label === '登録したルート'); sel.insertBefore(og, after || null); }
  og.innerHTML = saved.map((c) => `<option value="road:${esc(c.id)}" ${c.id === tour.roadId ? 'selected' : ''}>🔗${esc(c.name)}</option>`).join('');
}
// 押したコースの説明は地図の下に出す（吹き出しだと小さい画面で地図が隠れるため）。選んだ線は太くして前に
let courseSel = null;
function clearCourseSel() {
  if (courseSel && courseSel.layer.setStyle) courseSel.layer.setStyle(courseSel.style);
  courseSel = null;
}
function showCourse(r, layer) {
  const el = $('#course-info'); if (!el) return;
  clearCourseSel();
  courseSel = { layer, style: { weight: layer.options.weight, opacity: layer.options.opacity } };
  if (layer.setStyle) { layer.setStyle({ weight: layer.options.weight + 5, opacity: 1 }); layer.bringToFront(); }
  el.innerHTML = `<button type="button" class="icon course-close" aria-label="説明を閉じる">✕</button>${courseHtml(r)}`;
  el.hidden = false;
  el.querySelector('.course-close').onclick = () => { buzz(); el.hidden = true; clearCourseSel(); };
  bindCourseBtns(el);
  if (document.body.classList.contains('tour-full')) {
    if (sheetSnap === 'low' || sheetSnap === 'min') setSheet('half');
    const v = $('#view'); v.scrollTo({ top: el.offsetTop - 40, behavior: 'smooth' });
    return;
  }
  const b = el.getBoundingClientRect();
  if (b.bottom > innerHeight) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
// 種類ごとに色を分け、見せる種類を選べるように。厳選は太く、線は押しやすいように少し太め（押せる幅はさらに広い）
const courseTypesOn = () => new Set(store.get('courseTypes') || Object.keys(Lib.COURSE_TYPES));
// 1 本ずつ少しずつ色を変え、両端に白い丸を付けて、どこからどこまでが 1 本か分かるように
const nightRoads = () => store.get('nightRoads') === true;
const shownRoads = () => DATA.courses.concat(DATA.roads).filter((r) => !nightRoads() || !Lib.roadNightClosed(r));
function drawCourses() {
  courseSel = null; // 地図を作り直したら選択も消える
  const on = courseTypesOn();
  const add = (layer, r) => layer.on('click', (e) => { L.DomEvent.stopPropagation(e); showCourse(r, layer); }).addTo(map);
  for (const r of shownRoads()) {
    const t = Lib.courseType(r); if (!on.has(t)) continue;
    const color = Lib.routeShade(Lib.COURSE_TYPES[t][1], r.id), pick = t === 'pick', glow = nightRoads() && Lib.roadNightView(r);
    const w = pick || glow ? 7 : 5;
    const ll = r.line || r.points;
    const line = L.polyline(ll, { color, weight: w, opacity: pick ? 0.95 : 0.8, dashArray: t === 'rindo' ? '6 6' : null });
    line.on('mouseover', () => line.setStyle({ weight: w + 3 })).on('mouseout', () => { if (!courseSel || courseSel.layer !== line) line.setStyle({ weight: w }); });
    add(line, r);
    for (const p of [ll[0], ll[ll.length - 1]]) {
      // 地図と同じキャンバスに描く（別のキャンバスを重ねると、その下のコースの線が押せなくなる）
      L.circleMarker(p, { radius: pick ? 4 : 3, color, weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(map);
    }
  }
  if (on.has('pass')) {
    const passIcon = L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13], html: '<span class="pin pass">⛰</span>' });
    // 峠は数が多い（600か所超）ので、引いた地図では出さず、ズーム11以上で見えている範囲だけ
    const layer = L.layerGroup().addTo(map);
    const refresh = () => {
      layer.clearLayers();
      if (map.getZoom() < 11) return;
      const b = map.getBounds().pad(0.2);
      for (const p of DATA.passes) if (b.contains(p.points[0])) layer.addLayer(L.marker(p.points[0], { icon: passIcon, title: p.name }).on('click', (e) => { L.DomEvent.stopPropagation(e); showCourse(p, e.target); }));
    };
    map.on('moveend zoomend', refresh);
    refresh();
  }
}
// 凡例（押すとその種類を出す・隠す）。本数つき
function courseLegendHtml() {
  const on = courseTypesOn(), n = {};
  for (const r of shownRoads().concat(DATA.passes)) { const t = Lib.courseType(r); n[t] = (n[t] || 0) + 1; }
  return `<div class="chips wrap course-legend" aria-label="ドライブコースの種類">${Object.entries(Lib.COURSE_TYPES).filter(([t]) => n[t]).map(([t, [label, color]]) =>
    `<button type="button" class="chip" data-ctype="${t}" aria-pressed="${on.has(t)}"><span class="swatch${t === 'rindo' ? ' dash' : ''}${t === 'pass' ? ' dot' : ''}" style="--c:${color}"></span>${esc(label)}（${n[t].toLocaleString()}）</button>`).join('')}
    <button type="button" class="chip" data-ctype="__pick">★おすすめだけ</button><button type="button" class="chip" data-ctype="__all">すべて</button>
    <button type="button" class="chip" data-ctype="__night" aria-pressed="${nightRoads()}">🌙夜も走れる道だけ</button></div>
    ${nightRoads() ? '<details class="help"><summary aria-label="説明を見る">i</summary>夜間通行止めと分かっている道を外し、夜景の道を太く表示しています（自動収集の道は夜間の規制の情報がないので、現地の表示を確認してください）。両端の白い丸がコースの始まりと終わりです。</details>' : '<p class="hint">線は 1 本ずつ少しずつ色を変えています。両端の白い丸がコースの始まりと終わりです。</p>'}`;
}
function bindCourseLegend() {
  document.querySelectorAll('[data-ctype]').forEach((b) => { b.onclick = () => {
    buzz();
    const t = b.dataset.ctype;
    let on = courseTypesOn();
    if (t === '__night') { store.set('nightRoads', !nightRoads()); tour.key = ''; renderTouring(); return; }
    if (t === '__all') on = new Set(Object.keys(Lib.COURSE_TYPES));
    else if (t === '__pick') on = new Set(['pick']);
    else if (on.has(t)) on.delete(t); else on.add(t);
    store.set('courseTypes', [...on]); tour.key = ''; renderTouring();
  }; });
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
  if (!DATA.cfg) return;
  setCount(null);
  const prevToken = $('#token'), typed = prevToken ? prevToken.value : '', focused = document.activeElement === prevToken;
  $('#view').innerHTML = `<h2>表示</h2>
    <fieldset class="opts"><legend><strong>画面のデザイン</strong></legend>
      <label class="check"><input type="radio" name="theme" value="stylish" ${document.documentElement.dataset.theme === 'stylish' ? 'checked' : ''}>スタイリッシュ（グラデーション・丸みのあるカード。端末がダークモードなら暗い配色）</label>
      <label class="check"><input type="radio" name="theme" value="standard" ${document.documentElement.dataset.theme !== 'stylish' ? 'checked' : ''}>標準（デジタル庁デザインシステムに沿った、はっきりした表示）</label></fieldset>
    <label class="check"><input type="checkbox" id="set-outdoor" ${document.documentElement.hasAttribute('data-outdoor') ? 'checked' : ''}>屋外モード（日なた・グローブ向けに大きく太く表示。屋外モード中は標準の配色）</label>
    <details class="help"><summary aria-label="説明を見る">i</summary>画面上の「☀屋外」でも切り替えられます。ツーリングタブを開くと自動でオンになります。</details>
    ${installHtml()}
    <h2>起点</h2>
    <p class="status">今の起点：<strong>${esc(DATA.cfg.origin.name)}</strong>（移動時間・ルートはここから計算）</p>
    <div class="actions"><button type="button" class="btn" id="origin-here">現在地を起点にする</button>
      ${store.get('origin') ? `<button type="button" class="btn" id="origin-reset">${esc(CFG_ORIGIN.name)}に戻す</button>` : ''}</div>
    <form class="row" id="origin-form"><input type="search" id="origin-q" placeholder="駅名・地名で探す（例：大阪駅、札幌市）" aria-label="起点にする場所">
      <button type="submit" class="btn">探す</button></form>
    <div id="origin-results"></div>
    <details class="help"><summary aria-label="説明を見る">i</summary>全国で使えます。旅行先など、ほかの場所から出かける予定を立てるときは、その場所を起点にしてください（その地方のスポットやグルメを読み込み直します）。</details>
    ${costSettingsHtml()}
    <h2>行った場所の記録</h2>${visitedHtml()}
    <h2>お気に入りの共有</h2>
    <p class="hint">⭐お気に入り（${state.favs.size}件）を 1 本のリンクにして家族に送れます。相手がリンクを開くと、その端末のお気に入りに追加されます。</p>
    <div class="actions"><button type="button" class="btn" id="fav-share" ${state.favs.size ? '' : 'disabled'}>⭐お気に入りを共有</button></div>
    <h2>好きなジャンル</h2><details class="help"><summary aria-label="説明を見る">i</summary>今週末のおすすめに優先して出します。</details><div id="fav-genres" class="chips" style="flex-wrap:wrap"></div>
    <h2>Google マップの写真（任意）</h2>
    <details class="help"><summary aria-label="説明を見る">i</summary>Wikipedia・Wikimedia Commons で写真が見つからない場所も多いので、ご自身の Google の API キー（Places API (New)）を入れると「▼詳しく」と地図の吹き出しに Google マップの写真を出します。キーはこの端末の中にだけ保存します。</details>
    <details><summary>キーの作り方（クレジットカードの登録が必要。個人で使う程度なら無料枠の範囲）</summary><ol class="hint">
      <li>Google Cloud コンソール（console.cloud.google.com）でプロジェクトを作り、お支払い（請求先アカウント）を設定</li>
      <li>「API とサービス」→「ライブラリ」で <strong>Places API (New)</strong> を有効にする</li>
      <li>「認証情報」→「API キーを作成」</li>
      <li>キーの制限：アプリケーションの制限は「ウェブサイト」で <code>${esc(location.origin)}/*</code>、API の制限は「Places API (New)」だけ</li>
      <li>念のため「お支払い」→「予算とアラート」で少額の予算アラートを設定（無料枠を超えると課金されます）</li></ol></details>
    <p class="status">状態：${store.get('gkey') ? '登録済み' : '未登録'}</p>
    <input id="gkey" type="password" autocomplete="off" placeholder="AIza..." aria-label="Google の API キー">
    <div class="actions"><button type="button" class="btn primary" id="gkey-save">保存</button><button type="button" class="btn" id="gkey-del">削除</button></div>
    ${updateHtml()}
    <h2>収録しているデータ</h2>${dataTotalsHtml()}
    <h2>収集状況</h2>${statusHtml()}`;
  const el = $('#fav-genres');
  el.innerHTML = Object.entries(GENRES).map(([g, l]) => `<button type="button" class="chip" data-g="${g}" aria-pressed="${state.favGenres.has(g)}">${l}</button>`).join('');
  el.onclick = (e) => { const b = e.target.closest('.chip'); if (b) { buzz(); toggle(state.favGenres, b.dataset.g); store.set('favGenres', [...state.favGenres]); renderAll(); } };
  $('#set-outdoor').onchange = (e) => setOutdoor(e.target.checked);
  document.querySelectorAll('input[name="theme"]').forEach((r) => { r.onchange = () => { buzz(); setTheme(r.value); }; });
  if (typed) $('#token').value = typed;
  if (focused) $('#token').focus();
  bindUpdate();
  bindInstall();
  bindCostSettings();
  $('#gkey-save').onclick = () => { const v = $('#gkey').value.trim(); if (v) { store.set('gkey', v); renderSettings(); } };
  $('#gkey-del').onclick = () => { store.set('gkey', null); renderSettings(); };
  $('#origin-here').onclick = () => {
    if (!navigator.geolocation) { alert('この端末では現在地を使えません。'); return; }
    navigator.geolocation.getCurrentPosition((p) => {
      setOrigin({ name: '現在地', lat: +p.coords.latitude.toFixed(5), lon: +p.coords.longitude.toFixed(5) });
    }, () => alert('現在地を取得できませんでした（位置情報の許可を確認してください）。'), { enableHighAccuracy: true, timeout: 10000 });
  };
  const or = $('#origin-reset'); if (or) or.onclick = () => setOrigin(null);
  // 駅名・地名で探して起点にする（国土地理院の地名検索）
  $('#origin-form').onsubmit = async (e) => {
    e.preventDefault();
    const q = $('#origin-q').value.trim(); if (!q) return;
    $('#origin-results').innerHTML = '<p class="hint">探しています…</p>';
    let box = null;
    // 検索の間に設定タブが作り直される（起点を変えたあとの読み込みが終わったときなど）ので、書き込む先は検索のあとで取り直す
    const target = () => { box = $('#origin-results'); if (box && !$('#origin-q').value) $('#origin-q').value = q; return box; };
    try {
      const r = await fetch(Lib.gsiSearchUrl(q), { signal: timeoutSignal(8000) });
      const xs = r.ok ? Lib.parseGsi(await r.json(), 6) : [];
      if (!target()) return; // 設定タブを離れた
      box.innerHTML = xs.length ? `<div class="actions">${xs.map((x, i) => `<button type="button" class="btn" data-origin-pick="${i}">${esc(x.name)}</button>`).join('')}</div>`
        : '<p class="hint">見つかりませんでした。別の書き方（例：「〇〇駅」「〇〇市」）でも試してください。</p>';
      box.querySelectorAll('[data-origin-pick]').forEach((b) => { b.onclick = () => setOrigin(xs[+b.dataset.originPick]); });
    } catch { if (target()) box.innerHTML = '<p class="hint">検索できませんでした（圏外の可能性があります）。</p>'; }
  };
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
  // 出発地が変わると、引いたルートと選んだ立ち寄りは使えない（保存も消す。消さないと開き直したときに前の地方のルートが出る）
  tour.cands = null; tour.stops = null; tour.key = ''; tour.picked.clear(); tour.kept = []; DATA.ver++;
  saveTour();
  // 天気も新しい起点で取り直す（週末プランは renderAll → renderRecommend が取りに行く）
  state.weatherRainy = false; $('#weather').dataset.text = ''; WPLAN.loaded = false; WPLAN.days = null; loadWeather();
  buzz(); renderAll();
  // 遠くへ移したときは、その地方のデータに読み替える（全国のデータから起点の近くだけ読んでいるため）
  DATA.osmLoaded = false;
  reloadArea().then(renderAll);
}
function visitedRecords() {
  const meta = store.get('visitedMeta') || {};
  const byId = new Map(DATA.spots.concat(DATA.osm).map((s) => [s.id, s]));
  return [...state.visited].map((id) => meta[id] || byId.get(id)).filter((r) => r && r.lat != null);
}
function visitedHtml() {
  const recs = visitedRecords();
  if (!recs.length) return '<details class="help"><summary aria-label="説明を見る">i</summary>スポットの「▼詳しく」→「行った」を押すと、ここに地図と都県ごとの数が出ます。</details>';
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

// ---- アプリの入れ方（ほかの人・ほかの端末） ----
// Android の Chrome などは「インストール」の確認画面をアプリから出せる（beforeinstallprompt）
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; renderInstallBanner(); if (state.tab === 'settings') renderSettings(); });
window.addEventListener('appinstalled', () => { installEvt = null; store.set('installDismissed', true); renderInstallBanner(); });
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const appUrl = () => `${location.origin}${location.pathname.replace(/index\.html$/, '')}`;
const INSTALL_STEPS = {
  'ios-safari': '画面下の <strong>共有ボタン（□に↑）</strong> → 下に少し動かして <strong>「ホーム画面に追加」</strong> → 右上の <strong>「追加」</strong>',
  'ios-other': 'この画面は LINE などのアプリの中か、Safari 以外のブラウザです。右下などの <strong>「Safari で開く」</strong>（またはリンクを長押しして「Safari で開く」）にしてから、共有ボタン → 「ホーム画面に追加」。iOS 16.4 以降は Chrome の共有ボタンからも追加できます',
  android: '右上の <strong>︙（メニュー）</strong> → <strong>「アプリをインストール」</strong>（または「ホーム画面に追加」）',
  'android-inapp': 'この画面は LINE などのアプリの中です。右上の︙から <strong>「ブラウザで開く」</strong>（Chrome）にしてから、︙ → 「アプリをインストール」',
  desktop: 'Chrome / Edge の場合、アドレスバーの右にある <strong>インストールのアイコン（⊕ や □↓）</strong>、またはメニュー → 「アプリをインストール」。スマホへは下の QR コードで',
};
function renderInstallBanner() {
  const el = $('#install-banner'); if (!el) return;
  const pf = Lib.platformOf(navigator.userAgent, isStandalone());
  // スマホで、まだホーム画面に入れていない、閉じていない人にだけ
  if (pf === 'installed' || pf === 'desktop' || store.get('installDismissed')) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<p><strong>📲 ホーム画面に追加すると、アプリのように使えます</strong>（無料・登録不要。圏外でも前に見たデータを表示）</p>
    ${installEvt ? '<div class="actions"><button type="button" class="btn primary" id="install-go">ホーム画面に追加する</button></div>' : `<p class="hint">${INSTALL_STEPS[pf]}</p>`}
    <div class="actions"><button type="button" class="btn" id="install-later">あとで</button><button type="button" class="btn" id="install-never">今後は出さない</button></div>`;
  const go = $('#install-go'); if (go) go.onclick = async () => { buzz(); installEvt.prompt(); await installEvt.userChoice.catch(() => null); installEvt = null; renderInstallBanner(); };
  $('#install-later').onclick = () => { el.hidden = true; };
  $('#install-never').onclick = () => { store.set('installDismissed', true); el.hidden = true; };
}
// QR コード（cdnjs の qrcode-generator を設定タブを開いたときだけ読み込む。圏外なら URL だけ）
let qrLib = null;
function loadQr() {
  if (qrLib) return qrLib;
  qrLib = new Promise((ok, ng) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
    sc.onload = () => ok(window.qrcode); sc.onerror = () => { qrLib = null; ng(new Error('qr')); };
    document.head.appendChild(sc);
  });
  return qrLib;
}
async function drawQr(el, text) {
  try {
    const qrcode = await loadQr();
    const q = qrcode(0, 'M'); q.addData(text); q.make();
    el.innerHTML = q.createSvgTag({ cellSize: 5, margin: 3, scalable: true });
  } catch { el.innerHTML = '<p class="hint">QR コードを表示できませんでした（圏外の可能性）。下のリンクを送ってください。</p>'; }
}
function installHtml() {
  const pf = Lib.platformOf(navigator.userAgent, isStandalone());
  return `<h2>ほかの端末・家族に入れる</h2>
    <p class="hint">このアプリはアプリストアではなく、<strong>リンクを開いて「ホーム画面に追加」</strong>するだけで入ります（無料・登録不要・Android / iPhone / パソコン）。お気に入り・行った記録・プランは端末ごとに別々です（お気に入りは「お気に入りの共有」で送れます）。</p>
    <div class="install-share"><div id="install-qr" class="qr" aria-label="このアプリの QR コード"></div>
      <div><p><a href="${esc(appUrl())}">${esc(appUrl())}</a></p>
      <div class="actions"><button type="button" class="btn primary" id="install-share">リンクを送る（LINE など）</button><button type="button" class="btn" id="install-copy">リンクをコピー</button></div>
      ${installEvt ? '<div class="actions"><button type="button" class="btn" id="install-here">この端末にインストール</button></div>' : ''}
      <p class="status">この端末：${pf === 'installed' ? '✓ ホーム画面のアプリとして開いています' : 'ブラウザで開いています'}</p></div></div>
    <details><summary>端末ごとの入れ方</summary><dl class="install-steps">
      <dt>iPhone / iPad</dt><dd>リンクを <strong>Safari</strong> で開く → ${INSTALL_STEPS['ios-safari']}。LINE などで開いた場合は、まず「Safari で開く」</dd>
      <dt>Android</dt><dd>リンクを <strong>Chrome</strong> で開く → ${INSTALL_STEPS.android}。LINE などで開いた場合は、まず「ブラウザで開く」</dd>
      <dt>パソコン</dt><dd>${INSTALL_STEPS.desktop}</dd>
      <dt>入れたあと</dt><dd>位置情報（現在地・近くの○○・走行記録）を使うときに許可を求められます。トークン・API キーの設定は不要です（データの更新は持ち主の設定で自動）</dd></dl></details>`;
}
function bindInstall() {
  drawQr($('#install-qr'), appUrl());
  $('#install-share').onclick = () => shareText('MyMap 休日おでかけ', '休日のおでかけ先・グルメ・ツーリングルートを探せるアプリ。開いて「ホーム画面に追加」で使えます。', appUrl());
  $('#install-copy').onclick = async () => { try { await navigator.clipboard.writeText(appUrl()); alert('コピーしました。'); } catch { prompt('このリンクをコピーしてください', appUrl()); } };
  const ih = $('#install-here'); if (ih) ih.onclick = async () => { installEvt.prompt(); await installEvt.userChoice.catch(() => null); installEvt = null; renderSettings(); };
}

// ---- 交通費の設定（端末に保存） ----
const COST_DEFAULT = { car: 15, bike: 30, price: 170 };
const costCfg = () => ({ ...COST_DEFAULT, ...(store.get('cost') || {}) });
// ルートの交通費（片道・周回はそのまま）。バイク向けなら二輪の燃費と軽・二輪の高速料金
function routeCostText(rt, loop, bike) {
  const c = costCfg(), kmpl = bike ? c.bike : c.car;
  const fuel = Lib.fuelCost(rt.km, kmpl, c.price);
  const toll = rt.tollKm != null ? Lib.tollEstimate(rt.tollKm, bike ? 'light' : 'normal') : null;
  const one = fuel + (toll || 0), times = loop ? 1 : 2;
  return `💴 交通費の目安：ガソリン ${Lib.yen(fuel)}（${bike ? 'バイク' : '車'} ${kmpl}km/L・${c.price}円/L）`
    + (toll == null ? '・高速料金はこの経路では計算できません' : toll ? `・高速 約${Lib.yen(toll)}（有料区間 約${Math.round(rt.tollKm)}km・${bike ? '軽・二輪' : '普通車'}）` : '・高速料金なし')
    + `${loop ? '' : `／往復 約${Lib.yen(one * times)}（帰りも同じ道として）`}`;
}
function costSettingsHtml() {
  const c = costCfg();
  return `<h2>交通費の計算</h2>
    <div class="cost-form"><label>車の燃費 <input type="number" inputmode="decimal" min="1" max="60" step="0.5" id="cost-car" value="${c.car}"> km/L</label>
      <label>バイクの燃費 <input type="number" inputmode="decimal" min="1" max="80" step="0.5" id="cost-bike" value="${c.bike}"> km/L</label>
      <label>ガソリン単価 <input type="number" inputmode="numeric" min="50" max="400" step="1" id="cost-price" value="${c.price}"> 円/L</label></div>
    <details class="help"><summary aria-label="説明を見る">i</summary>ツーリングのルートと日帰りプラン・「詳しく」に、ガソリン代・高速料金・電車の運賃の目安を出します。高速料金は NEXCO の普通区間の料金の式で概算（首都高・大都市近郊区間・ETC 割引は反映しません）、電車は JR の運賃表で直線距離から概算です。正確な額は Google マップの経路で確認してください。</details>`;
}
function bindCostSettings() {
  for (const k of ['car', 'bike', 'price']) {
    $(`#cost-${k}`).onchange = (e) => { const v = Number(e.target.value); if (v > 0) { store.set('cost', { ...costCfg(), [k]: v }); tour.key = ''; } };
  }
}

// ---- タブと全体描画 ----
const RENDER = { spots: renderSpots, events: renderEvents, touring: renderTouring, settings: renderSettings };
function goTab(t) {
  // ツーリングタブを開いたら屋外モードを自動でオン（手動で切った後も、次に開いたときは再びオン）
  if (t === 'touring' && state.tab !== 'touring' && !tourFull()) setOutdoor(true, false); // 自動の ON は保存しない（手動の設定を上書きしない）。全画面の地図では文字を小さく
  if (t !== 'touring' && state.tab === 'touring') setOutdoor(!!store.get('outdoor'), false); // ほかのタブに戻ったら自分の設定に戻す
  state.tab = t; store.set('tab', t); window.scrollTo(0, 0); renderAll();
}
document.querySelector('.tabs').onclick = (e) => {
  const b = e.target.closest('[data-tab]'); if (!b) return;
  buzz(); goTab(b.dataset.tab);
};
function renderAll() {
  if (!DATA.cfg) return; // config.json を読めなかった（圏外で開いた）ときは、その案内を出したままにする
  document.body.dataset.tab = state.tab;
  if (state.tab !== 'touring') {
    document.body.classList.remove('tour-full', 'drawer-open'); $('#tour-top').hidden = true; document.querySelectorAll('body > .tour-drawer').forEach((e) => e.remove());
    // 通常の表示では地図がパネルの中にあり、下で消える。地図のオブジェクトだけ残ると、あとで動かしたときにエラーになる
    if (map && $('#view #map')) { try { map.remove(); } catch { /* 既に消えている */ } map = null; }
  }
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
  if (state.tab === 'touring' && !tourFull()) setOutdoor(true, false);
  $('#filters').open = !!store.get('filtersOpen');
  $('#rec').open = store.get('recOpen') === true;
  DATA.cfg = await getJSON('config.json', null);
  if (!DATA.cfg) { renderLoadMsg(); $('#view').innerHTML = '<p class="empty">config.json を読み込めません。電波の良い場所で開き直してください。</p>'; return; }
  CFG_ORIGIN = DATA.cfg.origin;
  // ホーム画面のショートカットから開いたとき
  const lp = Lib.launchParams(location.search);
  if (lp.tab || lp.q || lp.gacha) {
    if (lp.tab && lp.tab !== state.tab) { if (lp.tab === 'touring' && !tourFull()) setOutdoor(true, false); state.tab = lp.tab; }
    if (lp.q) { state.tab = 'spots'; state.q = lp.q; }
    if (lp.gacha) { state.tab = 'spots'; state.pendingGacha = true; }
    history.replaceState(null, '', location.pathname);
  }
  // 共有されたお気に入りのリンク（#favs=id,id,...）
  const fm = location.hash.match(/^#favs=(.+)$/);
  if (fm) {
    const ids = decodeURIComponent(fm[1]).split(',').filter(Boolean).slice(0, 500);
    if (ids.length && confirm(`共有されたお気に入り ${ids.length}件を、この端末のお気に入りに追加しますか？`)) {
      ids.forEach((id) => state.favs.add(id)); store.set('favs', [...state.favs]);
    }
    history.replaceState(null, '', location.pathname);
  }
  if (store.get('origin')) {
    DATA.cfg.origin = store.get('origin');
    const mp = store.get('mainPrefs');
    if (mp && mp.at === originKey(DATA.cfg.origin)) setPrefs(mp.list);
  }
  // 先にスポットを出し、イベントなどは後から読み込む
  let onsen;
  [DATA.spots, DATA.touring, DATA.status, DATA.roads, DATA.sx, onsen] = await Promise.all([
    getJSON('data/spots.json', []), getJSON('data/touring.json', []), getJSON('data/status.json', null, 'no-store'),
    getJSON('data/scenic_roads.json', []), getJSON('data/shutoko_net.json', null), getJSON('data/onsen_areas.json', [])]);
  DATA.issues = await getJSON('data/route_issues.json', DATA.issues); // 全コースのルート検索で確かめた結果（往復・Uターンが残るコース）
  DATA.spots.forEach(Lib.refineGenres);
  // 全国の温泉地（小さいので全部読む）。★厳選と同じ場所は除く。地方ごとのデータ（DATA.osm）に足して、一覧・検索・立ち寄りに出す
  DATA.onsen = Lib.dropSameName(onsen.map(Lib.onsenSpot), DATA.spots);
  DATA.osm = withOnsen([]);
  renderAll();
  renderInstallBanner();
  loadWeather();
  requestUpdate();
  let lines, pois;
  const seq0 = areaSeq; // 読み込む間に起点を変えたら（reloadArea が新しい地方を読む）、ここで読んだ分は使わない
  [pois, DATA.events, lines] = await Promise.all([loadArea('pois'), getJSON('data/events.json', []), getJSON('data/course_lines.json', {})]);
  if (seq0 === areaSeq) DATA.pois = pois;
  // 地図に描くコースの線は、コースの点を直線で結ばず、実際に道を通した形（ルート検索で作ったもの）にする
  for (const r of DATA.roads) if (lines[r.id]) r.line = Lib.decodePolyline(lines[r.id], 5).map(([lon, lat]) => [lat, lon]);
  DATA.eventsLoaded = true; DATA.ver++; tour.stops = null;
  cellIndex = await getJSON('data/cells/index.json', null);
  FAILED.delete('data/cells/index.json'); // まだ収集していないとき（404）は失敗扱いにしない
  const ro = await loadArea('roads');
  if (seq0 === areaSeq) setRoads(ro);
  DATA.ver++; tour.stops = null; // 升目の目録がそろったので、立ち寄りのカフェ・ごはんを読み込める
  renderAll();
  // 自動収集スポットは大きい（数 MB）ので最後に読み込む
  const osm = await loadArea('spots');
  if (seq0 !== areaSeq) return; // 起点を変えた・データを更新した読み直しのほうで osmLoaded にする
  osm.forEach(Lib.refineGenres);
  DATA.osm = withOnsen(osm);
  updateMainPrefs();
  DATA.osmLoaded = true; DATA.ver++; tour.stops = null; // 立ち寄りの観光名所・温泉・展望台にも使う
  renderAll();
}
init();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* 非対応でも動く */ });
