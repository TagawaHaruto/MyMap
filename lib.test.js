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
// SNS: その場所の名前で探す（一般的なタグだけでは別の場所ばかり出るため）
const ig = (t) => `https://www.instagram.com/explore/tags/${encodeURIComponent(t)}/`;
const xq = (q) => 'https://x.com/search?q=' + encodeURIComponent(q);
const sns = Lib.snsLinks({ name: '京王 れーるランド' });
assert.strictEqual(sns.instagram, ig('京王れーるランド'));
assert.strictEqual(sns.x, xq('"京王 れーるランド"'));
// タグが名前と関係ない一般語なら名前を使う
assert.deepStrictEqual(Lib.snsLinks({ name: '川崎市立日本民家園', tags: ['古民家'] }),
  { instagram: ig('川崎市立日本民家園'), x: xq('"川崎市立日本民家園"') });
// タグが名前の一部なら、投稿の多いそのタグを Instagram に使う。括弧の補足は外す
assert.deepStrictEqual(Lib.snsLinks({ name: '奥多摩周遊道路（都道206号）', tags: ['奥多摩周遊道路'] }),
  { instagram: ig('奥多摩周遊道路'), x: xq('"奥多摩周遊道路"') });
assert.deepStrictEqual(Lib.snsLinks({ name: '鉄道博物館（大宮）', tags: ['てっぱく'] }),
  { instagram: ig('鉄道博物館'), x: xq('"鉄道博物館"') });
// 記号や中黒は Instagram のタグに使えないので外す
assert.strictEqual(Lib.snsLinks({ name: '帆船日本丸・横浜みなと博物館' }).instagram, ig('帆船日本丸横浜みなと博物館'));
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
// 飲食のジャンル: 呼び方の違い・料理の種類（note）でも見つかる
const foods = [
  { id: 'f1', name: '麺屋 一番', note: 'ラーメン', lat: 35.65, lon: 139.54, genres: ['food'] },
  { id: 'f2', name: '中華そば 二郎', note: '飲食店', lat: 35.66, lon: 139.54, genres: ['food'] },
  { id: 'f3', name: 'キッチン山田', note: '洋食', lat: 35.67, lon: 139.54, genres: ['food'] },
  { id: 'f4', name: '手打ち蕎麦 松', note: '飲食店', lat: 35.68, lon: 139.54, genres: ['food'] },
];
assert.deepStrictEqual(Lib.searchSpots(foods, 'ラーメン', cfg, new Set(), 'car').map((s) => s.id).sort(), ['f1', 'f2']);
assert.deepStrictEqual(Lib.searchSpots(foods, 'ハンバーグ', cfg, new Set(), 'car').map((s) => s.id), ['f3']);
assert.deepStrictEqual(Lib.searchSpots(foods, 'そば', cfg, new Set(), 'car').map((s) => s.id), ['f4']);
assert.ok(Lib.inFoodCat(foods[3], 'そば・うどん') && !Lib.inFoodCat(foods[0], 'そば・うどん'));
assert.deepStrictEqual(Lib.searchKeys('じんだいじ'), ['じんだいじ']);

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
// 升目で前絞りしても、全線分と測った結果（距離・進行距離）と同じ。曲がりくねった線・長い線分・升目の境目の点でも
{
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const wig = [[139.40, 35.60]];
  for (let i = 0; i < 400; i++) { const [x, y] = wig[wig.length - 1]; wig.push([x + 0.002 + rnd() * 0.004, y + (rnd() - 0.5) * 0.006]); }
  wig.push([139.40 + 0.0 + 2.0, 35.62]); // 約 180km の長い 1 本
  const pts = Array.from({ length: 3000 }, (_, i) => ({ id: 'p' + i, lat: 35.55 + rnd() * 0.15, lon: 139.38 + rnd() * 2.1 }));
  pts.push({ id: 'edge', lat: 35.61, lon: 139.41 });
  for (const km of [0.3, 1, 3, 5]) {
    const want = pts.map((s) => ({ s, r: Lib.distToRoute(s, wig) })).filter((x) => x.r.km <= km)
      .sort((a, b) => a.r.along - b.r.along).map((x) => [x.s.id, x.r.km.toFixed(9), x.r.along.toFixed(9)]);
    const got = Lib.stopsAlongRoute(pts, wig, km).map((s) => [s.id, s.offKm.toFixed(9), s.alongKm.toFixed(9)]);
    assert.deepStrictEqual(got, want, `maxKm ${km}`);
    assert(got.length > 10, `maxKm ${km} は候補がある: ${got.length}`);
  }
}

// Google マップ: origin 省略で現在地から案内
const g2 = Lib.gmapsDirUrl(null, { lat: 35.7, lon: 139.0 });
assert(!g2.includes('origin='), g2);
assert(g2.includes('dir_action=navigate'), g2);

// 検索: 読み仮名（kana）でも当たる・近くの同名は 1 件にまとめる
const dupe = [
  { id: 'cur2', name: '深大寺', kana: 'じんだいじ', lat: 35.6705, lon: 139.5522, genres: ['temple'], indoor: false, url: 'https://j' },
  { id: 'osm:node:7', name: '深大寺天然温泉 湯守の里', lat: 35.668, lon: 139.551, genres: ['onsen'], indoor: true, url: '' },
  { id: 'poi:onsen:x', poi: true, name: '深大寺天然温泉 湯守の里', lat: 35.6681, lon: 139.5511, genres: ['onsen'], indoor: false, url: '' },
];
assert.deepStrictEqual(ids(Lib.searchSpots(dupe, 'じんだいじ', cfg, new Set(), 'car')), ['cur2']);
assert.deepStrictEqual(ids(Lib.searchSpots(dupe, '深大寺', cfg, new Set(), 'car')), ['cur2', 'osm:node:7']);

// 長い期間（今月・3か月）は開始日順。開催中の長期展示は最後
const evs3 = [
  { id: 'far', title: 'a', start: '2026-11-01', end: '2026-11-01', lat: 35.66, lon: 139.55, pref: '東京', indoor: true },
  { id: 'long', title: 'b', start: '2026-10-01', end: '2026-10-31', lat: 35.66, lon: 139.55, pref: '東京', indoor: true },
  { id: 'soon', title: 'c', start: '2026-10-10', end: '2026-10-10', lat: 36.5, lon: 139.0, pref: '群馬', indoor: true },
];
assert.deepStrictEqual(ids(Lib.filterEvents(evs3, f({ sortBy: 'date' }), cfg, '2026-10-08', '2026-11-08')), ['soon', 'far', 'long']);
assert.deepStrictEqual(ids(Lib.filterEvents(evs3, f({}), cfg, '2026-10-08', '2026-11-08')), ['far', 'soon', 'long']);

// ---- ルート提案（Valhalla） ----
// polyline（精度 6）の復号。Google の例の文字列を精度 6 で読むと値は 1/10 になる。[lon, lat] で返す
const dec = Lib.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 6);
assert.strictEqual(dec.length, 3);
[[-12.02, 3.85], [-12.095, 4.07], [-12.6453, 4.3252]].forEach(([x, y], i) => {
  assert(Math.abs(dec[i][0] - x) < 1e-6 && Math.abs(dec[i][1] - y) < 1e-6, JSON.stringify(dec[i]));
});
assert.deepStrictEqual(Lib.decodePolyline('', 6), []);

// 景色の点数: ルートの 1km 以内の景色の地点数と、おすすめの道を通る距離
const road1 = { id: 'r1', name: '道1', points: [[35.65, 139.52], [35.65, 139.55], [35.65, 139.58]] };
const road2 = { id: 'r2', name: '遠い道', points: [[36.2, 139.0], [36.3, 139.1], [36.4, 139.2]] };
const sc = Lib.scenicScore(line, [{ lat: 35.655, lon: 139.53 }, { lat: 35.70, lon: 139.53 }, { lat: 35.651, lon: 139.59 }], [road1, road2]);
assert.strictEqual(sc.spots, 2);
assert(Math.abs(sc.roadKm - 5.44) < 0.1, sc.roadKm); // 道1 は全点がルート沿い（約 5.4km）、道2 は 0
assert.deepStrictEqual(Lib.scenicStars([{ spots: 0, roadKm: 0 }, { spots: 4, roadKm: 10 }, { spots: 2, roadKm: 0 }]), [1, 5, 2]);
assert.deepStrictEqual(Lib.scenicStars([{ spots: 0, roadKm: 0 }]), [1]);

// 寄り道できるおすすめの道: 遠回りが 1.6 倍以内のものを、道の長さに対して遠回りが少ない順に
const O2 = { lat: 35.65, lon: 139.50 }, D2 = { lat: 35.65, lon: 139.62 };
const det = Lib.detourRoads(O2, D2, [road1, road2], 1.6, 2);
assert.deepStrictEqual(det.map((d) => d.road.id), ['r1']);
assert.deepStrictEqual(det[0].points, road1.points); // 起点に近い側から走る向き
const det2 = Lib.detourRoads(D2, O2, [road1], 1.6, 2);
assert.deepStrictEqual(det2[0].points, [...road1.points].reverse());

// ルート固定用の経由地: 端を避けて等間隔に k 点（進行距離つき）
const pins = Lib.pinWaypoints(line, 3);
assert.strictEqual(pins.length, 3);
assert(pins[0].along < pins[1].along && pins[1].along < pins[2].along);
assert(Math.abs(pins[1].lon - 139.55) < 0.002, JSON.stringify(pins[1]));
assert.deepStrictEqual(Lib.pinWaypoints(line, 0), []);

// 周回: 起点に近い端から入り、起点に戻る
const loop = Lib.loopPoints({ lat: 35.65, lon: 139.60 }, road1);
// データの並び（走る向き）のまま回る。一方通行の道を逆走させないため
assert.deepStrictEqual(loop.map((p) => [p.lat, p.lon]), [[35.65, 139.60], [35.65, 139.52], [35.65, 139.55], [35.65, 139.58], [35.65, 139.60]]);

// GPX: 線と立ち寄りを書き出し、名前はエスケープする
const g3 = Lib.toGpx('調布→奥多摩 <テスト>', [[139.5, 35.6], [139.6, 35.7]], [{ lat: 35.65, lon: 139.55, name: 'A&B' }]);
assert(g3.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), g3.slice(0, 60));
assert(g3.includes('<trkpt lat="35.6" lon="139.5"></trkpt>'), g3);
assert(g3.includes('<wpt lat="35.65" lon="139.55"><name>A&amp;B</name></wpt>'), g3);
assert(g3.includes('<name>調布→奥多摩 &lt;テスト&gt;</name>'), g3);

// ---- スポットの説明と写真（Wikipedia / Wikimedia Commons） ----
assert.deepStrictEqual(Lib.wikiRef({ wp: 'ja:深大寺' }), { lang: 'ja', title: '深大寺' });
assert.deepStrictEqual(Lib.wikiRef({ url: 'https://ja.wikipedia.org/wiki/' + encodeURIComponent('奥多摩湖') }), { lang: 'ja', title: '奥多摩湖' });
assert.deepStrictEqual(Lib.wikiRef({ url: 'https://ja.wikipedia.org/wiki/%E9%81%93_%E5%BF%97' }), { lang: 'ja', title: '道 志' });
assert.strictEqual(Lib.wikiRef({ url: 'https://www.example.jp/' }), null);
assert.strictEqual(Lib.wikiRef({}), null);
assert.strictEqual(Lib.summaryUrl({ lang: 'ja', title: '深大寺' }), 'https://ja.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent('深大寺'));

// 説明は 1〜2 文に短く（句点で切る）
assert.strictEqual(Lib.shortExtract('一文目です。二文目です。三文目はとても長いのでここまでは入らない文章です。', 14), '一文目です。二文目です。');
assert.strictEqual(Lib.shortExtract('句点のない長い文章が続いていく', 8), '句点のない長い文…');
assert.strictEqual(Lib.shortExtract('', 10), '');

const sum = Lib.parseSummary({ type: 'standard', extract: '道志村は山梨県の村。山梨県の最東端。', thumbnail: { source: 'https://upload.wikimedia.org/a.jpg' },
  content_urls: { mobile: { page: 'https://ja.m.wikipedia.org/wiki/x' }, desktop: { page: 'https://ja.wikipedia.org/wiki/x' } } });
assert.deepStrictEqual(sum, { text: '道志村は山梨県の村。山梨県の最東端。', thumb: 'https://upload.wikimedia.org/a.jpg', page: 'https://ja.m.wikipedia.org/wiki/x' });
assert.strictEqual(Lib.parseSummary({ type: 'disambiguation', extract: 'x' }), null);
assert.strictEqual(Lib.parseSummary({ type: 'standard', extract: '' }), null);
assert.strictEqual(Lib.parseSummary({ type: 'standard', extract: 'あ。' }).thumb, null);

// 付近の写真: 近い順・撮影者の HTML を外す・https 以外は捨てる
const cu = Lib.commonsNearbyUrl(35.1, 139.2, 300, 3);
assert(cu.startsWith('https://commons.wikimedia.org/w/api.php?') && cu.includes('ggscoord=35.1%7C139.2') && cu.includes('ggsradius=300') && cu.includes('origin=*'), cu);
const photos = Lib.parseCommons({ query: { pages: {
  '2': { index: 2, title: 'File:B.jpg', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/b.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:B.jpg',
    extmetadata: { Artist: { value: '<a href="x">山田</a>' }, LicenseShortName: { value: 'CC BY-SA 4.0' } } }] },
  '1': { index: 1, title: 'File:A.jpg', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/a.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:A.jpg',
    extmetadata: { LicenseShortName: { value: 'Public domain' } } }] },
  '3': { index: 3, title: 'File:C.jpg', imageinfo: [{ thumburl: 'javascript:alert(1)', descriptionurl: 'https://x' }] },
} } });
assert.deepStrictEqual(photos, [
  { thumb: 'https://upload.wikimedia.org/a.jpg', page: 'https://commons.wikimedia.org/wiki/File:A.jpg', artist: '', license: 'Public domain' },
  { thumb: 'https://upload.wikimedia.org/b.jpg', page: 'https://commons.wikimedia.org/wiki/File:B.jpg', artist: '山田', license: 'CC BY-SA 4.0' },
]);
assert.deepStrictEqual(Lib.parseCommons({}), []);

// Google マップで場所を開く（写真・口コミはそちらで見る。API は使わない）
// 同じ名前の別の場所に飛ばないよう、その場所を中心にした地図で名前を検索する
assert.strictEqual(Lib.gmapsSearchUrl({ name: '深大寺', lat: 35.67, lon: 139.55 }),
  'https://www.google.com/maps/search/' + encodeURIComponent('深大寺') + '/@35.67,139.55,17z');
assert.strictEqual(Lib.gmapsSearchUrl({ name: 'A/B' }), 'https://www.google.com/maps/search/?api=1&query=A%2FB');
// 住所（市区町村＋町名）がわかれば「名前 住所」で検索する（同じ名前の別の場所に飛ばない）
assert.strictEqual(Lib.gmapsSearchUrl({ name: '深大寺', lat: 35.67, lon: 139.55 }, '東京都調布市深大寺元町五丁目'),
  'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('深大寺 東京都調布市深大寺元町五丁目'));
// 経路: 目的地を「指定した場所（座標）」でなく施設名＋住所で渡す。住所がなければ座標
assert.strictEqual(Lib.gmapsPlaceDirUrl({ lat: 35.65, lon: 139.54 }, { name: '深大寺', lat: 35.67, lon: 139.55 }, 'transit', '東京都調布市'),
  'https://www.google.com/maps/dir/?api=1&origin=35.65,139.54&destination=' + encodeURIComponent('深大寺 東京都調布市') + '&travelmode=transit');
assert.strictEqual(Lib.gmapsPlaceDirUrl({ lat: 1, lon: 2 }, { name: 'x', lat: 3, lon: 4 }, 'driving'),
  Lib.gmapsDirUrl({ lat: 1, lon: 2 }, { lat: 3, lon: 4 }, [], 'driving'));
// 国土地理院の逆ジオコーダーの結果 → 住所
const MUNI = { 13208: '東京都調布市', 1101: '北海道札幌市中央区' };
assert.strictEqual(Lib.parseGsiAddress({ results: { muniCd: '13208', lv01Nm: '深大寺元町五丁目' } }, MUNI), '東京都調布市深大寺元町五丁目');
assert.strictEqual(Lib.parseGsiAddress({ results: { muniCd: '01101', lv01Nm: '－' } }, MUNI), '北海道札幌市中央区');
assert.strictEqual(Lib.parseGsiAddress({ results: { muniCd: '99999', lv01Nm: 'x' } }, MUNI), null);
assert.strictEqual(Lib.parseGsiAddress({}, MUNI), null);

// ---- レビュー指摘への対応 ----
// 一方通行の道は逆向きにしない
const oneway = { ...road1, id: 'ow', oneway: true };
assert.strictEqual(Lib.detourRoads(D2, O2, [oneway], 3, 2)[0].points, oneway.points);
// 目的地が道の途中にあるときは寄り道候補にしない（通り過ぎて引き返すため）
assert.deepStrictEqual(Lib.detourRoads(O2, { lat: 35.65, lon: 139.55 }, [road1], 3, 2), []);
// 道の距離はルートに沿って測る: 端を 1 点かすめただけでは数えない
const graze = { id: 'g', points: [[35.6505, 139.60], [35.80, 139.70], [35.90, 139.80]] };
assert.strictEqual(Lib.scenicScore(line, [], [graze]).roadKm, 0);
// 道の全体がルート上にあれば、ルートに沿った距離（約 5.4km）
assert(Math.abs(Lib.scenicScore(line, [], [road1]).roadKm - 5.43) < 0.1);

// 目的地の検索（国土地理院の地名・住所検索）
assert.strictEqual(Lib.gsiSearchUrl('河口湖'), 'https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent('河口湖'));
assert.deepStrictEqual(Lib.parseGsi([
  { geometry: { coordinates: [138.748, 35.515] }, properties: { title: '河口湖' } },
  { geometry: { coordinates: ['x', null] }, properties: { title: '壊れた' } },
  { geometry: { coordinates: [138.779, 35.543] }, properties: { title: '山梨県富士河口湖町河口' } },
], 1), [{ name: '河口湖', lat: 35.515, lon: 138.748 }]);
assert.deepStrictEqual(Lib.parseGsi(null), []);

// ---- 約10万件への拡大: 升目と関連スポット ----
assert.strictEqual(Lib.cellId(35.6518, 139.544), '142_558');   // floor(35.6518*4)=142, floor(139.544*4)=558
assert.strictEqual(Lib.cellId(-0.1, -0.1), '-1_-1');
// 半径 10km の円にかかる升目（調布駅は升目の中ほど → 周りの升目も含む）
const cs = Lib.cellsInRadius({ lat: 35.6518, lon: 139.544 }, 10);
assert(cs.includes('142_558') && cs.includes('142_557') && !cs.includes('140_558'), cs.join(','));
assert.strictEqual(Lib.cellsInRadius({ lat: 35.6518, lon: 139.544 }, 0).length, 1);
// 地方ごとのデータ（1 度四方）: 調布から 300km は関東〜東北南部・中部。大阪から 300km に調布の升目は入らない
const big = Lib.cellsInRadius({ lat: 35.6518, lon: 139.544 }, 300, 1);
assert(big.includes('35_139') && big.includes('37_140') && big.includes('34_138') && !big.includes('34_135'), big.join(' '));
assert(!Lib.cellsInRadius({ lat: 34.70, lon: 135.50 }, 300, 1).includes('35_139'));
assert.deepStrictEqual(Lib.cellsInRadius({ lat: 35.5, lon: 139.5 }, 0, 1), ['35_139']);
// 都道府県の絞り込みは起点の近くに多いものに入れ替えられる
Lib.setMainPrefs(['大阪', '京都']);
assert.strictEqual(Lib.prefGroup('京都'), '京都');
assert.strictEqual(Lib.prefGroup('東京'), 'その他');
Lib.setMainPrefs(['東京', '神奈川', '埼玉', '千葉', '山梨']);
// 時間制限なしでも、起点から poiRadiusKm より遠い所（全国で使うときの、ほかの地方の厳選スポット）は出さない
{
  const c = { origin: { lat: 43.07, lon: 141.35 }, speedsKmh: { car: 25 }, poiRadiusKm: 300, trainOverheadMin: 10 };
  const xs = [{ id: 'sap', lat: 43.0, lon: 141.4, genres: ['play'] }, { id: 'tokyo', lat: 35.65, lon: 139.54, genres: ['play'] }];
  const f0 = { rainy: false, prefs: new Set(), genres: new Set(), dirs: null, mode: 'car', maxMin: null, favs: new Set() };
  assert.deepStrictEqual(Lib.filterSpots(xs, f0, c).map((s) => s.id), ['sap']);
  assert.deepStrictEqual(Lib.filterSpots(xs, f0, { ...c, poiRadiusKm: undefined }).map((s) => s.id).sort(), ['sap', 'tokyo']);
}

// 関連スポット: 似たもの（同じジャンル・近い順）、周辺（2km 以内・近い順）、飲食（1km 以内）
const base = { id: 'b', name: '基準', lat: 35.65, lon: 139.55, genres: ['museum'] };
const pool = [
  base,
  { id: 'm1', name: '近い博物館', lat: 35.66, lon: 139.55, genres: ['museum'] },
  { id: 'm2', name: '遠い博物館', lat: 35.90, lon: 139.55, genres: ['museum'] },
  { id: 'g1', name: '近い庭園', lat: 35.651, lon: 139.551, genres: ['garden'] },
  { id: 'f1', name: '近いカフェ', lat: 35.6505, lon: 139.5505, genres: ['food'] },
  { id: 'f2', name: '遠いカフェ', lat: 35.70, lon: 139.55, genres: ['food'] },
  { id: 'c1', name: 'チェーン店', lat: 35.6502, lon: 139.5502, genres: ['food'], chain: true },
];
const rel = Lib.relatedSpots(base, pool, { limit: 5 });
assert.deepStrictEqual(ids(rel.similar), ['m1', 'm2']);
assert.deepStrictEqual(ids(rel.nearby), ['g1', 'm1']);       // 飲食は周辺から除き、別枠
assert.deepStrictEqual(ids(rel.food), ['f1']);                // チェーン店は既定で除く、1km 以内
assert.deepStrictEqual(ids(Lib.relatedSpots(base, pool, { limit: 5, chains: true }).food), ['c1', 'f1']);

// 関連スポット: 同じ名前（自動収集と立ち寄り候補の重複など）は 1 件に
const dupPool = [base, { id: 'x1', name: '湯守の里', lat: 35.651, lon: 139.551, genres: ['onsen'] },
  { id: 'x2', name: '湯守の里', lat: 35.6511, lon: 139.5511, genres: ['onsen'] }];
assert.deepStrictEqual(ids(Lib.relatedSpots(base, dupPool).nearby), ['x1']);

// ---- 営業時間 ----
const at = (s) => new Date(s); // 2026-10-12 は月曜
assert.strictEqual(Lib.openState('Mo-Fr 09:00-17:00', at('2026-10-12T10:00')), true);
assert.strictEqual(Lib.openState('Mo-Fr 09:00-17:00', at('2026-10-12T17:00')), false);
assert.strictEqual(Lib.openState('Mo-Fr 09:00-17:00', at('2026-10-11T10:00')), false); // 日曜
assert.strictEqual(Lib.openState('Mo-Fr 09:00-17:00; Su 10:00-12:00', at('2026-10-11T11:00')), true);
assert.strictEqual(Lib.openState('Mo-Su 11:00-14:00,17:00-22:00; Tu off', at('2026-10-13T12:00')), false); // 火曜休み
assert.strictEqual(Lib.openState('Mo-Su 11:00-14:00,17:00-22:00', at('2026-10-12T15:00')), false);
assert.strictEqual(Lib.openState('Mo-Su 11:00-14:00,17:00-22:00', at('2026-10-12T18:00')), true);
assert.strictEqual(Lib.openState('Fr-Mo 18:00-02:00', at('2026-10-13T01:00')), true); // 月曜の夜から続く
assert.strictEqual(Lib.openState('24/7', at('2026-10-12T03:00')), true);
assert.strictEqual(Lib.openState('10:00-20:00', at('2026-10-11T19:59')), true);
assert.strictEqual(Lib.openState('Mo-Fr 09:00-17:00; PH off', at('2026-10-12T10:00')), true);
assert.strictEqual(Lib.openState('Apr-Oct: Mo-Su 09:00-17:00', at('2026-10-12T10:00')), null); // 読めない書き方
assert.strictEqual(Lib.openState('', at('2026-10-12T10:00')), null);
assert.strictEqual(Lib.ohText('Mo-Fr 09:00-17:00; Sa,Su off'), '月-金 09:00-17:00／土,日 休み');
// ---- 季節の見頃 ----
const sakura = { best: [{ what: '桜', months: [3, 4] }, { what: '紅葉', months: [11] }] };
assert.deepStrictEqual(Lib.seasonNow(sakura, 4).map((b) => b.what), ['桜']);
assert.strictEqual(Lib.seasonNow({}, 4).length, 0);
assert.strictEqual(Lib.seasonText(sakura.best), '桜 3〜4月・紅葉 11月');
// ---- ルート上の地点と雨 ----
const rline = [[139.0, 35.0], [139.1, 35.0], [139.2, 35.0]];
const smp = Lib.routeSamples(rline, 60, Date.parse('2026-10-12T08:00:00+09:00'), 3);
assert.deepStrictEqual(smp.map((p) => p.lon), [139.0, 139.1, 139.2]);
assert.strictEqual(smp[2].at - smp[0].at, 60 * 60e3);
const rj = [{ hourly: { time: ['2026-10-12T08:00', '2026-10-12T09:00'], precipitation_probability: [10, 80], precipitation: [0, 2.5] } }];
const rr = Lib.parseRainAlong(rj, [{ lat: 35, lon: 139, at: Date.parse('2026-10-12T09:20:00+09:00') }]);
assert.deepStrictEqual([rr[0].prob, rr[0].mm], [80, 2.5]);
assert.ok(Lib.rainAlongUrl(smp).includes('latitude=35.0000,35.0000,35.0000'));
assert.strictEqual(Lib.climbOf([100, 150, 120, 200]), 130);
// ---- 日帰りプラン ----
const pcfg = { ...cfg, origin: { name: '調布駅', lat: 35.65, lon: 139.54 } };
const tgt = { id: 't', name: '博物館', lat: 35.70, lon: 139.40, genres: ['museum'] };
const ppool = [tgt,
  { id: 'r1', name: '食堂A', lat: 35.701, lon: 139.401, genres: ['food'], oh: 'Mo-Su 11:00-15:00' },
  { id: 'r2', name: 'チェーンB', lat: 35.7005, lon: 139.4005, genres: ['food'], chain: true },
  { id: 'o1', name: '湯の里', lat: 35.72, lon: 139.45, genres: ['onsen'] }];
const plan = Lib.dayPlan(tgt, ppool, pcfg, 'car', 9 * 60, at('2026-10-12T09:00'));
assert.deepStrictEqual(plan.map((x) => x.what), ['調布駅を出発', '博物館に到着', '昼食: 食堂A', '湯の里へ', '調布駅に帰着']);
assert.strictEqual(plan[0].time, '9:00');
// ---- 行った記録・周辺検索 ----
assert.deepStrictEqual(Lib.visitedStats([{ pref: '東京' }, { pref: '東京' }, { pref: '山梨' }, {}]), [['東京', 2], ['山梨', 1], ['その他', 1]]);
assert.ok(Lib.streetViewUrl({ lat: 35.1, lon: 139.2 }).endsWith('viewpoint=35.1,139.2'));
assert.ok(decodeURIComponent(Lib.nearbyQuery({ lat: 35, lon: 139 }, 'fuel')).includes('nwr["amenity"="fuel"](around:2000,35,139)'));
const nb = Lib.parseNearby({ elements: [{ lat: 35.01, lon: 139, tags: { name: '遠い' } }, { center: { lat: 35.001, lon: 139 }, tags: { brand: 'ENEOS' } }] }, { lat: 35, lon: 139 });
assert.deepStrictEqual(nb.map((x) => x.name), ['ENEOS', '遠い']);

// ---- 太陽・ダイヤモンド富士 ----
const tokyo = { lat: 35.6895, lon: 139.6917 };
const st2 = Lib.sunTimes(new Date('2026-06-21T12:00:00+09:00'), tokyo);
// 夏至の東京: 日の出 4:25 ごろ（東北東）・日の入り 19:00 ごろ（西北西）
assert.ok(Math.abs(st2.rise.at.getHours() * 60 + st2.rise.at.getMinutes() - (4 * 60 + 25)) <= 4, String(st2.rise.at));
assert.ok(Math.abs(st2.set.at.getHours() * 60 + st2.set.at.getMinutes() - (19 * 60)) <= 5, String(st2.set.at));
assert.strictEqual(Lib.dir16(st2.rise.az), '東北東');
assert.strictEqual(Lib.dir16(st2.set.az), '西北西');
assert.ok(Lib.bearing({ lat: 35, lon: 139 }, { lat: 35, lon: 138 }) > 269 && Lib.bearing({ lat: 35, lon: 139 }, { lat: 35, lon: 138 }) < 271);
// 山中湖（パノラマ台付近）は 10〜11 月・2 月ごろに夕方のダイヤモンド富士
const df = Lib.diamondFuji({ lat: 35.4300, lon: 138.8700, ele: 1000 }, new Date('2026-01-01T00:00:00+09:00'));
assert.ok(df.length > 0 && df.every((x) => x.kind === '夕方（沈む）'));
assert.ok(df.some((x) => [10, 11, 2].includes(x.at.getMonth() + 1)), df.map((x) => x.at.toISOString()).join());
assert.deepStrictEqual(Lib.diamondFuji({ lat: 35.36, lon: 138.73 }), []); // 山頂の近く
// ---- 到達圏 ----
assert.ok(decodeURIComponent(Lib.isochroneUrl({ lat: 35, lon: 139 }, 'car', [30, 60])).includes('"costing":"auto"'));
assert.strictEqual(Lib.isochroneUrl({ lat: 35, lon: 139 }, 'train', [30]), null);
const sq = { type: 'Polygon', coordinates: [[[139, 35], [140, 35], [140, 36], [139, 36], [139, 35]], [[139.4, 35.4], [139.6, 35.4], [139.6, 35.6], [139.4, 35.6], [139.4, 35.4]]] };
assert.strictEqual(Lib.inGeometry({ lat: 35.2, lon: 139.2 }, sq), true);
assert.strictEqual(Lib.inGeometry({ lat: 35.5, lon: 139.5 }, sq), false); // 穴の中
assert.strictEqual(Lib.inGeometry({ lat: 36.5, lon: 139.5 }, sq), false);
// ---- カーブの多さ: まっすぐ < ジグザグ ----
const straight = Array.from({ length: 50 }, (_, i) => [139 + i * 0.002, 35]);
const zig = Array.from({ length: 50 }, (_, i) => [139 + i * 0.002, 35 + (i % 2) * 0.0015]);
assert.ok(Lib.curviness(straight) < 1);
assert.ok(Lib.curviness(zig) > 150 && Lib.curvStars(Lib.curviness(zig)) === 5);
assert.strictEqual(Lib.curvStars(500), 5);
// ---- 祝日・混みやすさ ----
assert.strictEqual(Lib.jpHoliday(new Date(2026, 9, 12)), true); // スポーツの日（10 月第 2 月曜）
assert.strictEqual(Lib.jpHoliday(new Date(2026, 8, 23)), true); // 秋分の日
assert.strictEqual(Lib.jpHoliday(new Date(2026, 4, 6)), true); // 振替休日（5/3 が日曜）
assert.strictEqual(Lib.jpHoliday(new Date(2026, 9, 13)), false);
assert.strictEqual(Lib.crowdLevel({ best: [{ what: '紅葉', months: [11] }] }, new Date(2026, 10, 3, 12)).level, 2);
assert.strictEqual(Lib.crowdLevel({}, new Date(2026, 9, 14, 8)).level, 0);
// ---- 方面・タイル・閉鎖 ----
const dp8 = Lib.dirPoints({ lat: 35.65, lon: 139.54 }, 70);
assert.strictEqual(dp8.length, 8);
assert.strictEqual(Lib.direction({ lat: 35.65, lon: 139.54 }, dp8[6]), 'W');
assert.strictEqual(Lib.tilesAlong([[139.54, 35.65]], [10], 1).length, 9);
const closedRoads = [{ name: 'X', points: [[35.0, 139.05], [35.0, 139.15]], closedMonths: [1] }];
assert.strictEqual(Lib.closedAlong(rline, closedRoads, 1).length, 1);
assert.strictEqual(Lib.closedAlong(rline, closedRoads, 6).length, 0);

// ---- 帰り道の温泉 ----
const hline = [[139.0, 35.0], [139.5, 35.0], [140.0, 35.0]]; // 約91km
const onsens = [
  { id: 'a', name: '起点近くの湯', lat: 35.01, lon: 139.05, genres: ['onsen'], oh: 'Mo-Su 10:00-22:00' },
  { id: 'b', name: '目的地近くの湯', lat: 35.01, lon: 139.95, genres: ['onsen'], oh: 'Mo-Su 10:00-15:00' },
  { id: 'c', name: '遠い湯', lat: 35.2, lon: 139.5, genres: ['onsen'] },
  { id: 'd', name: 'カフェ', lat: 35.0, lon: 139.5, genres: ['food'] }];
const back = Date.parse('2026-10-17T15:00:00+09:00');
const oh1 = Lib.onsenHome(onsens, hline, 90, { loop: false, departMs: back - 6 * 3600e3, backMs: back });
assert.deepStrictEqual(oh1.map((x) => x.id), ['a', 'b']); // 家に近い順。3km より遠い・温泉以外は除く
assert.strictEqual(oh1[0].open, true);  // 15 時に目的地を出て約 1 時間半後
assert.strictEqual(oh1[1].open, false); // 目的地の近く: 15:04 着で、15 時までの湯は営業時間外
const oh2 = Lib.onsenHome(onsens, hline, 90, { loop: true, departMs: back, backMs: back });
assert.deepStrictEqual(oh2.map((x) => x.id), ['b']); // 周回は後半だけ

// ---- 写真・まだ行っていない方面 ----
assert.ok(Lib.commonsSearchUrl('深大寺').includes('gsrsearch=%E6%B7%B1%E5%A4%A7%E5%AF%BA'));
const sp = { name: '深大寺', lat: 35.67, lon: 139.55 };
assert.strictEqual(JSON.parse(Lib.placesBody(sp)).locationBias.circle.center.latitude, 35.67);
const pj = { places: [{ location: { latitude: 35.671, longitude: 139.551 }, googleMapsUri: 'https://maps.google.com/?cid=1',
  photos: [{ name: 'places/X/photos/Y', authorAttributions: [{ displayName: '山田', uri: 'https://u' }] }] }] };
const pp = Lib.parsePlacesPhotos(pj, sp, 'K');
assert.strictEqual(pp.photos[0].thumb, 'https://places.googleapis.com/v1/places/X/photos/Y/media?maxWidthPx=480&key=K');
assert.strictEqual(pp.photos[0].artist, '山田');
assert.strictEqual(Lib.parsePlacesPhotos({ places: [{ location: { latitude: 36.5, longitude: 139.5 }, photos: [] }] }, sp, 'K'), null); // 遠い同名
assert.strictEqual(Lib.parsePlacesPhotos({}, sp, 'K'), null);
const ov = Lib.lessVisitedDirs([{ lat: 35.75, lon: 139.54 }, { lat: 35.75, lon: 139.55 }, { lat: 35.65, lon: 139.30 }], { lat: 35.65, lon: 139.54 }, 1);
assert.strictEqual(ov[ov.length - 1].dir, 'N');
assert.strictEqual(ov[0].count, 0);

// ---- 日帰りプランの編集: 行き先の追加・帰宅したい時刻・近い順 ----
const pst = Lib.autoPlanStops(tgt, ppool, pcfg, 'car', 9 * 60, at('2026-10-12T09:00'));
assert.deepStrictEqual(pst.map((x) => x.kind), ['main', 'lunch', 'extra']);
const sch = Lib.schedulePlan(pst, pcfg, 'car', 9 * 60, 15 * 60);
assert.strictEqual(sch.steps[sch.steps.length - 1].what, '調布駅に帰着');
assert.strictEqual(typeof sch.overMin, 'number');
assert.ok(/^\d{1,2}:\d{2}$/.test(sch.lastLeave));
const added = pst.concat([{ place: { id: 'z', name: '追加の場所', lat: 35.66, lon: 139.50 }, stay: 30, kind: 'extra' }]);
const sch2 = Lib.schedulePlan(added, pcfg, 'car', 9 * 60, 15 * 60);
assert.ok(sch2.endMin > sch.endMin - 1 && sch2.steps.length === sch.steps.length + 1);
assert.strictEqual(Lib.schedulePlan(pst, pcfg, 'car', 9 * 60).overMin, null);
// 昼食は 11:30 より前にしない
const early = Lib.schedulePlan([{ place: ppool[1], stay: 60, kind: 'lunch' }], pcfg, 'car', 8 * 60);
assert.strictEqual(early.steps[1].time, '11:30');
// 近い順: 起点（調布）から近い順に
const ord = Lib.orderStops([{ place: { name: '遠', lat: 35.9, lon: 139.0 } }, { place: { name: '近', lat: 35.66, lon: 139.55 } }], pcfg.origin);
assert.deepStrictEqual(ord.map((x) => x.place.name), ['近', '遠']);

// ---- OpenPOI API ----
const ou = new URL(Lib.openPoiUrl('ラーメン', { lat: 35.6518, lon: 139.544 }, 3, 30));
assert.deepStrictEqual([ou.searchParams.get('q'), ou.searchParams.get('center'), ou.searchParams.get('radius'), ou.searchParams.get('limit')], ['ラーメン', '139.54400,35.65180', '3000', '30']);
const ob = new URL(Lib.openPoiUrl('温泉', { lat: 35.65, lon: 139.54 }, 60, 500));
assert.ok(ob.searchParams.get('bbox') && !ob.searchParams.get('center') && ob.searchParams.get('limit') === '200');
const oj = { results: [
  { name: '麺屋テスト', name_kana: 'めんやてすと', address: '東京都調布市布田1', category: 'ramen_restaurant', source: 'Overture Maps', lat: 35.652, lng: 139.545, licenses: ['CDLA-Permissive-2.0'], attributions: ['© OpenStreetMap'] },
  { name: '食堂B', category: 'unknown', source: '食品営業許可（調布市）', lat: 35.66, lng: 139.55 },
  { name: '湯の郷', category: 'hot_spring', source: 'Overture Maps', lat: 35.7, lng: 139.4 },
  { name: '座標なし', lat: null, lng: null }] };
const ops = Lib.parseOpenPoi(oj);
assert.deepStrictEqual(ops.map((x) => [x.name, x.genres[0]]), [['麺屋テスト', 'food'], ['食堂B', 'food'], ['湯の郷', 'onsen']]);
assert.strictEqual(ops[0].note, 'ramen restaurant・東京都調布市布田1');
assert.strictEqual(ops[0].lon, 139.545);
assert.deepStrictEqual(Lib.parseOpenPoi({}), []);
assert.strictEqual(Lib.tierOf(ops[0], new Set()), 2); // ネットの施設は厳選扱いにしない
assert.deepStrictEqual(Lib.notInLocal(ops, [{ name: '麺屋テスト', lat: 35.6521, lon: 139.5451 }]).map((x) => x.name), ['食堂B', '湯の郷']);

// ---- 近くの検索・Wikipedia を名前で探す ----
assert.deepStrictEqual(Lib.nearQuery('近くの飲食店'), { word: '飲食店' });
assert.deepStrictEqual(Lib.nearQuery('周辺のカフェ'), { word: 'カフェ' });
assert.deepStrictEqual(Lib.nearQuery('温泉 近く'), { word: '温泉' });
// 駐車場を探す言葉だけなら、近くの駐車場（名前に「駐車場」を含むスポットを探さない）
assert.deepStrictEqual(Lib.nearQuery('駐車場'), { word: '駐車場' });
assert.deepStrictEqual(Lib.nearQuery('バイク 駐車場'), { word: 'バイク駐車場' });
assert.deepStrictEqual(Lib.nearQuery('駐輪場'), { word: '駐輪場' });
assert.strictEqual(Lib.nearQuery('深大寺 駐車場'), null);
assert.deepStrictEqual(Lib.nearQuery('駅の近く'), { word: '駅' });
assert.strictEqual(Lib.nearQuery('深大寺'), null);
assert.strictEqual(Lib.nearQuery('近くの'), null);
const nearPool = [
  { id: 'n1', name: '麺屋A', note: 'ラーメン', lat: 35.652, lon: 139.545, genres: ['food'] },
  { id: 'n2', name: 'カフェB', note: 'カフェ', lat: 35.655, lon: 139.545, genres: ['food'] },
  { id: 'n3', name: '遠いラーメン', note: 'ラーメン', lat: 35.9, lon: 139.5, genres: ['food'] },
  { id: 'n4', name: '博物館C', lat: 35.651, lon: 139.544, genres: ['museum'] }];
const here = { lat: 35.6518, lon: 139.544 };
assert.deepStrictEqual(Lib.nearSearch(nearPool, '飲食店', here, 3).map((x) => x.id), ['n1', 'n2']);
assert.deepStrictEqual(Lib.nearSearch(nearPool, 'ラーメン', here, 3).map((x) => x.id), ['n1']);
assert.strictEqual(Lib.netWord('ご飯'), 'レストラン');
const ws = { query: { pages: {
  1: { index: 1, title: '別の寺', coordinates: [{ lat: 34.0, lon: 135.0 }], extract: '関西の寺。' },
  2: { index: 2, title: '深大寺', coordinates: [{ lat: 35.6703, lon: 139.5485 }], extract: '深大寺は調布市の寺院。', thumbnail: { source: 'https://upload.wikimedia.org/a.jpg' }, fullurl: 'https://ja.wikipedia.org/wiki/x' } } } };
const wr = Lib.parseWikiSearch(ws, { name: '深大寺', lat: 35.67, lon: 139.548 });
assert.deepStrictEqual([wr.thumb, wr.page, wr.same], ['https://upload.wikimedia.org/a.jpg', 'https://ja.wikipedia.org/wiki/x', true]);
assert.strictEqual(Lib.parseWikiSearch(ws, { name: '深大寺そば 玉乃屋', lat: 35.67, lon: 139.548 }).same, true);
assert.strictEqual(Lib.parseWikiSearch(ws, { name: '神代植物公園', lat: 35.67, lon: 139.548 }).same, false); // 付近の関連する記事
assert.strictEqual(Lib.parseWikiSearch({ query: { pages: { 1: ws.query.pages[1] } } }, { name: '深大寺', lat: 35.67, lon: 139.548 }), null);

// ---- 入力補完・起動時の指定 ----
assert.deepStrictEqual(Lib.parseSuggest({ vocabulary: [{ type: 'category', label: 'ラーメン', query: 'ラーメン' }], results: [{ name: '麺屋A' }, { x: 1 }] }),
  { words: ['ラーメン'], places: ['麺屋A'] });
assert.deepStrictEqual(Lib.parseSuggest(null), { words: [], places: [] });
assert.ok(new URL(Lib.openPoiSuggestUrl('らーめ', { lat: 35.65, lon: 139.54 })).searchParams.get('center') === '139.5400,35.6500');
assert.deepStrictEqual(Lib.localSuggest('近くのカ', []), ['近くのカフェ']);
assert.ok(Lib.localSuggest('らーめ', []).includes('ラーメン'));
assert.deepStrictEqual(Lib.localSuggest('じんだ', [{ name: '深大寺', kana: 'じんだいじ' }]), ['深大寺']);
assert.deepStrictEqual(Lib.localSuggest('', []), []);
assert.deepStrictEqual(Lib.launchParams('?tab=touring'), { tab: 'touring', q: '', gacha: false });
assert.deepStrictEqual(Lib.launchParams('?q=%E8%BF%91%E3%81%8F%E3%81%AE%E9%A3%B2%E9%A3%9F%E5%BA%97&gacha=1'), { tab: null, q: '近くの飲食店', gacha: true });
assert.strictEqual(Lib.launchParams('?tab=evil').tab, null);

// ---- 入れ方の案内 ----
const IPH = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
assert.strictEqual(Lib.platformOf(IPH, false), 'ios-safari');
assert.strictEqual(Lib.platformOf(IPH.replace('Version/18.0', 'CriOS/130.0'), false), 'ios-other');
assert.strictEqual(Lib.platformOf(IPH + ' Line/14.0', false), 'ios-other');
assert.strictEqual(Lib.platformOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36', false), 'android');
assert.strictEqual(Lib.platformOf('Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 Line/14.0', false), 'android-inapp');
assert.strictEqual(Lib.platformOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0', false), 'desktop');
assert.strictEqual(Lib.platformOf(IPH, true), 'installed');

// ---- ドライブコースの種類 ----
assert.strictEqual(Lib.courseType({ id: 'okutama', name: '奥多摩周遊道路' }), 'pick');
assert.strictEqual(Lib.courseType({ id: 'osm:node:1', name: '雁坂峠', pass: true }), 'pass');
assert.strictEqual(Lib.courseType({ id: 'osm:way:1', name: '林道A線', note: '林道（未舗装の区間がないか確認を）' }), 'rindo');
assert.strictEqual(Lib.courseType({ id: 'osm:way:2', name: 'Bスカイライン', toll: true }), 'toll');
assert.strictEqual(Lib.courseType({ id: 'osm:way:3', name: 'C峠線', note: '峠道（約5km）' }), 'toge');
assert.strictEqual(Lib.courseType({ id: 'osm:way:4', name: 'Dパークウェイ', note: 'スカイライン・観光道路' }), 'skyline');
assert.strictEqual(Lib.courseType({ id: 'osm:way:5', name: 'E湖畔道路', note: '海沿い・湖畔の道' }), 'water');
assert.strictEqual(Lib.courseType({ id: 'osm:way:6', name: 'F周遊', note: '景色の道' }), 'scenic');

// ---- 交通費 ----
assert.strictEqual(Lib.fuelCost(100, 15, 170), 1130);
assert.strictEqual(Lib.fuelCost(0, 15, 170), 0);
assert.strictEqual(Lib.tollEstimate(91.6), 2640); // 調布→箱根（実際は ETC で 2,600 円前後）
assert.strictEqual(Lib.tollEstimate(91.6, 'light'), 2150);
assert.strictEqual(Lib.tollEstimate(0.2), 0);
assert.strictEqual(Math.round(Lib.tollKmOf([{ maneuvers: [{ length: 10, toll: true }, { length: 5 }] }, { maneuvers: [{ length: 2.5, toll: true }] }]) * 10) / 10, 12.5);
assert.strictEqual(Lib.trainFare(2), 150);
assert.strictEqual(Lib.trainFare(30), 680); // 37.5km → 38km → 35〜40km の欄
assert.strictEqual(Lib.yen(1234.4), '1,234円');

// ---- 駐車場 ----
assert.ok(decodeURIComponent(Lib.parkingQuery({ lat: 35, lon: 139 }, 500, 1500)).includes('nwr["amenity"="motorcycle_parking"](around:1500,35,139)'));
const pk = Lib.parseParking({ elements: [
  { type: 'way', center: { lat: 35.0005, lon: 139.0 }, tags: { amenity: 'parking', name: '深大寺 駐車場', fee: 'yes', capacity: '30' } },
  { type: 'node', lat: 35.003, lon: 139.0, tags: { amenity: 'parking', motorcycle: 'yes', name: 'タイムズ' } },
  { type: 'node', lat: 35.001, lon: 139.0, tags: { amenity: 'motorcycle_parking', fee: 'no', capacity: '10' } },
  { type: 'node', lat: 35.002, lon: 139.0, tags: { amenity: 'bicycle_parking', motorcycle: 'yes' } },
  { type: 'node', lat: 35.0004, lon: 139.0, tags: { amenity: 'parking', access: 'private', name: '月極' } },
  { type: 'node', lat: 35.0008, lon: 139.0, tags: { amenity: 'parking', access: 'customers', motorcycle: 'no' } },
] }, { name: '深大寺', lat: 35.0, lon: 139.0 });
assert.deepStrictEqual(pk.car.map((x) => [x.name, x.own]), [['深大寺 駐車場', true], ['', false], ['タイムズ', false]]); // 名前が一致した所だけ
assert.deepStrictEqual(pk.bike.map((x) => x.kind), ['バイク専用', '駐輪場（二輪も可）', '駐車場']);
assert.strictEqual(pk.car[0].fee, '有料');
assert.strictEqual(pk.car[1].motoNo, true);
assert.ok(Lib.isParkingWord('バイク駐車場') && Lib.isBikeWord('バイク駐車場') && !Lib.isBikeWord('駐車場'));

// ---- バイクを止められる場所をまとめる ----
const mp = { lat: 35.0, lon: 139.0 };
const mb = Lib.mergeBikeSpots(mp, 1.5, [
  ['OSM', [{ name: 'A', lat: 35.001, lon: 139.0, type: 'バイク専用' }, { name: '遠い', lat: 35.05, lon: 139.0 }]],
  ['live', [{ name: 'A重複', lat: 35.0011, lon: 139.0 }, { name: 'B', lat: 35.003, lon: 139.0, own: true }]],
  ['OpenPOI', [{ name: 'タイムズのB', lat: 35.002, lon: 139.0 }]],
  ['道の駅', [{ name: '道の駅X', lat: 35.0005, lon: 139.0, likely: true }]]]);
assert.deepStrictEqual(mb.map((x) => x.name), ['B', 'A', 'タイムズのB', '道の駅X']);
assert.ok(Lib.MOTO_NAME_RE.test('タイムズのB 調布') && !Lib.MOTO_NAME_RE.test('タイムズ調布'));

// ---- データの更新 ----
assert.deepStrictEqual(Lib.pendingParts({ spots_error: null, cells_error: 'lodging: TimeoutError', moto_error: 'x' }), ['cells', 'moto']);
assert.deepStrictEqual(Lib.pendingParts(null), []);
const nowMs = Date.parse('2026-10-15T10:00:00Z');
assert.deepStrictEqual(Lib.runState({ workflow_runs: [{ status: 'in_progress', run_started_at: '2026-10-15T09:30:00Z' }] }, nowMs).state, 'running');
assert.strictEqual(Lib.runState({ workflow_runs: [{ status: 'in_progress', run_started_at: '2026-10-15T09:30:00Z' }] }, nowMs).startedMin, 30);
assert.strictEqual(Lib.runState({ workflow_runs: [{ status: 'completed', conclusion: 'success', created_at: '2026-10-15T08:00:00Z' }] }, nowMs).state, 'done');
assert.strictEqual(Lib.runState({ workflow_runs: [{ status: 'completed', conclusion: 'failure', created_at: '2026-10-15T08:00:00Z' }] }, nowMs).state, 'failed');
assert.strictEqual(Lib.runState({ workflow_runs: [{ status: 'queued', created_at: '2026-10-15T09:59:00Z' }] }, nowMs).state, 'queued');
assert.strictEqual(Lib.runState({}).state, null);

// ---- 前もって集めた駐車場 ----
const pc = Lib.parkFromCell({ la: 35.0, lo: 139.0, n: 'A', f: 1, c: 60, a: 1 });
assert.deepStrictEqual([pc.fee, pc.capacity, pc.access, pc.kind], ['有料', 60, 'customers', '駐車場']);
assert.strictEqual(Lib.maybeMoto(pc), true);
assert.strictEqual(Lib.maybeMoto(Lib.parkFromCell({ la: 35, lo: 139, n: 'タイムズ調布', c: 80 })), false); // コインパーキング
assert.strictEqual(Lib.maybeMoto(Lib.parkFromCell({ la: 35, lo: 139, n: 'タイムズのB調布', c: 80 })), true);
assert.strictEqual(Lib.maybeMoto(Lib.parkFromCell({ la: 35, lo: 139, c: 10 })), false); // 小さい
assert.strictEqual(Lib.maybeMoto(Lib.parkFromCell({ la: 35, lo: 139, c: 100, m: 0 })), false); // 二輪不可
const own = Lib.markOwn([Lib.parkFromCell({ la: 35.0005, lo: 139.0, n: '深大寺駐車場' })], { name: '深大寺', lat: 35.0, lon: 139.0 });
assert.strictEqual(own[0].own, true);
assert.strictEqual(Lib.dedupeNear([{ lat: 35, lon: 139 }, { lat: 35.0001, lon: 139 }, { lat: 35.01, lon: 139 }]).length, 2);

// ---- Google マップの駐車場情報 ----
assert.deepStrictEqual(Lib.parkingOptionsText({ freeParkingLot: true, paidStreetParking: true }), { has: true, text: '無料駐車場・有料の路上駐車（パーキングメーター）あり' });
assert.deepStrictEqual(Lib.parkingOptionsText({ freeParkingLot: false, paidParkingLot: false }), { has: false, text: '駐車場なし' });
assert.strictEqual(Lib.parkingOptionsText(null), null);
assert.strictEqual(Lib.parkingOptionsText({}), null);
const ppk = Lib.parsePlacesPhotos({ places: [{ location: { latitude: 35.671, longitude: 139.551 }, parkingOptions: { freeParkingLot: true } }] }, { lat: 35.67, lon: 139.55 }, 'K');
assert.deepStrictEqual(ppk.parking, { freeParkingLot: true });

// ---- 公式のバイク駐車場 ----
const om = Lib.officialMoto({ name: '区営A', lat: 35.0012, lon: 139.0, moto: true, moped: true, fee: '100円/時', hours: '24時間', capacity: 20, muni: '中央区', src: '区営二輪車駐車場一覧', srcUrl: 'https://x' });
assert.deepStrictEqual([om.kind, om.cap, om.official, om.moped, om.addr], ['公式・自動二輪可', 20, true, false, '']);
assert.strictEqual(Lib.officialMoto({ name: 'D', lat: 43, lon: 141, moto: true, addr: '札幌市中央区南1条西2丁目' }).addr, '札幌市中央区南1条西2丁目');
assert.strictEqual(Lib.officialMoto({ name: 'B', lat: 35, lon: 139, moto: false, moped: true }).kind, '公式・原付のみ');
assert.strictEqual(Lib.officialMoto({ name: 'C', lat: 35, lon: 139, moto: true, moped: true, ccUnknown: true }).kind, '公式・二輪可（排気量の制限は現地で確認）');
const mb2 = Lib.mergeBikeSpots({ lat: 35, lon: 139 }, 3, [['OSM', [{ name: 'OSMの同じ所', lat: 35.0012, lon: 139.0 }]], ['公式', [om]]]);
assert.deepStrictEqual(mb2.map((x) => x.name), ['区営A']); // 重なったら公式を残す

// ---- Google マップの経路リンク ----
const tok = (lat, lon) => { const b = Buffer.alloc(10); b[0] = 0x15; b.writeInt32LE(Math.round(lat * 1e6), 1); b[5] = 0x1d; b.writeInt32LE(Math.round(lon * 1e6), 6); return b.toString('base64'); };
assert.deepStrictEqual(Lib.geocodeToken(tok(35.5, 139.25)), { lat: 35.5, lon: 139.25 });
assert.strictEqual(Lib.geocodeToken('xx'), null);
const gurl = `https://maps.google.com/?geocode=${tok(35.9, 139.6)};${tok(36.3, 139.5)};${tok(36.9, 139.8)}&daddr=${encodeURIComponent('道の駅 A、〒327-0313 栃木県佐野市')}+to:${encodeURIComponent('B峠')}&saddr=${encodeURIComponent('C SA')}&dirflg=d`;
const gp = Lib.parseGmapsRoute(`共有: ${gurl}`);
assert.deepStrictEqual(gp.map((p) => [p.name, p.lat, p.lon]), [['C SA', 35.9, 139.6], ['道の駅 A', 36.3, 139.5], ['B峠', 36.9, 139.8]]);
assert.strictEqual(gp[1].addr, '栃木県佐野市');
const gr = Lib.routeFromPlaces(gp, 7);
assert.deepStrictEqual([gr.name, gr.lat, gr.waypoints], ['C SA → B峠', 36.9, [[35.9, 139.6], [36.3, 139.5]]]);
assert.strictEqual(Lib.routeFromPlaces([{ name: 'a', lat: 1, lon: 1 }, { name: 'b', lat: 2, lon: 2 }, { name: 'c', lat: 3, lon: 3 }, { name: 'd', lat: 4, lon: 4 }], 2).cut, 1);
const gd = Lib.parseGmapsRoute('https://www.google.com/maps/dir/%E8%93%AE%E7%94%B0SA/35.1,139.2/%E5%8F%A4%E5%B3%B0/@35,139,9z/data=!4m10!1m5!1m1!1s0x1:0x2!2m2!1d139.66!2d35.99!1m0!1m5!1m1!1s0x3:0x4!2m2!1d139.5!2d36.65');
assert.deepStrictEqual(gd.map((p) => [p.name, p.lat, p.lon]), [['蓮田SA', 35.99, 139.66], ['35.1000,139.2000', 35.1, 139.2], ['古峰', 36.65, 139.5]]);
assert.deepStrictEqual(Lib.parseGmapsRoute('https://www.google.com/maps/place/X/@35.5,139.5,15z').map((p) => [p.name, p.lat]), [['X', 35.5]]);
assert.strictEqual(Lib.parseGmapsRoute('こんにちは'), null);
assert.strictEqual(Lib.isShortMapsUrl('見て https://maps.app.goo.gl/abc?g_st=il'), true);
// ---- 高速道路のコース・分岐の案内 ----
const hwRoad = { points: [[35, 139]], hw: [[35.0, 139.0], [35.0, 139.1], [35.1, 139.1], [35.0, 139.0]] };
const cp = Lib.coursePoints(hwRoad);
assert.strictEqual(cp.length, 3); // 一周するコースは始点に戻らない
assert.ok(cp.every((p) => p.hw) && Math.abs(cp[0].heading - 90) < 1);
assert.strictEqual(Lib.loopPoints({ lat: 1, lon: 1 }, { points: [[2, 2], [3, 3]] }).length, 4);
assert.strictEqual(Lib.jaOnly('右方向です。その先C1/首都高速都心環状線、神田橋/箱崎/Kandabashi/Hakozaki方面です。'), '右方向です。その先C1/首都高速都心環状線、神田橋/箱崎方面です。');
assert.strictEqual(Lib.jaOnly('左方向です。その先4/首都高速4号新宿線/Route 4 Shinjuku Lineです。'), '左方向です。その先4/首都高速4号新宿線です。');
const legs = [{ shape: '', maneuvers: [{ type: 1, length: 2 }, { type: 24, toll: true, instruction: '左方向です。', length: 1, begin_shape_index: 0 },
  { type: 24, toll: true, instruction: '右方向です。その先E20、新宿方面です。', length: 1, begin_shape_index: 0 }, { type: 4, length: 0 }] }];
// JCT 名も行き先もない案内は出さない
assert.deepStrictEqual(Lib.jctGuide(legs).map((x) => [x.km, x.text]), [[3, '右方向です。その先E20、新宿方面です。']]);
assert.strictEqual(Lib.safeSpot([{ heading: 92, edge: { classification: { classification: 'motorway', use: 'road' } } }], 90), true);
assert.strictEqual(Lib.safeSpot([{ heading: 92, edge: { classification: { classification: 'motorway', use: 'road' } } }, { heading: 270, edge: { classification: { classification: 'motorway', use: 'road' } } }], 90), true); // 反対車線は可
assert.strictEqual(Lib.safeSpot([{ heading: 270, edge: { classification: { classification: 'motorway', use: 'road' } } }], 90), false); // 反対車線だけ
assert.strictEqual(Lib.safeSpot([{ heading: 90, edge: { classification: { classification: 'motorway', use: 'ramp' } } }], 90), false); // ランプ
assert.strictEqual(Lib.safeSpot([{ heading: 90, edge: { classification: { classification: 'primary', use: 'road' } } }], 90), false); // 一般道
assert.strictEqual(Lib.safeSpot([], 90), false);
const sm = Lib.samplesIn([[139.0, 35.0], [139.1, 35.0], [139.2, 35.0]], [34.9, 139.05, 35.1, 139.25], 4);
assert.ok(sm.length >= 3 && sm.every((p) => p.lon >= 139.05));
assert.deepStrictEqual(Lib.spreadPick([1, 2, 3, 4, 5], 3), [1, 3, 5]);
// ---- 種類・時間帯・コースの色 ----
assert.deepStrictEqual(Lib.refineGenres({ name: '東京タワー', genres: ['sightseeing', 'scenic'], tags: ['夜景'] }).genres, ['viewpoint', 'nightview']);
assert.deepStrictEqual(Lib.refineGenres({ name: 'X', note: '展望台', genres: ['scenic'] }).genres, ['viewpoint']);
assert.deepStrictEqual(Lib.refineGenres({ name: '深大寺', genres: ['temple'] }).genres, ['temple']);
const d0 = new Date(2026, 9, 17);
assert.strictEqual(Lib.timeBandState({ genres: ['viewpoint'], indoor: false }, 'late', d0), 'outdoor');
assert.strictEqual(Lib.timeBandState({ genres: ['museum'], indoor: true }, 'late', d0), null);
assert.strictEqual(Lib.timeBandState({ genres: ['museum'], indoor: true }, 'day', d0), 'ok');
assert.strictEqual(Lib.timeBandState({ genres: ['food'], oh: 'Mo-Su 11:00-02:00' }, 'late', d0), 'open');
assert.strictEqual(Lib.timeBandState({ genres: ['food'], oh: 'Mo-Su 11:00-15:00' }, 'night', d0), null);
assert.strictEqual(Lib.timeBandState({ genres: ['nightview'], indoor: true }, 'night', d0), 'ok');
assert.strictEqual(Lib.timeBandState({ kind: 'michinoeki', genres: ['sightseeing'] }, 'late', d0), 'h24');
assert.strictEqual(Lib.timeBandState({ kind: 'peak', genres: ['scenic'] }, 'late', d0), null);
assert.strictEqual(Lib.timeBandState({ genres: ['scenic', 'garden'], indoor: false }, 'late', d0), null); // 庭園・並木は出さない
assert.strictEqual(Lib.timeBandState({ kind: 'lake', genres: ['scenic'] }, 'late', d0), 'outdoor');
assert.strictEqual(Lib.timeBandState({ genres: ['viewpoint'], fee: '大人300円' }, 'late', d0), null);
assert.strictEqual(Lib.roadNightClosed({ closed: '夜間通行止め（19時〜翌8時）' }), true);
assert.strictEqual(Lib.roadNightClosed({ closed: '冬季閉鎖', note: '夜景が美しい' }), false);
assert.strictEqual(Lib.roadNightView({ note: '夜景が美しい' }), true);
assert.ok(/^hsl\(\d+, \d+%, \d+%\)$/.test(Lib.routeShade('#d6336c', 'a')));
assert.notStrictEqual(Lib.routeShade('#d6336c', 'road-1'), Lib.routeShade('#d6336c', 'road-2'));

assert.deepStrictEqual(Lib.tollSpans([{ maneuvers: [{ length: 2 }, { toll: true, length: 3 }, { toll: true, length: 1 }, { length: 1 }, { toll: true, length: 2 }] }]), [[2, 6], [7, 9]]);
assert.strictEqual(Lib.inSpans(5, [[2, 6]]), true);
assert.strictEqual(Lib.inSpans(6.5, [[2, 6]]), false);

// ---- コースをつなげる ----
const ca = { id: 'a', name: 'C1一周（都心）', points: [[35, 139], [35.1, 139.1], [35.2, 139]], hw: [[35, 139], [35.1, 139.1], [35, 139]], toll: true, fee: '300円', closedMonths: [] };
const cb = { id: 'b', name: '夜景周回', points: [[35.3, 139], [35.4, 139]], hw: [[35.3, 139], [35.4, 139.1], [35.3, 139]], toll: true, fee: '300円', alerts: ['x'] };
const ch = Lib.chainRoad([ca, cb]);
assert.strictEqual(ch.id, 'chain:a+b');
assert.strictEqual(ch.name, 'C1一周 → 夜景周回');
assert.strictEqual(ch.fee, '300円');
assert.deepStrictEqual(ch.alerts, ['x']);
assert.strictEqual(Lib.coursePoints(ch).length, 5); // 1 本目は一周を終える（3 点）＋ 2 本目は始点に戻らない（2 点）
assert.ok(Array.isArray(ch.hw));
assert.strictEqual(Lib.chainRoad([ca, { id: 'c', name: 'c', points: [[1, 1], [2, 2], [3, 3]] }]).hw, undefined); // 一般道が混ざると hw なし
assert.strictEqual(Lib.loopPoints({ lat: 0, lon: 0 }, ch).length, 7);
assert.strictEqual(Lib.chainRoad([ca, cb], 'cw').id, 'chain:a+b@cw');
assert.ok(Lib.chainRoad([ca, cb], 'cw').name.endsWith('（外周を時計回り）'));
assert.strictEqual(Lib.capPoints([[1, 2, 3, 4, 5, 6], [7, 8, 9]], 6).length, 6);
assert.deepStrictEqual(Lib.capPoints([[1, 2, 3, 4, 5, 6], [7, 8, 9]], 6).filter((x) => [1, 6, 7, 9].includes(x)), [1, 6, 7, 9]); // 各コースの最初と最後は残る
// 外周: 辺を 1 本共有する 2 つの四角（左は時計回り、右は反時計回りに走るコース）。共有した辺の点は外れ、残りが外周の順に並ぶ
const sqL = (x0) => [[x0, 0], [x0 + 0.1, 0], [x0 + 0.1, 0.1], [x0, 0.1], [x0, 0]].flatMap(([x, y], k, a) => (k ? Array.from({ length: 10 }, (_, s) => [a[k - 1][0] + (x - a[k - 1][0]) * (s + 1) / 10, a[k - 1][1] + (y - a[k - 1][1]) * (s + 1) / 10]) : [[x, y]]));
const left = [{ lat: 0.05, lon: 0, heading: 0 }, { lat: 0.1, lon: 0.05, heading: 90 }, { lat: 0.05, lon: 0.1, heading: 180 }, { lat: 0, lon: 0.05, heading: 270 }]; // 時計回り
const right = [{ lat: 0, lon: 0.15, heading: 90 }, { lat: 0.05, lon: 0.2, heading: 0 }, { lat: 0.1, lon: 0.15, heading: 270 }, { lat: 0.05, lon: 0.1, heading: 180 }]; // 反時計回り（最後の点は左と共有の辺）
const oc = Lib.outerFromPoints([left, right], [sqL(0), sqL(0.1)], 'ccw', { lat: 0.05, lon: -1 });
assert.ok(!oc.some((p) => p.lon === 0.1)); // 共有した辺の点は外れる
assert.strictEqual(oc.length, 5); // 6 点のうち起点に一番近い (0.05, 0) を外す
assert.deepStrictEqual(oc.map((p) => [p.lat, p.lon, Math.round(p.heading)]), [[0, 0.05, 90], [0, 0.15, 90], [0.05, 0.2, 0], [0.1, 0.15, 270], [0.1, 0.05, 270]]); // 反時計回り。左の点は向きを反対に
assert.strictEqual(Lib.outerFromPoints([left, right.map((p) => ({ ...p, lon: p.lon + 5 }))], [sqL(0), sqL(5.1)], 'ccw', { lat: 0, lon: -1 }), null); // 重ならないコース

// 温泉地（Wikidata）: ★厳選にしない。読み（ひらがな）でも温泉地の名前でも探せ、温泉地に当たればその中の入浴施設も出る
{
  const beppu = Lib.onsenSpot({ id: 'wd-Q1', name: '別府温泉', kana: 'べっぷおんせん', lat: 33.2803, lon: 131.5, pref: '大分', area: true, wp: '別府温泉' });
  assert.deepStrictEqual([beppu.id, beppu.genres, beppu.wp, beppu.onsenArea, Lib.isCurated(beppu)], ['wd:Q1', ['onsen', 'sightseeing'], 'ja:別府温泉', true, false]);
  assert.ok(Lib.isCurated({ id: 'oita-takegawara' }) && !Lib.isCurated({ id: 'osm:node:1' }));
  const take = { id: 'osm:way:1', name: '竹瓦温泉', lat: 33.2791, lon: 131.5045, genres: ['onsen'] };
  const far = { id: 'osm:way:2', name: '亀川温泉', lat: 33.33, lon: 131.49, genres: ['onsen'] };
  const muse = { id: 'osm:way:3', name: '別府市美術館', lat: 33.28, lon: 131.501, genres: ['museum'] };
  const o = { ...cfg, origin: { lat: 33.2, lon: 131.6 } };
  const names = (q) => Lib.searchSpots([beppu, take, far, muse], q, o, new Set(), 'car').map((s) => s.name).sort();
  assert.deepStrictEqual(names('別府温泉'), ['別府温泉', '竹瓦温泉']); // 2km の外の亀川・温泉でない美術館は出さない
  assert.deepStrictEqual(names('べっぷおんせん'), ['別府温泉', '竹瓦温泉']);
  assert.deepStrictEqual(names('ベップオンセン'), ['別府温泉', '竹瓦温泉']); // カタカナでも
  assert.deepStrictEqual(names('別府'), ['別府市美術館', '別府温泉', '竹瓦温泉']);
  assert.strictEqual(Lib.searchSpots([take, beppu], '別府温泉', o, new Set(), 'car')[0].name, '別府温泉'); // 温泉地が先頭
  // ひらがなと漢字を混ぜた「のべはの湯」も、ローマ字の名前から作った読み（のべはのゆつるはし）に当たる
  const nobeha = { id: 'osm:way:9', name: '延羽の湯', kana: 'のべはのゆつるはし', lat: 34.6657, lon: 135.536, genres: ['onsen'] };
  assert.deepStrictEqual(['のべはの湯', 'のべはのゆ', '延羽の湯', 'ノベハノユ'].map((q) => Lib.searchSpots([nobeha], q, o, new Set(), 'car').length), [1, 1, 1, 1]);
  // 同じ名前で 3km 以内の重複は除く（遠い同名の温泉は別の場所なので残す）
  const kuro = Lib.onsenSpot({ id: 'wd-Q2', name: '黒川温泉', lat: 33.078, lon: 131.141, pref: '熊本', area: true });
  const kuro2 = Lib.onsenSpot({ id: 'wd-Q3', name: '黒川温泉', lat: 38.1, lon: 139.9, pref: '山形', area: true });
  assert.deepStrictEqual(Lib.dropSameName([kuro, kuro2], [{ id: 'kumamoto-kurokawa-onsen', name: '黒川温泉', lat: 33.0757, lon: 131.1418 }]).map((s) => s.pref), ['山形']);
}

// 雨雲（気象庁）: 実況→ナウキャスト→降水短時間予報の順のコマ、時刻に合うコマ、色→雨の強さ、出発時刻の判定
{
  const n1 = ['20261022052000', '20261022051500', '20261022041500'].map((v) => ({ basetime: v, validtime: v }));
  const n2 = [{ basetime: '20261022052000', validtime: '20261022052500' }, { basetime: '20261022052000', validtime: '20261022062000' }];
  const rs = [
    { basetime: '20261022051000', validtime: '20261022051000', member: 'immed', elements: ['rasrf'] }, // 解析値（使わない）
    { basetime: '20261022051000', validtime: '20261022061000', member: 'immed', elements: ['rasrf'] }, // ナウキャストと重なる
    { basetime: '20261022051000', validtime: '20261022071000', member: 'immed', elements: ['rasrf'] },
    { basetime: '20261022050000', validtime: '20261022071000', member: 'immed', elements: ['rasrf'] }, // 古い発表
    { basetime: '20261022050000', validtime: '20261022120000', member: 'none', elements: ['rasrf'] },
    { basetime: '20261022050000', validtime: '20261022120000', member: 'none', elements: ['sjfcstmap'] },
  ];
  const fr = Lib.jmaFrames(n1, n2, rs, 60);
  const utc = (h, m) => Date.UTC(2026, 9, 22, h, m);
  assert.deepStrictEqual(fr.map((f) => [f.kind, new Date(f.t).toISOString().slice(11, 16)]),
    [['past', '05:15'], ['now', '05:20'], ['nowcast', '05:25'], ['nowcast', '06:20'], ['fcst', '07:10'], ['fcst', '12:00']]); // 1 時間より前の実況は使わない
  assert.ok(fr[4].url.includes('/rasrf/20261022051000/immed/20261022071000/surf/rasrf/{z}/{x}/{y}.png'));
  assert.ok(fr[1].url.endsWith('/nowc/20261022052000/none/20261022052000/surf/hrpns/{z}/{x}/{y}.png'));
  assert.strictEqual(Lib.frameAt(fr, utc(5, 21)).kind, 'now');
  assert.strictEqual(Lib.frameAt(fr, utc(6, 21)).kind, 'nowcast'); // ナウキャストと降水短時間予報が重なる時刻はナウキャスト
  assert.strictEqual(Lib.frameAt(fr, utc(6, 40)).t, utc(7, 10)); // 6:10〜7:10 の 1 時間の雨量のコマ
  assert.strictEqual(Lib.frameAt(fr, utc(9, 0)), null); // 予報の間（7:10〜11:00）はコマがない
  assert.strictEqual(Lib.frameAt(fr, utc(13, 0)), null);
  // 色（気象庁の凡例そのまま）→ 段階。透明・地図の色はなし
  assert.deepStrictEqual(Lib.RAIN_COLORS.map(([r, g, b]) => Lib.rainLevel(r, g, b, 255)), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepStrictEqual([Lib.rainLevel(160, 210, 255, 0), Lib.rainLevel(30, 30, 30, 255), Lib.rainLevel(158, 208, 253, 255)], [0, 0, 2]);
  // タイルの画素: 東京駅付近は z=8 で (227, 100)
  const tp = Lib.tilePixel(35.6812, 139.7671, 8);
  assert.deepStrictEqual([tp.x, tp.y], [227, 100]);
  assert.ok(tp.px >= 0 && tp.px < 256 && tp.py >= 0 && tp.py < 256);
  // ルート上の位置: 出発から半分の時間でちょうど真ん中、走っていない時刻は null
  const ln = [[139, 35], [139.2, 35]];
  const mid = Lib.routeAt(ln, 60, 0, 30 * 60e3);
  assert.ok(Math.abs(mid.lon - 139.1) < 1e-6 && Math.abs(mid.lat - 35) < 1e-9);
  assert.strictEqual(Lib.routeAt(ln, 60, 0, -1), null);
  assert.strictEqual(Lib.routeAt(ln, 60, 0, 61 * 60e3), null);
  // 出発時刻の候補: 次の 30 分区切りから、予報の終わりの 30 分前まで
  const opts = Lib.departOptions(utc(5, 22), utc(8, 0), 30);
  assert.deepStrictEqual(opts.map((t) => new Date(t).toISOString().slice(11, 16)), ['05:30', '06:00', '06:30', '07:00', '07:30']);
  const v = Lib.rainVerdict([0, 1, 3, null, 2, 0]);
  assert.deepStrictEqual(v, { max: 3, wet: 2, drizzle: 1, unknown: 1, firstWet: 2 });
  assert.deepStrictEqual(Lib.rainVerdict([0, 0]).wet, 0);
  // 雨を避ける経由地: 東へ進むルートの雨の区間から、北（左）と南（右）へずらす。出発地・目的地の近くの雨は避けられないので数えない
  const from = { lat: 35, lon: 139 }, to = { lat: 35, lon: 140 };
  const wet = [{ lat: 35, lon: 139.4 }, { lat: 35, lon: 139.5 }, { lat: 35, lon: 139.6 }, { lat: 35, lon: 139.01 }];
  const vs = Lib.rainDetourVias(wet, from, to, [15]);
  assert.deepStrictEqual(vs.map((v) => v.side), ['北', '南']);
  assert.ok(Math.abs(vs[0].lat - (35 + 15 / 111)) < 1e-6 && Math.abs(vs[0].lon - 139.5) < 1e-6, JSON.stringify(vs[0]));
  assert.ok(Math.abs(vs[1].lat - (35 - 15 / 111)) < 1e-6);
  assert.deepStrictEqual(Lib.rainDetourVias([{ lat: 35, lon: 139.02 }, { lat: 35, lon: 139.99 }], from, to), []); // 出発地・目的地の雨だけ
  assert.deepStrictEqual(Lib.rainDetourVias([{ lat: 35.5, lon: 139.5 }], from, to, [10]).map((v) => v.side), ['北', '南']); // 1 点ならルート全体の向き
  assert.deepStrictEqual(Lib.nearestOnLine([[139, 35], [139.5, 35.2], [140, 35]], { lat: 35.21, lon: 139.48 }), { lat: 35.2, lon: 139.5 });
}

// 深夜: 営業時間の分からない屋外の展望台は出す。深夜は閉まると分かっている所（lateClosed）は出さない。夜（19〜24時）は出す
{
  const deck = { genres: ['viewpoint', 'nightview'], indoor: false, lateClosed: true };
  const hill = { genres: ['viewpoint'], indoor: false };
  assert.deepStrictEqual([Lib.timeBandState(deck, 'late'), Lib.timeBandState(deck, 'night'), Lib.timeBandState(hill, 'late')], [null, 'outdoor', 'outdoor']);
}

console.log('lib: ALL PASS');
// 経由地の横に同じ向きの一般道のランプ（出入口）があれば避ける
{
  const mw = { heading: 5, distance: 0, edge: { classification: { classification: 'motorway', use: 'road' } } };
  const ramp = (h, d) => ({ heading: h, distance: d, edge: { classification: { classification: 'primary', use: 'ramp' } } });
  assert.strictEqual(Lib.rampFree([mw, ramp(1, 42)], 5), false); // 中環大井南入口の横
  assert.strictEqual(Lib.rampFree([mw, ramp(186, 42)], 5), true); // 反対向きのランプは可
  assert.strictEqual(Lib.rampFree([mw, ramp(1, 80)], 5), true); // 離れていれば可
  assert.strictEqual(Lib.rampFree([mw], 5), true);
}
// 経由地は走る距離で均等に（候補が前半に固まっていても、後半の候補を残す）
{
  const xs = [0, 1, 2, 3, 4, 5, 6, 30].map((along) => ({ along }));
  assert.deepStrictEqual(Lib.spreadAlong(xs, 3).map((x) => x.along), [0, 6, 30]);
  assert.deepStrictEqual(Lib.spreadAlong(xs.slice(0, 2), 3).map((x) => x.along), [0, 1]);
}
// JCT の分かれ道（同じ向きの高速のランプ）の横も避ける（江北JCT の川口線）
assert.strictEqual(Lib.rampFree([{ heading: 60, distance: 0, edge: { classification: { classification: 'motorway', use: 'road' } } },
  { heading: 55, distance: 20, edge: { classification: { classification: 'motorway', use: 'ramp' } } }], 60), false);
// 有料区間のあいだの無料の自動車専用道路は、降りたことにしない
assert.deepStrictEqual(Lib.tollSpans([{ maneuvers: [{ toll: true, length: 3 }, { highway: true, length: 1 }, { toll: true, length: 2 }, { length: 1 }, { toll: true, length: 1 }] }]), [[0, 6], [7, 8]]);
// 経由地が 9 件を超えるナビは、立ち寄りの所で区切る
{
  const w = (i, stop) => ({ i, stop });
  const xs = [w(0), w(1), w(2), w(3, true), w(4), w(5), w(6), w(7), w(8, true), w(9), w(10), w(11)];
  const legs = Lib.splitLegs(xs, 9);
  assert.deepStrictEqual(legs.map((l) => [l.waypoints.map((x) => x.i), l.end && l.end.i]), [[[0, 1, 2, 3, 4, 5, 6, 7], 8], [[9, 10, 11], null]]);
  const noStop = Lib.splitLegs(xs.map((x) => w(x.i)), 9); // 立ち寄りがなければ 9 件＋目的地で区切る
  assert.deepStrictEqual(noStop.map((l) => [l.waypoints.length, l.end && l.end.i]), [[9, 9], [2, null]]);
  assert.deepStrictEqual(Lib.splitLegs(xs.slice(0, 9), 9), [{ waypoints: xs.slice(0, 9), end: null }]); // 9 件までは 1 つ
  assert.ok(Lib.splitLegs(xs.slice(0, 9), 9)[0].waypoints.length <= 9 && legs.every((l) => l.waypoints.length <= 9));
}
