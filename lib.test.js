// node lib.test.js で実行する自己チェック
const assert = require('assert');
const Lib = require('./lib.js');

const cfg = { origin: { lat: 35.6518, lon: 139.5440 }, speedsKmh: { train: 30, car: 25, bike: 25, bicycle: 12 }, trainOverheadMin: 10 };

// 距離と移動時間（調布駅→新宿駅はおよそ 14.8km）
const km = Lib.haversineKm(cfg.origin, { lat: 35.6896, lon: 139.7006 });
assert(km > 14 && km < 15.5, km);
assert.strictEqual(Lib.travelMinutes(30, 'car', cfg), 72);
assert.strictEqual(Lib.travelMinutes(15, 'train', cfg), 40);
assert.strictEqual(Lib.prefGroup('群馬'), 'その他');
assert.strictEqual(Lib.prefGroup('神奈川'), '神奈川');
assert.strictEqual(Lib.prefGroup(null), null);

// スポットの絞り込み（a:約1km, b:約7km, c:箱根 約61km, d:群馬 約78km）
const spots = [
  { id: 'a', name: 'A', lat: 35.66, lon: 139.55, pref: '東京', genres: ['museum'], indoor: true },
  { id: 'b', name: 'B', lat: 35.70, lon: 139.60, pref: '東京', genres: ['garden'], indoor: false },
  { id: 'c', name: 'C', lat: 35.23, lon: 139.10, pref: '神奈川', genres: ['onsen'], indoor: true },
  { id: 'd', name: 'D', lat: 36.30, lon: 139.20, pref: '群馬', genres: ['scenic'], indoor: false },
];
const f = (o) => ({ mode: 'car', maxMin: null, prefs: new Set(), genres: new Set(), rainy: false, ...o });
const ids = (xs) => xs.map((x) => x.id);
assert.deepStrictEqual(ids(Lib.filterSpots(spots, f({}), cfg)), ['a', 'b', 'c', 'd']);
assert.deepStrictEqual(ids(Lib.filterSpots(spots, f({ rainy: true }), cfg)), ['a', 'c']);
assert.deepStrictEqual(ids(Lib.filterSpots(spots, f({ maxMin: 30 }), cfg)), ['a', 'b']);
assert.deepStrictEqual(ids(Lib.filterSpots(spots, f({ prefs: new Set(['その他']) }), cfg)), ['d']);
assert.deepStrictEqual(ids(Lib.filterSpots(spots, f({ genres: new Set(['onsen', 'museum']) }), cfg)), ['a', 'c']);
// 都県が不明（OSM の POI）は都県フィルタで消さない
assert.strictEqual(Lib.filterSpots([{ ...spots[0], pref: null }], f({ prefs: new Set(['千葉']) }), cfg).length, 1);
assert.strictEqual(Lib.filterSpots(spots, f({}), cfg)[0].minutes, 3);

// イベントの絞り込み
const events = [
  { id: 'e1', title: 'x', start: '2026-10-10', end: '2026-10-10', lat: null, lon: null, pref: '東京', indoor: null },
  { id: 'e2', title: 'y', start: '2026-10-01', end: '2026-10-31', lat: 35.66, lon: 139.55, pref: '東京', indoor: false },
  { id: 'e3', title: 'z', start: '2026-11-01', end: '2026-11-01', lat: 35.66, lon: 139.55, pref: '東京', indoor: true },
];
// 長期（3日超）の e2 より、その日だけの e1 を先に
assert.deepStrictEqual(ids(Lib.filterEvents(events, f({}), cfg, '2026-10-10', '2026-10-11')), ['e1', 'e2']);
assert.deepStrictEqual(ids(Lib.filterEvents(events, f({ rainy: true }), cfg, '2026-10-10', '2026-10-11')), ['e1']);
assert.deepStrictEqual(ids(Lib.filterEvents(events, f({ maxMin: 1 }), cfg, '2026-10-10', '2026-10-11')), ['e1']);
assert.strictEqual(Lib.filterEvents(events, f({}), cfg, '2026-10-10', '2026-10-11')[0].minutes, null);

// ルートまでの距離（東西にまっすぐな約 9km の線）
const line = [[139.50, 35.65], [139.55, 35.65], [139.60, 35.65]];
const r = Lib.distToRoute({ lat: 35.66, lon: 139.55 }, line);
assert(Math.abs(r.km - 1.106) < 0.02, r.km);
assert(Math.abs(r.along - 4.52) < 0.05, r.along);
assert.strictEqual(Lib.distToRoute({ lat: 35.66, lon: 139.55 }, [[139.5, 35.65]]).km, Infinity);
const stops = Lib.stopsAlongRoute(
  [{ id: 'n', lat: 35.66, lon: 139.58 }, { id: 'm', lat: 35.651, lon: 139.52 }, { id: 'far', lat: 35.70, lon: 139.55 }], line, 3);
assert.deepStrictEqual(ids(stops), ['m', 'n']);

// おすすめ（c=温泉+屋内+未訪問=5, a=屋内=2, b/d=未訪問=1）
const ctx = { favGenres: new Set(['onsen']), rainy: true, visited: new Set(['a']) };
const rec = Lib.pickRecommendations(spots, ctx, 1);
assert.deepStrictEqual(ids(rec).slice(0, 2), ['c', 'a']);
assert.strictEqual(rec.length, 3);
assert.deepStrictEqual(ids(Lib.pickRecommendations(spots, ctx, 7)), ids(Lib.pickRecommendations(spots, ctx, 7)));
assert.strictEqual(Lib.pickRecommendations([{ ...spots[0], id: 'a2' }, spots[0]], ctx, 1).length, 1);
assert.strictEqual(Lib.weekSeed(new Date('2026-10-12T12:00:00Z')), Lib.weekSeed(new Date('2026-10-18T12:00:00Z')));
assert.strictEqual(Lib.weekSeed(new Date('2026-10-19T12:00:00Z')), Lib.weekSeed(new Date('2026-10-12T12:00:00Z')) + 1);

// URL
const sns = Lib.snsLinks({ name: '京王 れーるランド' });
assert(sns.instagram.endsWith(encodeURIComponent('京王れーるランド') + '/'), sns.instagram);
assert(sns.x.includes('%23'), sns.x);
assert.strictEqual(Lib.snsLinks({ name: 'x', tags: ['深大寺'] }).x, 'https://x.com/search?q=' + encodeURIComponent('#深大寺'));
const wps = Array.from({ length: 10 }, (_, i) => ({ lat: 35 + i / 100, lon: 139 }));
const g = Lib.gmapsDirUrl(cfg.origin, { lat: 35.7, lon: 139.0 }, wps);
assert.strictEqual((g.match(/%7C/g) || []).length, 8);
assert(g.startsWith('https://www.google.com/maps/dir/?api=1&origin=35.6518,139.544&destination=35.7,139&travelmode=driving'), g);

// 日付
assert.deepStrictEqual(Lib.weekend(new Date(2026, 9, 8)), ['2026-10-10', '2026-10-11']);
assert.deepStrictEqual(Lib.weekend(new Date(2026, 9, 11)), ['2026-10-10', '2026-10-11']);
assert.deepStrictEqual(Lib.weekend(new Date(2026, 9, 8), 1), ['2026-10-17', '2026-10-18']);
assert.deepStrictEqual(Lib.periodRange('month', new Date(2026, 9, 8)), ['2026-10-08', '2026-10-31']);
assert.deepStrictEqual(Lib.periodRange('3m', new Date(2026, 9, 8)), ['2026-10-08', '2027-01-08']);
assert.strictEqual(Lib.isStale(null, 0, 24), true);
assert.strictEqual(Lib.isStale('2026-10-08T00:00:00Z', Date.parse('2026-10-08T23:00:00Z'), 24), false);
assert.strictEqual(Lib.isStale('2026-10-08T00:00:00Z', Date.parse('2026-10-09T01:00:00Z'), 24), true);

// ---- 第1弾 ----
// 並び順: 厳選・⭐（段0）→ url/wp あり（段1）→ その他（段2）、同じ段は近い順
const tiered = [
  { id: 'osm:node:1', name: '近いOSM', lat: 35.652, lon: 139.545, genres: ['play'], indoor: false, url: '' },
  { id: 'osm:node:2', name: 'WikiありOSM', lat: 35.70, lon: 139.60, genres: ['museum'], indoor: true, url: 'https://ja.wikipedia.org/wiki/x' },
  { id: 'cur', name: '厳選', lat: 35.75, lon: 139.70, genres: ['museum'], indoor: true, url: 'https://x' },
  { id: 'osm:node:3', name: '⭐OSM', lat: 35.80, lon: 139.80, genres: ['temple'], indoor: false, url: '' },
  { id: 'poi:x', poi: true, name: 'POI', lat: 35.66, lon: 139.55, genres: ['scenic'], indoor: false, url: '' },
];
assert.deepStrictEqual(ids(Lib.filterSpots(tiered, f({ favs: new Set(['osm:node:3']) }), cfg)),
  ['cur', 'osm:node:3', 'osm:node:2', 'osm:node:1', 'poi:x']);
assert.strictEqual(Lib.tierOf({ id: 'osm:node:9', wp: 'ja:深大寺' }, new Set()), 1);

// 方面（起点からの8方位）
assert.strictEqual(Lib.direction(cfg.origin, { lat: 35.80, lon: 139.544 }), 'N');
assert.strictEqual(Lib.direction(cfg.origin, { lat: 35.65, lon: 139.20 }), 'W');
assert.strictEqual(Lib.direction(cfg.origin, { lat: 35.30, lon: 139.10 }), 'SW');
assert.strictEqual(Lib.direction(cfg.origin, { lat: 35.65, lon: 140.00 }), 'E');
assert.deepStrictEqual(ids(Lib.filterSpots(spots, f({ dirs: new Set(['SW']) }), cfg)), ['c']);

// 名前検索の正規化（NFKC・カタカナ→ひらがな・空白除去・小文字）
assert.strictEqual(Lib.norm('ＪＡＸＡ 調布'), 'jaxa調布');
assert.strictEqual(Lib.norm('シンダイジ'), Lib.norm('しんだいじ'));
const found = Lib.searchSpots(tiered.concat([{ id: 'jd', name: '深大寺', tags: ['じんだいじ'], lat: 35.67, lon: 139.55, genres: ['temple'], indoor: false, url: 'https://j' }]),
  'ジンダイジ', cfg, new Set(), 'car');
assert.deepStrictEqual(ids(found), ['jd']);
assert.strictEqual(Lib.searchSpots(tiered, 'osm', cfg, new Set(), 'car', 2).length, 2);
assert.strictEqual(Lib.searchSpots(tiered, '  ', cfg, new Set(), 'car').length, 0);

// イベント: 告知の除外語
const ex = /募集|講座/;
const evs2 = [
  { id: 'a', title: '出展募集', start: '2026-10-10', end: '2026-10-10', lat: null, lon: null, pref: '東京', indoor: true },
  { id: 'b', title: '秋まつり', start: '2026-10-10', end: '2026-10-10', lat: null, lon: null, pref: '東京', indoor: false },
];
assert.deepStrictEqual(ids(Lib.filterEvents(evs2, f({ exclude: ex }), cfg, '2026-10-10', '2026-10-11')), ['b']);
assert.strictEqual(Lib.filterEvents(evs2, f({ exclude: null }), cfg, '2026-10-10', '2026-10-11').length, 2);
assert.strictEqual(Lib.spanDays({ start: '2026-10-01', end: '2026-10-03' }), 3);

// ルート近傍: bbox の前絞りをしても結果は同じ（遠い点が大量でも）
const many = Array.from({ length: 200 }, (_, i) => ({ id: 'z' + i, lat: 34.5 + i * 0.01, lon: 139.0 + (i % 50) * 0.02 }));
const near = [{ id: 'n', lat: 35.66, lon: 139.58 }, { id: 'm', lat: 35.651, lon: 139.52 }];
assert.deepStrictEqual(ids(Lib.stopsAlongRoute(near.concat(many), line, 3)).filter((x) => x === 'n' || x === 'm'), ['m', 'n']);
const brute = near.concat(many).map((s) => ({ s, r: Lib.distToRoute(s, line) })).filter((x) => x.r.km <= 3).length;
assert.strictEqual(Lib.stopsAlongRoute(near.concat(many), line, 3).length, brute);

// Google マップ: origin 省略で現在地から案内
const g2 = Lib.gmapsDirUrl(null, { lat: 35.7, lon: 139.0 });
assert(!g2.includes('origin='), g2);
assert(g2.includes('dir_action=navigate'), g2);

console.log('lib: ALL PASS');
