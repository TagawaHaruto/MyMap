// MyMap の純粋関数。画面にもネットにも依存しない（node lib.test.js で検証）。
const Lib = (() => {
  const rad = (d) => d * Math.PI / 180;
  // 絞り込みに出す都道府県（ほかは「その他」）。全国で使えるよう、アプリが起点の近くに多いものに入れ替える（setMainPrefs）
  let MAIN_PREFS = ['東京', '神奈川', '埼玉', '千葉', '山梨'];
  const setMainPrefs = (list) => { MAIN_PREFS = list; };

  function haversineKm(a, b) {
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  }

  // ponytail: 直線距離÷平均速度の概算。実際とずれたら config.speedsKmh / trainOverheadMin を調整
  function travelMinutes(km, mode, cfg) {
    const min = km / cfg.speedsKmh[mode] * 60;
    return Math.round(mode === 'train' ? min + cfg.trainOverheadMin : min);
  }

  const prefGroup = (p) => (p == null ? null : MAIN_PREFS.includes(p) ? p : 'その他');

  // 手作業で確かめた★厳選か（自動で集めた OpenStreetMap・Wikidata の温泉地・立ち寄り候補・OpenPOI 以外）
  const isCurated = (s) => !s.poi && !s.op && !/^(osm|wd):/.test(String(s.id));
  // 一覧の段: 0=厳選・⭐、1=公式サイトか Wikipedia がある、2=その他（自動収集の名前だけの場所など）
  function tierOf(s, favs) {
    if (favs && favs.has(s.id)) return 0;
    if (isCurated(s)) return 0;
    return s.url || s.wp ? 1 : 2;
  }
  const byTier = (a, b) => a.tier - b.tier || a.minutes - b.minutes;

  // 起点から見た8方位（N, NE, E, SE, S, SW, W, NW）
  const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  function direction(origin, p) {
    const y = Math.sin(rad(p.lon - origin.lon)) * Math.cos(rad(p.lat));
    const x = Math.cos(rad(origin.lat)) * Math.sin(rad(p.lat)) - Math.sin(rad(origin.lat)) * Math.cos(rad(p.lat)) * Math.cos(rad(p.lon - origin.lon));
    const deg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    return DIRS[Math.round(deg / 45) % 8];
  }

  function filterSpots(items, f, cfg) {
    const out = [];
    for (const s of items) {
      if (f.rainy && s.indoor !== true) continue;
      if (f.prefs.size && s.pref && !f.prefs.has(prefGroup(s.pref))) continue;
      if (f.genres.size && !s.genres.some((g) => f.genres.has(g))) continue;
      if (f.dirs && f.dirs.size && !f.dirs.has(direction(cfg.origin, s))) continue;
      const km = haversineKm(cfg.origin, s);
      // 「時間制限なし」は、データを読み込む範囲（起点から poiRadiusKm）まで。全国で使うとき、関東の厳選スポットが遠くの地方の一覧に出ないように
      if (f.maxMin == null && cfg.poiRadiusKm && km > cfg.poiRadiusKm) continue;
      const minutes = travelMinutes(km, f.mode, cfg);
      if (f.maxMin != null && minutes > f.maxMin) continue;
      out.push({ ...s, minutes, tier: tierOf(s, f.favs) });
    }
    return out.sort(byTier);
  }

  // 名前検索用: 全角半角・大小文字・カタカナ/ひらがな・空白の違いを無視する
  const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase()
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60)).replace(/\s/g, '');

  // 1 文字入力するたびに 1.4 万件を正規化し直さないよう、項目ごとの検索用文字列を覚えておく
  const normCache = new WeakMap();
  const haystack = (s) => {
    let h = normCache.get(s);
    if (h === undefined) { h = [s.name, s.kana, s.note, ...(s.tags || [])].map(norm).join('\u0000'); normCache.set(s, h); }
    return h;
  };

  // 飲食のジャンル: 「ラーメン」「ハンバーグ」などで検索したとき、同じジャンルの呼び方もまとめて探す
  // （OpenStreetMap の料理の種類は note に入っている。名前に含まれることも多い）
  const FOOD_CATS = [
    ['ラーメン', ['ラーメン', '拉麺', '中華そば', 'つけ麺', 'つけめん', '担々麺', 'タンメン', '家系', 'ramen']],
    ['そば・うどん', ['そば', '蕎麦', 'うどん', '饂飩', 'soba', 'udon']],
    ['寿司', ['寿司', '鮨', 'すし', 'sushi']],
    ['焼肉', ['焼肉', '焼き肉', 'ホルモン', 'yakiniku']],
    ['ハンバーグ・洋食', ['ハンバーグ', '洋食', 'ステーキ', 'オムライス', 'グリル', 'ビストロ', 'steak']],
    ['カレー', ['カレー', 'インド', 'ネパール', 'curry']],
    ['中華', ['中華', '餃子', '飯店', '中国料理', '小籠包']],
    ['イタリアン', ['イタリアン', 'パスタ', 'ピザ', 'ピッツァ', 'トラットリア', 'italian', 'pizza']],
    ['和食・定食', ['和食', '定食', '食堂', 'とんかつ', '天ぷら', '天丼', '割烹', '料亭', 'うなぎ', '鰻']],
    ['海鮮', ['海鮮', '魚', '漁港', '浜焼', '刺身', 'seafood']],
    ['カフェ', ['カフェ', '喫茶', '珈琲', 'コーヒー', 'cafe', 'coffee']],
    ['パン・スイーツ', ['パン・', 'ベーカリー', 'ブーランジェリー', 'ケーキ', '菓子', 'スイーツ', 'パティスリー', 'ドーナツ', 'ジェラート', 'bakery']],
    ['ハンバーガー', ['バーガー', 'burger']],
    ['居酒屋', ['居酒屋', '酒場', '炉端', '焼き鳥', '焼鳥', 'やきとり', '串焼', 'izakaya']],
  ];
  const FOOD_KEYS = new Map(FOOD_CATS.map(([label, words]) => [label, words.map(norm)]));
  const FOOD_NOT = { 'そば・うどん': [norm('中華そば')] }; // 「そば」で中華そば（ラーメン）を出さない
  // 検索語 → 探す文字列の一覧（ジャンル名・その呼び方なら全部の呼び方）
  // 「のべはの湯」のように、ひらがなと漢字を混ぜて打ったときも読み（kana）に当たるよう、温泉の決まった言葉だけ読みにした形でも探す
  const KANJI_READ = [['温泉', 'おんせん'], ['湯', 'ゆ']];
  function searchKeys(q) {
    const k = norm(q);
    for (const [label, keys] of FOOD_KEYS) if (norm(label) === k || keys.includes(k)) return Object.assign([...keys], { label });
    if (!k) return [];
    const alt = KANJI_READ.reduce((s, [a, b]) => s.split(a).join(b), k);
    return alt !== k ? [k, alt] : [k];
  }
  const matchKeys = (s, keys) => {
    let h = haystack(s);
    for (const n of FOOD_NOT[keys.label] || []) h = h.split(n).join('\u0000');
    return keys.some((k) => h.includes(k));
  };
  const inFoodCat = (s, label) => matchKeys(s, Object.assign([...(FOOD_KEYS.get(label) || [])], { label }));

  function searchSpots(items, q, cfg, favs, mode, limit = 50) {
    const keys = searchKeys(q);
    if (!keys.length) return [];
    const out = [], hit = new Set();
    for (const s of items) {
      if (!matchKeys(s, keys)) continue;
      hit.add(s);
      // 名前で当たった温泉地（「別府温泉」で別府温泉）は一番上に。その中の施設はその下に並ぶ
      out.push({ ...s, minutes: travelMinutes(haversineKm(cfg.origin, s), mode, cfg), tier: s.onsenArea ? -1 : tierOf(s, favs) });
    }
    // 温泉地（「別府温泉」など）に当たったら、その中の入浴施設も出す（施設の名前に温泉地の名前が入っていないことが多い）
    const areas = out.filter((s) => s.onsenArea).slice(0, 3);
    if (areas.length) {
      for (const s of items) {
        if (hit.has(s) || s.onsenArea || !(s.genres || []).includes('onsen') || !areas.some((a) => haversineKm(a, s) <= ONSEN_AREA_KM)) continue;
        out.push({ ...s, minutes: travelMinutes(haversineKm(cfg.origin, s), mode, cfg), tier: tierOf(s, favs) });
      }
    }
    // 同じ場所が厳選・自動収集・立ち寄り候補に重複していても 1 件にする（約 1km 以内の同名）
    const seen = new Set();
    return out.sort(byTier).filter((s) => {
      const k = `${norm(s.name)}@${s.lat.toFixed(2)},${s.lon.toFixed(2)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, limit);
  }

  // ---- 温泉地・温泉（data/onsen_areas.json。Wikidata〔CC0〕の温泉、読みは Wikidata か日本語版 Wikipedia の冒頭） ----
  const ONSEN_AREA_KM = 2; // 温泉地の名前で探したとき、その中とみなす入浴施設の範囲
  const onsenSpot = (x) => ({ id: `wd:${x.id.replace(/^wd-/, '')}`, name: x.name, kana: x.kana, lat: x.lat, lon: x.lon, pref: x.pref,
    genres: x.area ? ['onsen', 'sightseeing'] : ['onsen'], indoor: false, url: '', wp: x.wp ? `ja:${x.wp}` : undefined,
    note: x.area ? '温泉地' : '温泉', onsenArea: !!x.area });
  // extra のうち、base に同じ名前（表記ゆれを除く）で km 以内のものがあるものを除く（★厳選や地図データと同じ場所を 2 回出さない）
  function dropSameName(extra, base, km = 3) {
    const by = new Map();
    for (const s of base) { const k = norm(s.name); if (!by.has(k)) by.set(k, []); by.get(k).push(s); }
    return extra.filter((x) => !(by.get(norm(x.name)) || []).some((s) => haversineKm(s, x) <= km));
  }

  const spanDays = (e) => Math.round((Date.parse(e.end) - Date.parse(e.start)) / 864e5) + 1;

  function filterEvents(events, f, cfg, from, to) {
    const out = [];
    for (const e of events) {
      if (e.end < from || e.start > to) continue;
      if (f.rainy && e.indoor === false) continue;
      if (f.prefs.size && e.pref && !f.prefs.has(prefGroup(e.pref))) continue;
      if (f.exclude && f.exclude.test(e.title)) continue;
      if (f.dirs && f.dirs.size && e.lat != null && !f.dirs.has(direction(cfg.origin, e))) continue;
      let minutes = null;
      if (e.lat != null && e.lon != null) {
        minutes = travelMinutes(haversineKm(cfg.origin, e), f.mode, cfg);
        if (f.maxMin != null && minutes > f.maxMin) continue;
      }
      out.push({ ...e, minutes });
    }
    if (f.sortBy === 'date') {
      // 長い期間（今月・3か月）は開始日順。すでに開催中の長期展示は最後に回す
      const ongoing = (e) => (spanDays(e) > 3 && e.start < from ? 1 : 0);
      return out.sort((a, b) => ongoing(a) - ongoing(b) || a.start.localeCompare(b.start) || (a.minutes ?? 9999) - (b.minutes ?? 9999));
    }
    // 週末: 期間内に始まる・3日以内のものを先に、長期の展示は最後。その中は近い順（位置不明は後ろ）
    const key = (e) => [spanDays(e) > 3 ? 1 : 0, e.start < from ? 1 : 0, e.minutes ?? 9999];
    return out.sort((a, b) => {
      const ka = key(a), kb = key(b);
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2] || a.start.localeCompare(b.start);
    });
  }

  // 経路（GeoJSON の [lon,lat] 配列）までの最短距離 km と、出発点からそこまでの進行距離 km
  // 線の始点の緯度で平面に直す（どの点から測っても同じ物差しになり、stopsAlongRoute と同じ値になる）
  const routeXY = (line) => { const k = Math.cos(rad(line[0][1])); return line.map(([lon, lat]) => [lon * k * 111.32, lat * 110.57]); };
  function segDist(px, py, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len2)) : 0;
    return [Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy)), t * Math.sqrt(len2)];
  }
  function distToRoute(p, line) {
    if (line.length < 2) return { km: Infinity, along: 0 };
    const xy = routeXY(line), k = Math.cos(rad(line[0][1])), px = p.lon * k * 111.32, py = p.lat * 110.57;
    let best = { km: Infinity, along: 0 }, acc = 0;
    for (let i = 0; i + 1 < xy.length; i++) {
      const [d, along] = segDist(px, py, xy[i], xy[i + 1]);
      if (d < best.km) best = { km: d, along: acc + along };
      acc += Math.hypot(xy[i + 1][0] - xy[i][0], xy[i + 1][1] - xy[i][1]);
    }
    return best;
  }

  // ルートから maxKm 以内の候補（走る順）。候補×全線分の総当たりは数万件で数秒かかるので、
  // 線分を約 1km 四方の升目（maxKm だけ広げた範囲）に登録し、候補と同じ升目の線分とだけ測る（結果は総当たりと同じ）
  function stopsAlongRoute(items, line, maxKm) {
    if (line.length < 2) return [];
    const xy = routeXY(line), k = Math.cos(rad(line[0][1])), G = 0.9; // 升目の大きさ（km）
    const cell = (x, y) => Math.floor(y / G) * 1e6 + Math.floor(x / G);
    const grid = new Map(), acc = [0];
    for (let i = 0; i + 1 < xy.length; i++) {
      const [ax, ay] = xy[i], [bx, by] = xy[i + 1];
      acc.push(acc[i] + Math.hypot(bx - ax, by - ay));
      for (let y = Math.floor((Math.min(ay, by) - maxKm) / G); y <= Math.floor((Math.max(ay, by) + maxKm) / G); y++) {
        for (let x = Math.floor((Math.min(ax, bx) - maxKm) / G); x <= Math.floor((Math.max(ax, bx) + maxKm) / G); x++) {
          const key = y * 1e6 + x, a = grid.get(key);
          if (a) a.push(i); else grid.set(key, [i]);
        }
      }
    }
    const out = [];
    for (const s of items) {
      const px = s.lon * k * 111.32, py = s.lat * 110.57, segs = grid.get(cell(px, py));
      if (!segs) continue;
      let best = Infinity, along = 0;
      for (const i of segs) { // 番号の小さい順なので、同じ距離のときは distToRoute と同じ線分を選ぶ
        const [d, a] = segDist(px, py, xy[i], xy[i + 1]);
        if (d < best) { best = d; along = acc[i] + a; }
      }
      if (best <= maxKm) out.push({ ...s, offKm: best, alongKm: along });
    }
    return out.sort((a, b) => a.alongKm - b.alongKm);
  }

  function mulberry32(a) {
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // 1970-01-01 は木曜なので +3 で月曜始まりの週番号になる
  const weekSeed = (date) => Math.floor((date.getTime() / 864e5 + 3) / 7);

  function scoreSpot(s, ctx) {
    let n = 0;
    if (s.genres.some((g) => ctx.favGenres.has(g))) n += 2;
    if (ctx.rainy ? s.indoor === true : s.indoor === false) n += 2;
    if (!ctx.visited.has(s.id)) n += 1;
    return n;
  }

  function pickRecommendations(items, ctx, seed, n = 3) {
    const rnd = mulberry32(seed);
    const ranked = items.map((s) => ({ s, score: scoreSpot(s, ctx), r: rnd() }))
      .sort((a, b) => b.score - a.score || a.r - b.r);
    const picked = [], used = new Set();
    for (const { s } of ranked) {
      if (used.has(s.genres[0])) continue;
      used.add(s.genres[0]);
      picked.push(s);
      if (picked.length === n) break;
    }
    return picked;
  }

  // SNS はその場所の名前で探す（「古民家」のような一般的なタグだけでは別の場所ばかり出るため）。
  // 括弧の補足（「（大宮）」など）は外す。X は名前の完全一致、Instagram は名前のハッシュタグ。
  // タグが名前の一部なら、投稿の多いそのタグを Instagram に使う（例: 奥多摩周遊道路（都道206号）→ #奥多摩周遊道路）
  function snsLinks(s) {
    const name = s.name.replace(/[（(][^）)]*[）)]/g, '').trim();
    const tagify = (t) => t.replace(/[\s・･、。,.!?！？「」『』【】&＆'’"”/／-]/g, '');
    const full = tagify(name);
    const tag = (s.tags || []).map(tagify).find((t) => t.length >= 3 && full.includes(t)) || full;
    return {
      instagram: `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`,
      x: `https://x.com/search?q=${encodeURIComponent(`"${name}"`)}`,
    };
  }

  function gmapsDirUrl(origin, dest, waypoints = [], mode = 'driving') {
    const ll = (p) => `${p.lat},${p.lon}`;
    // origin を省くと、Google マップが現在地から案内を始める
    let u = origin ? `https://www.google.com/maps/dir/?api=1&origin=${ll(origin)}&destination=${ll(dest)}&travelmode=${mode}`
      : `https://www.google.com/maps/dir/?api=1&destination=${ll(dest)}&travelmode=${mode}&dir_action=navigate`;
    if (waypoints.length) u += `&waypoints=${encodeURIComponent(waypoints.slice(0, 9).map(ll).join('|'))}`;
    return u;
  }

  // ---- ルート提案（Valhalla） ----
  // Valhalla の shape（Google polyline 形式・精度 6）を [lon, lat] の配列に戻す
  function decodePolyline(str, precision = 6) {
    const out = [], f = 10 ** precision;
    let i = 0, lat = 0, lon = 0;
    const next = () => {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      return result & 1 ? ~(result >> 1) : result >> 1;
    };
    while (i < str.length) {
      lat += next(); lon += next();
      out.push([lon / f, lat / f]);
    }
    return out;
  }

  const pt = ([lat, lon]) => ({ lat, lon });
  const roadLen = (points) => points.slice(1).reduce((km, p, i) => km + haversineKm(pt(points[i]), pt(p)), 0);

  // 景色の点数: ルートの 1km 以内にある景色の地点の数と、おすすめの道を通る距離。
  // 道の距離は、ルートの 0.5km 以内にある道の地点のうち最初と最後の間をルートに沿って測る（端をかすめただけでは 0）
  function scenicScore(line, scenicPoints, roads) {
    const spots = stopsAlongRoute(scenicPoints, line, 1).length;
    let roadKm = 0;
    for (const r of roads) {
      const near = stopsAlongRoute(r.points.map(pt), line, 0.5);
      if (near.length >= 2) roadKm += near[near.length - 1].alongKm - near[0].alongKm;
    }
    return { spots, roadKm };
  }
  // 候補どうしを比べて 1〜5 の★にする（景色の地点 1 か所 ＝ おすすめの道 5km 相当）
  function scenicStars(scores) {
    const s = scores.map((x) => x.spots + x.roadKm / 5);
    const max = Math.max(...s);
    return s.map((v) => (max > 0 ? 1 + Math.round(4 * v / max) : 1));
  }

  // 寄り道として通せるおすすめの道: 直線距離で見積もった遠回りが maxRatio 倍以内のもの。向きは遠回りが少ない方
  function detourRoads(origin, dest, roads, maxRatio = 1.6, n = 2) {
    const base = Math.max(haversineKm(origin, dest), 1);
    const out = [];
    for (const road of roads) {
      // 目的地が道の上（1km 以内）にあると、通り過ぎて引き返すルートになるので除く
      if (distToRoute(dest, road.points.map(([lat, lon]) => [lon, lat])).km < 1) continue;
      const len = roadLen(road.points);
      let best = null;
      // 一方通行の道（いろは坂など）は、データの並び（走る向き）だけ
      for (const pts of road.oneway ? [road.points] : [road.points, [...road.points].reverse()]) {
        const est = haversineKm(origin, pt(pts[0])) + len + haversineKm(pt(pts[pts.length - 1]), dest);
        if (!best || est < best.est) best = { road, points: pts, est };
      }
      const ratio = best.est / base;
      if (ratio <= maxRatio) out.push({ ...best, ratio, gain: len / Math.max(best.est - base, 0.5) });
    }
    return out.sort((a, b) => b.gain - a.gain).slice(0, n);
  }

  // Google マップでルートから外れないための固定用の地点: 端の 10% を避けて等間隔に k 点
  function pinWaypoints(line, k) {
    if (k <= 0 || line.length < 2) return [];
    const cum = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + haversineKm(pt([line[i - 1][1], line[i - 1][0]]), pt([line[i][1], line[i][0]])));
    const total = cum[cum.length - 1], out = [];
    for (let j = 1; j <= k; j++) {
      const target = total * (0.1 + 0.8 * j / (k + 1));
      let i = cum.findIndex((d) => d >= target);
      if (i < 1) i = 1;
      const t = (target - cum[i - 1]) / Math.max(cum[i] - cum[i - 1], 1e-9);
      const [x0, y0] = line[i - 1], [x1, y1] = line[i];
      out.push({ lat: y0 + (y1 - y0) * t, lon: x0 + (x1 - x0) * t, along: target, pin: true });
    }
    return out;
  }

  // おすすめの道を走って戻る周回: データの並び（走る向き）のまま入る。一方通行の道を逆走させないため
  // 高速道路のコース: road.hw は高速道路の上に合わせた案内用の点（JCT の近くは避けてある）。
  // ルート検索では高速道路だけに合わせ（hw）、進む向き（heading）も渡す。一般道や反対車線に吸い寄せられて、降りて乗り直すのを防ぐ
  // keepClose: 一周するコースでも始点へ戻る点を残す（つなげたとき、次のコースへ行く前に一周を終えるため）
  function coursePoints(road, keepClose = false) {
    if (Array.isArray(road.parts)) return capPoints(road.parts.map((p, i) => coursePoints(p, keepClose || i < road.parts.length - 1)), MAX_VIA); // つなげたコース: 選んだ順に
    if (!Array.isArray(road.hw)) return road.points.map(pt);
    // hw の 3 つ目は、確かめたルートでその点を走る向き（度）。なければ前後の点から推定
    const hdg = (p, i, pts) => (road.hw[i] && road.hw[i].length > 2 ? road.hw[i][2] : Math.round(bearing(pts[i - 1] || p, pts[i + 1] || p)));
    let pts = road.hw.map(pt);
    if (keepClose) return pts.map((p, i) => ({ ...p, hw: true, heading: hdg(p, i, pts) }));
    // 一周するコース（始点＝終点）は最後の点を除く。帰り道で入口の近くを通るので、始点に戻るともう一周してしまう。
    // データの最初の点は「起点から入ってすぐの点」にしておく
    if (pts.length > 2 && haversineKm(pts[0], pts[pts.length - 1]) < 0.05) pts = pts.slice(0, -1);
    return pts.map((p, i) => ({ ...p, hw: true, heading: hdg(p, i, pts) }));
  }
  const MAX_VIA = 8; // ルート検索（Valhalla）に渡せる点は起点・終点を含めて 10 まで
  // コースごとの点の並び → 合わせて max 以下に（点の多いコースの真ん中から減らす。各コースの最初と最後は残す）
  function capPoints(lists, max) {
    const ls = lists.map((l) => [...l]);
    while (ls.reduce((a, l) => a + l.length, 0) > max) {
      const l = ls.filter((x) => x.length > 2).sort((a, b) => b.length - a.length)[0];
      if (!l) break;
      l.splice(Math.floor(l.length / 2), 1);
    }
    return ls.flat();
  }
  const loopPoints = (origin, road) => [origin, ...(road.outerPts || coursePoints(road)), origin];
  // つなげたコースの「外周」: 各コースの確かめた案内用の点（向きつき）のうち、ほかのコースと同じ道（80m 以内で同じ向きか逆向きの道）にある点を外し、
  // 残りを全体の中心のまわりに dir（'cw' 時計回り / 'ccw' 反時計回り）の順に並べる。逆向きに走る点は向きを反対に（反対車線に合わせる）。
  // 起点に一番近い点は外し（入口と出口はその近く）、その次の点から回る。parts: [[{lat, lon, heading}]]、lines: 各コースの線 [[lon, lat]]
  function outerFromPoints(parts, lines, dir, origin) {
    const angle = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
    const dirAt = (p, ln) => {
      let best = null;
      for (let k = 1; k < ln.length; k++) {
        const d = distToRoute(p, [ln[k - 1], ln[k]]).km;
        if (!best || d < best.d) best = { d, h: bearing({ lat: ln[k - 1][1], lon: ln[k - 1][0] }, { lat: ln[k][1], lon: ln[k][0] }) };
      }
      return best;
    };
    const kept = parts.flatMap((pts, i) => pts.filter((p) => !lines.some((ln, j) => {
      if (j === i) return false;
      const b = dirAt(p, ln);
      return b && b.d < 0.08 && (angle(b.h, p.heading) < 40 || angle(b.h, p.heading) > 140);
    })));
    if (kept.length < 3 || kept.length === parts.flat().length) return null; // 重なりがない・点が足りない
    const cy = kept.reduce((s, p) => s + p.lat, 0) / kept.length, cx = kept.reduce((s, p) => s + p.lon, 0) / kept.length, k0 = Math.cos(cy * Math.PI / 180);
    const th = (p) => Math.atan2(p.lat - cy, (p.lon - cx) * k0);
    const sorted = [...kept].sort((a, b) => (dir === 'ccw' ? th(a) - th(b) : th(b) - th(a))).map((p) => {
      const t = th(p), want = (Math.atan2(dir === 'ccw' ? -Math.sin(t) : Math.sin(t), dir === 'ccw' ? Math.cos(t) : -Math.cos(t)) * 180 / Math.PI + 360) % 360;
      return { ...p, heading: angle(p.heading, want) > 90 ? (p.heading + 180) % 360 : p.heading };
    });
    const n = sorted.reduce((b, p, i) => (haversineKm(origin, p) < haversineKm(origin, sorted[b]) ? i : b), 0);
    return [...sorted.slice(n + 1), ...sorted.slice(0, n)];
  }
  const CHAIN_MODES = { seq: '順に1本ずつ一周', cw: '外周を時計回り', ccw: '外周を反時計回り' };
  function chainRoad(parts, mode = 'seq') {
    const uniq = (xs) => [...new Set(xs.filter(Boolean))];
    const base = parts.map((p) => p.name.replace(/（.*?）/g, '')).join(mode === 'seq' ? ' → ' : '＋');
    return { id: 'chain:' + parts.map((p) => p.id).join('+') + (mode === 'seq' ? '' : '@' + mode), mode,
      name: mode === 'seq' ? base : `${base}（${CHAIN_MODES[mode]}）`, parts,
      points: parts.flatMap((p) => p.points), ...(parts.every((p) => Array.isArray(p.hw)) ? { hw: parts.flatMap((p) => p.hw) } : {}),
      toll: parts.some((p) => p.toll), fee: uniq(parts.map((p) => p.fee)).join('／'), note: parts.map((p) => p.name).join(' → ') + ' を続けて走ります。',
      closed: uniq(parts.map((p) => p.closed)).join('／'), closedMonths: uniq(parts.flatMap((p) => p.closedMonths || [])),
      alerts: uniq(parts.flatMap((p) => p.alerts || [])), noBike: uniq(parts.map((p) => p.noBike)).join('／'), tags: [] };
  }

  // ---- 分岐（JCT・出口）の案内: Valhalla の案内文から、高速の分岐・出口・合流だけを走る順に ----
  // 「神田橋/箱崎/Kandabashi/Hakozaki方面」→「神田橋/箱崎方面」（英語の併記を消す）
  const jaOnly = (s) => String(s || '').replace(/\/[A-Za-z][^、。/]*?(?=[、。/]|方面|です|$)/g, '');
  const FORK_TYPES = new Set([18, 19, 20, 21, 22, 23, 24, 25, 37, 38]);
  // legs: Valhalla の trip.legs（instructions つき）、jcts: [[名前, lat, lon]]（近くの JCT の名前を付ける）
  function jctGuide(legs, jcts = []) {
    const out = [];
    let km = 0;
    for (const leg of legs || []) {
      const shape = leg.shape ? decodePolyline(leg.shape, 6) : [];
      for (const m of leg.maneuvers || []) {
        if (FORK_TYPES.has(m.type) && (m.toll || m.highway || /首都高|高速|自動車道|道路|JCT|IC/.test((m.street_names || []).join('')))) {
          const at = shape[m.begin_shape_index], p = at ? { lat: at[1], lon: at[0] } : null;
          const near = p ? jcts.map(([name, lat, lon]) => [name, haversineKm(p, { lat, lon })]).filter(([, d]) => d < 0.6).sort((a, b) => a[1] - b[1])[0] : null;
          const text = jaOnly(m.instruction);
          // JCT 名も行き先もない「分岐です。」だけの案内は出さない（家の近くの出入口のランプで出て、役に立たない）
          if (near || /。.+/.test(text.replace(/。$/, ''))) out.push({ km: Math.round(km * 10) / 10, jct: near ? near[0] : '', text, lat: p && p.lat, lon: p && p.lon });
        }
        km += m.length || 0;
      }
    }
    return out;
  }

  // ---- Google マップに渡す「迷わない」地点: ほかの道（下の一般道・反対車線）が近くにない高速道路の上 ----
  // ルートのうち box（[南, 西, 北, 東]）に入る部分から、等間隔に n 点（進む向きつき）
  function samplesIn(line, box, n) {
    const inBox = ([lon, lat]) => !box || (lat >= box[0] && lat <= box[2] && lon >= box[1] && lon <= box[3]);
    const cum = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + haversineKm(pt([line[i - 1][1], line[i - 1][0]]), pt([line[i][1], line[i][0]])));
    const idx = line.map((_, i) => i).filter((i) => i > 0 && inBox(line[i]));
    if (!idx.length) return [];
    const a = cum[idx[0]], b = cum[idx[idx.length - 1]], out = [];
    for (let j = 0; j < n; j++) {
      const target = a + (b - a) * (j + 0.5) / n;
      const i = Math.max(1, cum.findIndex((d) => d >= target));
      const p = { lat: line[i][1], lon: line[i][0] }, q = { lat: line[i - 1][1], lon: line[i - 1][0] };
      if (inBox(line[i])) out.push({ ...p, heading: bearing(q, p), along: cum[i] });
    }
    return out;
  }
  // /locate の結果（その点から半径内の道）: 高速道路の本線だけ（一般道・ランプがない）で、走る向きの本線があれば「迷わない」。
  // 反対車線は Google マップでも遠い方なので許す
  const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  const safeSpot = (edges, heading) => !!edges && edges.length > 0 && edges.every((e) => {
    const c = e.edge && e.edge.classification;
    return c && c.classification === 'motorway' && c.use === 'road';
  }) && edges.some((e) => angleDiff(e.heading, heading) < 45);
  // 60m 以内に、同じ向きのランプ（出入口や JCT の分かれ道）がない。Google マップは経由地をそちらに合わせて、
  // いったん高速を降りて乗り直す（大井JCT の横の中環大井南入口）・別の路線へ出て U ターンする（江北JCT の川口線）ルートにした
  const rampFree = (edges, heading) => !(edges || []).some((e) => (e.distance || 0) <= 60 && e.edge && e.edge.classification
    && e.edge.classification.use === 'ramp' && angleDiff(e.heading, heading) < 40);
  // 走る距離（along）が最初から最後まで均等になるように k 点を選ぶ（候補が一部に固まっていても、離れた所の候補を落とさない）
  function spreadAlong(xs, k) {
    if (xs.length <= k) return xs;
    const a = Math.min(...xs.map((x) => x.along)), b = Math.max(...xs.map((x) => x.along)), used = new Set();
    for (let j = 0; j < k; j++) {
      const t = a + (b - a) * j / Math.max(k - 1, 1);
      let best = -1;
      xs.forEach((x, i) => { if (!used.has(i) && (best < 0 || Math.abs(x.along - t) < Math.abs(xs[best].along - t))) best = i; });
      used.add(best);
    }
    return [...used].sort((i, j) => xs[i].along - xs[j].along).map((i) => xs[i]);
  }
  // 経由地が max 件を超えるとき、ナビを分ける。各区間は、その区間に入る最後の立ち寄り（stop: true）で区切る
  // （高速の上の点を「目的地」にすると、走りながら次のナビを開くことになるため）。立ち寄りがなければ入るだけ入れて区切る
  function splitLegs(wps, max) {
    const legs = [];
    let rest = wps;
    while (rest.length > max) {
      const head = rest.slice(0, max + 1); // 経由地 max 件＋目的地 1 件
      let cut = head.length - 1;
      for (let i = head.length - 1; i >= 0; i--) if (head[i].stop) { cut = i; break; }
      legs.push({ waypoints: rest.slice(0, cut), end: rest[cut] });
      rest = rest.slice(cut + 1);
    }
    legs.push({ waypoints: rest, end: null });
    return legs;
  }
  // 等間隔に近い順に k 点を選ぶ
  function spreadPick(xs, k) {
    if (xs.length <= k) return xs;
    return Array.from({ length: k }, (_, j) => xs[Math.round((xs.length - 1) * j / Math.max(k - 1, 1))]);
  }

  // ---- Google マップの経路リンク → 地点の並び [{ name, addr, lat, lon }]。読めなければ null ----
  // 「geocode=」の中身は地点ごとの小さなバイナリ（緯度・経度を 100 万倍した整数）
  function geocodeToken(tok) {
    try {
      const s = atob(tok.replace(/-/g, '+').replace(/_/g, '/'));
      const b = Uint8Array.from(s, (c) => c.charCodeAt(0)), dv = new DataView(b.buffer);
      if (b.length < 10 || b[0] !== 0x15 || b[5] !== 0x1d) return null;
      return { lat: dv.getInt32(1, true) / 1e6, lon: dv.getInt32(6, true) / 1e6 };
    } catch { return null; }
  }
  const LL_RE = /^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/;
  function placeOf(text) {
    const t = String(text || '').trim();
    const m = t.match(LL_RE);
    if (m) return { name: `${(+m[1]).toFixed(4)},${(+m[2]).toFixed(4)}`, addr: '', lat: +m[1], lon: +m[2] };
    const [name, ...rest] = t.split(/、〒\d{3}-\d{4}\s*|、/);
    return { name: name.trim(), addr: rest.join(' ').trim() };
  }
  function parseGmapsRoute(text) {
    const m = String(text || '').match(/https?:\/\/[^\s"'<>]+/);
    if (!m) return null;
    let u;
    try { u = new URL(m[0]); } catch { return null; }
    for (let i = 0; i < 3 && u.searchParams.get('continue'); i++) { try { u = new URL(u.searchParams.get('continue')); } catch { break; } } // 同意画面を経由した URL
    const sp = u.searchParams;
    if (sp.get('daddr')) { // maps.google.com/?saddr=A&daddr=B+to:C&geocode=...
      const names = [sp.get('saddr'), ...sp.get('daddr').split(/\s+to:/)].filter((x) => x != null && x.trim());
      const geo = (sp.get('geocode') || '').split(';');
      const pts = names.map((n, i) => ({ ...placeOf(n), ...(geo.length === names.length ? geocodeToken(geo[i]) || {} : {}) }));
      return pts.length ? pts : null;
    }
    if (sp.get('api') === '1' && sp.get('destination')) { // maps/dir/?api=1&origin=&destination=&waypoints=a|b
      const pts = [sp.get('origin'), ...(sp.get('waypoints') || '').split('|'), sp.get('destination')].filter((x) => x && x.trim()).map(placeOf);
      return pts.length ? pts : null;
    }
    const dir = u.pathname.match(/\/maps\/dir\/(.+)/);
    if (dir) { // /maps/dir/A/B/@lat,lon,z/data=...!1d<lon>!2d<lat>...
      const segs = dir[1].split('/').filter((s) => s && !s.startsWith('@') && !s.startsWith('data='))
        .map((s) => decodeURIComponent(s.replace(/\+/g, ' ')));
      const ll = [...decodeURIComponent(u.href).matchAll(/!1d(-?\d+\.\d+)!2d(-?\d+\.\d+)/g)].map((x) => ({ lon: +x[1], lat: +x[2] }));
      const named = segs.filter((s) => !LL_RE.test(s)).length;
      let k = 0;
      const pts = segs.map((s) => { const p = placeOf(s); return p.lat != null ? p : { ...p, ...(ll.length === named ? ll[k++] : {}) }; });
      return pts.length ? pts : null;
    }
    const at = u.href.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || u.href.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (at) { // 1 か所（/maps/place/名前/@lat,lon）
      const name = (u.pathname.match(/\/place\/([^/]+)/) || [])[1];
      return [{ name: name ? decodeURIComponent(name.replace(/\+/g, ' ')) : '地点', addr: '', lat: +at[1], lon: +at[2] }];
    }
    const q = sp.get('q') || sp.get('ll');
    if (q && LL_RE.test(q)) return [placeOf(q)];
    return null;
  }
  const isShortMapsUrl = (t) => /https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\//.test(String(t || ''));
  // 登録用: 地点の並び → 目的地（最後の地点）と経由地（それより前。多すぎるときは間引く）
  function routeFromPlaces(pts, maxVia) {
    const ok = pts.filter((p) => p.lat != null);
    if (!ok.length) return null;
    const dest = ok[ok.length - 1];
    let via = ok.slice(0, -1);
    if (via.length > maxVia) via = spreadPick(via, maxVia);
    return { name: ok.length > 1 ? `${ok[0].name} → ${dest.name}` : dest.name, lat: +dest.lat.toFixed(5), lon: +dest.lon.toFixed(5),
      waypoints: via.map((p) => [+p.lat.toFixed(5), +p.lon.toFixed(5)]), stops: ok.map((p) => p.name), cut: ok.length - 1 - via.length };
  }

  // ---- 種類の整理: 展望台・夜景は「観光」「絶景」とまとめずに、それぞれの種類にする ----
  const VIEW_RE = /展望|スカイツリー|東京タワー|マリンタワー|ポートタワー|シーキャンドル|スカイガーデン|シティビュー/;
  function refineGenres(s) {
    if (!s || !Array.isArray(s.genres)) return s;
    const night = (s.tags || []).includes('夜景') || /夜景/.test(`${s.name} ${s.note || ''}`);
    const view = s.kind === 'viewpoint' || s.note === '展望台' || VIEW_RE.test(s.name || '');
    if (!night && !view) return s;
    const g = s.genres.filter((x) => x !== 'sightseeing' && x !== 'scenic');
    if (view && !g.includes('viewpoint')) g.push('viewpoint');
    if (night && !g.includes('nightview')) g.push('nightview');
    s.genres = g;
    return s;
  }

  // ---- 首都高ルートの組み立て: 一周になるように、最後の区間から最初の区間の入口の JCT まで、降りずにつながる区間で一番短く戻る ----
  // sx: data/shutoko_net.json（segs・next・nodes）。ids: 選んだ区間。max: つなげる区間の上限。
  // 戻り値: { add: 足す区間, km } ／ すでに一周なら { add: [], km: 0, closed: true } ／ max 以内で戻れなければ null
  function sxCloseLoop(sx, ids, max = 8) {
    const seg = new Map(sx.segs.map((s) => [s.id, s]));
    const first = seg.get(ids[0]), last = seg.get(ids[ids.length - 1]);
    if (!first || !last) return null;
    const len = (s) => haversineKm(sx.nodes[s.from], sx.nodes[s.to]);
    // 最初の区間へそのまま入れる終わり方（本当の一周）を優先し、なければ最初の JCT に戻るだけでもよい
    const into = (s) => s.to === first.from && (sx.next[s.id] || []).includes(first.id);
    const back = (s) => s.to === first.from;
    if (ids.length > 1 && back(last)) return { add: [], km: 0, closed: true };
    const room = max - ids.length;
    for (const goal of [into, back]) {
      // 区間を頂点にした最短経路（Dijkstra。区間は 82 本なので単純な配列で十分）
      const dist = new Map([[last.id, 0]]), prev = new Map(), steps = new Map([[last.id, 0]]), done = new Set();
      for (;;) {
        let cur = null;
        for (const [id, d] of dist) if (!done.has(id) && (cur === null || d < dist.get(cur))) cur = id;
        if (cur === null) break;
        done.add(cur);
        if (cur !== last.id && goal(seg.get(cur))) {
          const add = [];
          for (let x = cur; x !== last.id; x = prev.get(x)) add.unshift(x);
          return { add, km: Math.round(dist.get(cur) * 10) / 10 };
        }
        if (steps.get(cur) >= room) continue;
        for (const nx of sx.next[cur] || []) {
          const s = seg.get(nx); if (!s) continue;
          const d = dist.get(cur) + len(s);
          if (!dist.has(nx) || d < dist.get(nx)) { dist.set(nx, d); prev.set(nx, cur); steps.set(nx, steps.get(cur) + 1); }
        }
      }
    }
    return null;
  }

  // ---- 時間帯で絞り込む ----
  const TIME_BANDS = { morning: ['🌅朝（6〜10時）', [6, 7, 8, 9]], day: ['☀昼（10〜16時）', [10, 12, 14, 15]],
    evening: ['🌇夕方（16〜19時）', [16, 17, 18]], night: ['🌙夜（19〜24時）', [19, 20, 21, 22, 23]], late: ['🌌深夜（0〜5時）', [0, 1, 2, 3, 4]] };
  const OPEN_AIR = new Set(['viewpoint', 'nightview']);
  // 営業時間があればそれで判定（その時間帯のどこかで開いていれば OK）。
  // 営業時間が分からない所: 昼間はそのまま出す。夜・深夜は、屋外の展望台・夜景・湖・海岸と道の駅（駐車場とトイレは 24 時間）だけ。
  // 「絶景」の庭園・並木などは閉まる所が多いので出さない。入場料のかかる所も出さない
  // 屋内の夜景（展望室など）は夜だけ（深夜は閉まっている所がほとんど）
  function timeBandState(s, band, day = new Date()) {
    const b = TIME_BANDS[band];
    if (!b) return 'ok';
    const st = b[1].map((h) => openState(s.oh, new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, 30)));
    if (st.includes(true)) return 'open';
    if (st.includes(false)) return null;
    if (band !== 'night' && band !== 'late') return 'ok';
    if (band === 'late' && s.lateClosed) return null; // 屋上庭園・展望デッキなど、営業時間は分からないが深夜は閉まる所（厳選の lateClosed）
    if (s.kind === 'michinoeki') return 'h24';
    if (['peak', 'waterfall', 'gorge'].includes(s.kind)) return null;
    if (s.indoor === true) return band === 'night' && (s.genres || []).includes('nightview') ? 'ok' : null;
    if (/円/.test(s.fee || '')) return null;
    return (s.genres || []).some((g) => OPEN_AIR.has(g)) || ['lake', 'coast'].includes(s.kind) ? 'outdoor' : null;
  }
  // 道: 夜間通行止めの道を外す・夜景の道
  const roadNightClosed = (r) => /夜間(の)?(通行止|閉鎖)|夜間.{0,12}通行止/.test(`${r.closed || ''} ${r.note || ''}`);
  const roadNightView = (r) => /夜景|夜の|夜は|ライトアップ/.test(`${r.note || ''} ${r.name || ''}`);

  // ---- コースの線の色: 同じ種類でも 1 本ずつ少しずつ色を変えて、区切りが分かるように ----
  function routeShade(hex, key) {
    const n = parseInt(String(hex).slice(1), 16);
    let r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l0 = (mx + mn) / 2, d = mx - mn;
    let h = 0;
    const s0 = d ? d / (1 - Math.abs(2 * l0 - 1)) : 0;
    if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    let hash = 0;
    for (const ch of String(key)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const hue = (h * 60 + ((hash % 7) - 3) * 12 + 360) % 360, light = Math.min(0.66, Math.max(0.26, l0 + (((hash >> 3) % 5) - 2) * 0.09));
    return `hsl(${Math.round(hue)}, ${Math.round(s0 * 100)}%, ${Math.round(light * 100)}%)`;
  }

  const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  // GPX 1.1（線 = trk、立ち寄り = wpt）。地図アプリ（OsmAnd など）でそのまま読める
  function toGpx(name, line, wpts = []) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<gpx version="1.1" creator="MyMap" xmlns="http://www.topografix.com/GPX/1/1">\n'
      + wpts.map((w) => `<wpt lat="${w.lat}" lon="${w.lon}"><name>${xmlEsc(w.name)}</name></wpt>\n`).join('')
      + `<trk><name>${xmlEsc(name)}</name><trkseg>\n`
      + line.map(([lon, lat]) => `<trkpt lat="${lat}" lon="${lon}"></trkpt>`).join('\n')
      + '\n</trkseg></trk>\n</gpx>\n';
  }

  // ---- スポットの説明と写真（Wikipedia / Wikimedia Commons。どちらも登録不要） ----
  // wp（"ja:記事名"）か Wikipedia の URL から、記事の言語と題名を取り出す
  function wikiRef(s) {
    if (s.wp && s.wp.includes(':')) { const i = s.wp.indexOf(':'); return { lang: s.wp.slice(0, i), title: s.wp.slice(i + 1) }; }
    const m = /^https:\/\/([a-z-]+)\.(?:m\.)?wikipedia\.org\/wiki\/([^?#]+)/.exec(s.url || '');
    if (!m) return null;
    let title = m[2];
    try { title = decodeURIComponent(title); } catch { /* 壊れた URL はそのまま */ }
    return { lang: m[1], title: title.replace(/_/g, ' ') };
  }
  // Google マップでその場所を開く（写真・口コミは Google マップ側で見る。有料の Places API は使わない）
  // 名前だけで検索すると同じ名前の別の場所に飛ぶので、住所（市区町村＋町名）を添える。
  // 住所がまだわからないときは、その場所を中心にした地図で検索する
  const gmapsSearchUrl = (s, addr) => (addr
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${s.name} ${addr}`)}`
    : s.lat != null ? `https://www.google.com/maps/search/${encodeURIComponent(s.name)}/@${s.lat},${s.lon},17z`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.name)}`);
  // スポットへの経路: 目的地を座標（「指定した場所」と表示される）でなく、施設名＋住所で渡す。住所がなければ座標
  const gmapsPlaceDirUrl = (origin, s, mode = 'driving', addr) => (addr
    ? `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lon}&destination=${encodeURIComponent(`${s.name} ${addr}`)}&travelmode=${mode}`
    : gmapsDirUrl(origin, s, [], mode));
  // 国土地理院の逆ジオコーダー（緯度経度 → 市区町村コード・町名）
  const gsiReverseUrl = (s) => `https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${s.lat}&lon=${s.lon}`;
  function parseGsiAddress(j, muni) {
    const r = j && j.results;
    const city = r && muni[String(Number(r.muniCd))];
    if (!city) return null;
    return city + (r.lv01Nm && r.lv01Nm !== '－' ? r.lv01Nm : '');
  }
  // 目的地の検索: 国土地理院の地名・住所検索（無料・登録不要）
  // ---- 営業時間（OpenStreetMap の opening_hours のよく使われる書き方だけ読む。読めないときは null） ----
  const OH_DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const OH_JA = { Mo: '月', Tu: '火', We: '水', Th: '木', Fr: '金', Sa: '土', Su: '日', PH: '祝' };
  function ohDays(spec) {
    const days = new Set();
    for (const part of spec.split(',')) {
      const m = part.trim().match(/^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/);
      if (!m) { if (part.trim() === 'PH' || part.trim() === 'SH') continue; return null; }
      const a = OH_DAYS.indexOf(m[1]), b = OH_DAYS.indexOf(m[2] || m[1]);
      for (let d = a; ; d = (d + 1) % 7) { days.add(d); if (d === b) break; }
    }
    return days;
  }
  function parseOh(oh) {
    const s = String(oh || '').trim();
    if (!s) return null;
    if (s === '24/7') return [{ days: new Set([0, 1, 2, 3, 4, 5, 6]), spans: [[0, 1440]] }];
    const rules = [];
    for (const raw of s.split(/;|\|\|/)) {
      const r = raw.trim(); if (!r) continue;
      const m = r.match(/^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?,?\s*)+)?\s*(.*)$/);
      const days = m[1] ? ohDays(m[1].replace(/\s/g, '')) : new Set([0, 1, 2, 3, 4, 5, 6]);
      if (!days) return null;
      if (!days.size) continue; // 祝日だけの決まりは、祝日がわからないので使わない
      const rest = m[2].trim();
      if (/^(off|closed)$/i.test(rest)) { rules.push({ days, spans: [] }); continue; }
      const spans = [];
      for (const t of rest.split(',')) {
        const x = t.trim().match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/) || t.trim().match(/^(\d{1,2}):(\d{2})\+$/);
        if (!x) return null;
        const a = +x[1] * 60 + +x[2];
        let b = x[3] != null ? +x[3] * 60 + +x[4] : 1440;
        if (b <= a) b += 1440; // 日をまたぐ（22:00-02:00）
        spans.push([a, b]);
      }
      rules.push({ days, spans });
    }
    return rules.length ? rules : null;
  }
  // 後に書いた決まりが優先（OpenStreetMap の約束）
  const ohRuleFor = (rules, day) => { let r = null; for (const x of rules) if (x.days.has(day)) r = x; return r; };
  function openState(oh, date = new Date()) {
    const rules = parseOh(oh);
    if (!rules) return null;
    const day = date.getDay(), min = date.getHours() * 60 + date.getMinutes();
    const today = ohRuleFor(rules, day), prev = ohRuleFor(rules, (day + 6) % 7);
    if (today && today.spans.some(([a, b]) => min >= a && min < b)) return true;
    if (prev && prev.spans.some(([, b]) => b > 1440 && min + 1440 < b)) return true;
    return false; // 書いていない曜日は休み（OpenStreetMap の約束）
  }
  const ohText = (oh) => String(oh || '').replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH)\b/g, (d) => OH_JA[d])
    .replace(/\boff\b|\bclosed\b/gi, '休み').replace(/24\/7/, '24時間').replace(/;\s*/g, '／');

  // ---- 雨雲（気象庁の高解像度降水ナウキャスト・降水短時間予報の地図タイル。出典: 気象庁ホームページ） ----
  const JMA_TILE = 'https://www.jma.go.jp/bosai/jmatile/data';
  const JMA_TIMES = ['nowc/targetTimes_N1.json', 'nowc/targetTimes_N2.json', 'rasrf/targetTimes.json'].map((p) => `${JMA_TILE}/${p}`);
  const jmaMs = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14) || 0); // UTC の「20261022052000」
  // 時刻順のコマ。実況（過去 pastMin 分・5 分ごと）→ ナウキャストの予報（1 時間先まで 5 分ごと）→ 降水短時間予報（15 時間先まで 1 時間ごと）。
  // from〜to はそのコマが表す時間（ナウキャストはその時刻の前後 2.5 分、降水短時間予報は validtime までの 1 時間の雨量）
  function jmaFrames(n1, n2, rasrf, pastMin = 60) {
    const out = [];
    const nowT = (n1 || []).reduce((m, x) => Math.max(m, jmaMs(x.validtime)), 0);
    const nowc = (x, kind) => {
      const t = jmaMs(x.validtime);
      out.push({ t, from: t - 150e3, to: t + 150e3, kind, url: `${JMA_TILE}/nowc/${x.basetime}/none/${x.validtime}/surf/hrpns/{z}/{x}/{y}.png` });
    };
    for (const x of n1 || []) if (jmaMs(x.validtime) >= nowT - pastMin * 60e3) nowc(x, jmaMs(x.validtime) === nowT ? 'now' : 'past');
    for (const x of n2 || []) nowc(x, 'nowcast');
    // 1〜6 時間先は 10 分ごとに出る「immed」、7 時間先からは毎正時の「none」。それぞれ一番新しいものだけ使う
    const fc = (rasrf || []).filter((x) => (x.elements || []).includes('rasrf') && x.validtime > x.basetime);
    const end = out.reduce((m, f) => Math.max(m, f.to), nowT);
    const seen = new Set();
    for (const member of ['immed', 'none']) {
      const xs = fc.filter((x) => x.member === member);
      const base = xs.reduce((m, x) => (x.basetime > m ? x.basetime : m), '');
      for (const x of xs) {
        const t = jmaMs(x.validtime);
        if (x.basetime !== base || t <= end || seen.has(t)) continue;
        seen.add(t);
        out.push({ t, from: t - 3600e3, to: t, kind: 'fcst', url: `${JMA_TILE}/rasrf/${x.basetime}/${member}/${x.validtime}/surf/rasrf/{z}/{x}/{y}.png` });
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }
  // ---- 15 時間より先（2 日先まで）: Open-Meteo の気象庁の数値予報（MSM など）を、地域の格子の点で 1 時間ごとに ----
  const mmLevel = (mm) => (mm == null ? null : mm < 0.1 ? 0 : mm < 1 ? 1 : mm < 5 ? 2 : mm < 10 ? 3 : mm < 20 ? 4 : mm < 30 ? 5 : mm < 50 ? 6 : mm < 80 ? 7 : 8);
  // 範囲 [south, west, north, east] を n×n の格子に（点は升目の真ん中）
  function gridPoints(b, n) {
    const [s, w, nn, e] = b, dy = (nn - s) / n, dx = (e - w) / n, pts = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) pts.push({ lat: +(s + dy * (i + 0.5)).toFixed(3), lon: +(w + dx * (j + 0.5)).toFixed(3) });
    return { pts, dy, dx };
  }
  const modelUrl = (pts, hours = 50) => 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({ latitude: pts.map((p) => p.lat).join(','),
    longitude: pts.map((p) => p.lon).join(','), hourly: 'precipitation', timezone: 'UTC', forecast_hours: String(hours), models: 'jma_seamless' });
  // Open-Meteo の答え → after より後の 1 時間ごとのコマ（各コマはその時刻までの 1 時間の雨量。格子の点ごとの段階）
  function modelFrames(json, grid, after) {
    const arr = Array.isArray(json) ? json : [json];
    const h = arr[0] && arr[0].hourly;
    if (!h) return [];
    const out = [];
    h.time.forEach((iso, k) => {
      const t = Date.parse(`${iso}:00Z`);
      if (t <= after) return;
      out.push({ t, from: t - 3600e3, to: t, kind: 'model', grid: { ...grid, levels: arr.map((a) => mmLevel(a.hourly ? a.hourly.precipitation[k] : null)) } });
    });
    return out;
  }
  // 格子のコマで、その地点に一番近い点の段階（格子の外は null）
  function gridLevelAt(f, lat, lon) {
    const g = f.grid; let best = -1, bd = Infinity;
    g.pts.forEach((p, i) => { const d = Math.abs(p.lat - lat) / g.dy + Math.abs(p.lon - lon) / g.dx; if (d < bd) { bd = d; best = i; } });
    return best < 0 || bd > 1.5 ? null : g.levels[best];
  }
  // 雨の予報の信頼度の目安（先になるほど下がる）。実況は観測そのもの
  function rainTrust(t, now = Date.now(), kind = '') {
    if (kind === 'past' || kind === 'now') return '実測';
    const h = (t - now) / 3600e3;
    return h <= 1 ? '高' : h <= 6 ? 'やや高' : h <= 15 ? '中' : h <= 24 ? 'やや低' : '低';
  }
  // 時刻 t の雨を表すコマ（重なるときは短い時間のコマ＝ナウキャストを優先）。範囲の外は null
  function frameAt(frames, t) {
    let best = null;
    for (const f of frames) if (t >= f.from && t <= f.to && (!best || f.to - f.from < best.to - best.from)) best = f;
    return best;
  }
  // タイルの色 → 雨の強さの段階（0=なし、1=1mm未満、2=1〜5mm … 8=80mm以上。ナウキャストは 1 時間あたり、降水短時間予報は 1 時間の雨量）
  const RAIN_COLORS = [[242, 242, 255], [160, 210, 255], [33, 140, 255], [0, 65, 255], [250, 245, 0], [255, 153, 0], [255, 40, 0], [180, 0, 104]];
  const RAIN_LABELS = ['なし', '1mm未満', '1〜5mm', '5〜10mm', '10〜20mm', '20〜30mm', '30〜50mm', '50〜80mm', '80mm以上'];
  function rainLevel(r, g, b, a) {
    if (a < 128) return 0;
    let best = 0, bd = Infinity;
    RAIN_COLORS.forEach(([R, G, B], i) => { const d = (r - R) ** 2 + (g - G) ** 2 + (b - B) ** 2; if (d < bd) { bd = d; best = i + 1; } });
    return bd < 3000 ? best : 0;
  }
  // 緯度経度 → 地図タイル（256 画素）の番号と画素の位置
  function tilePixel(lat, lon, z) {
    const n = 2 ** z, x = (lon + 180) / 360 * n, s = Math.sin(lat * RAD);
    const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
    return { x: Math.floor(x), y: Math.floor(y), px: Math.min(255, Math.floor((x % 1) * 256)), py: Math.min(255, Math.floor((y % 1) * 256)) };
  }
  // ルートを出発 departMs から totalMin 分で走るときの、時刻 t の位置（距離に比例して進むとみなす）。走っていない時刻は null
  function routeAt(line, totalMin, departMs, t) {
    if (!line || line.length < 2 || t < departMs || t > departMs + totalMin * 60e3) return null;
    const cum = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + haversineKm(pt([line[i - 1][1], line[i - 1][0]]), pt([line[i][1], line[i][0]])));
    const want = cum[cum.length - 1] * (t - departMs) / (totalMin * 60e3 || 1);
    const i = Math.max(1, cum.findIndex((d) => d >= want));
    const f = cum[i] > cum[i - 1] ? (want - cum[i - 1]) / (cum[i] - cum[i - 1]) : 0;
    return { lat: line[i - 1][1] + (line[i][1] - line[i - 1][1]) * f, lon: line[i - 1][0] + (line[i][0] - line[i - 1][0]) * f, km: want };
  }
  // 出発時刻の候補（今の次の stepMin 分区切りから、予報の終わり lastMs の stepMin 分前まで）
  function departOptions(nowMs, lastMs, stepMin = 30, max = 30) {
    const step = stepMin * 60e3, out = [];
    for (let t = Math.ceil(nowMs / step) * step; t <= lastMs - step && out.length < max; t += step) out.push(t);
    return out;
  }
  // 雨の区間を避ける経由地: ルートのうち雨に当たる地点（出発地・目的地から 5km 以内は回り道では避けられないので除く）の真ん中から、
  // 雨の区間の向きに直角に、左右へ offsets km ずらした点。side は回る側の方角
  const DIR8 = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
  function rainDetourVias(wetPts, from, to, offsets = [15, 35]) {
    const xs = wetPts.filter((p) => haversineKm(p, from) > 5 && haversineKm(p, to) > 5);
    if (!xs.length) return [];
    const c = { lat: xs.reduce((s, p) => s + p.lat, 0) / xs.length, lon: xs.reduce((s, p) => s + p.lon, 0) / xs.length };
    const a = xs.length > 1 ? xs[0] : from, b = xs.length > 1 ? xs[xs.length - 1] : to; // 雨の区間の向き（1 点だけならルート全体の向き）
    const kx = Math.cos(c.lat * RAD) * 111, ky = 111;
    let dx = (b.lon - a.lon) * kx, dy = (b.lat - a.lat) * ky;
    const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
    const out = [];
    for (const d of offsets) {
      for (const s of [1, -1]) {
        const px = -dy * s, py = dx * s; // 進む向きの左（s=1）と右
        out.push({ lat: c.lat + py * d / ky, lon: c.lon + px * d / kx, d, side: DIR8[Math.round((((Math.atan2(px, py) / RAD) + 360) % 360) / 45) % 8] });
      }
    }
    return out;
  }
  // 線の上で、地点 p に一番近い点（[lon, lat] の並び → { lat, lon }）。経由地を道の上に置き直すため
  function nearestOnLine(line, p) {
    let best = null, bd = Infinity;
    for (const [lon, lat] of line) { const d = (lat - p.lat) ** 2 + ((lon - p.lon) * Math.cos(p.lat * RAD)) ** 2; if (d < bd) { bd = d; best = { lat, lon }; } }
    return best;
  }
  // 地点ごとの雨の段階（予報の範囲外は null）→ 雨に当たるか。1mm/h 以上を「雨」、1mm 未満を「ぱらつく」とみなす
  function rainVerdict(levels) {
    const known = levels.filter((v) => v != null);
    const wet = levels.map((v, i) => [v, i]).filter(([v]) => v >= 2);
    return { max: known.length ? Math.max(...known) : null, wet: wet.length, drizzle: levels.filter((v) => v === 1).length,
      unknown: levels.length - known.length, firstWet: wet.length ? wet[0][1] : -1 };
  }

  // ---- 季節の見頃（厳選スポットの best: [{ what, months }]） ----
  const seasonNow = (s, month) => (s.best || []).filter((b) => b.months.includes(month));
  const seasonText = (best) => (best || []).map((b) => `${b.what} ${b.months.length > 1 ? `${b.months[0]}〜${b.months[b.months.length - 1]}` : b.months[0]}月`).join('・');

  // ---- ルート上の地点（雨の予報・写真・標高用）: 距離で等間隔に n 点、出発からの到着時刻つき ----
  function routeSamples(line, totalMin, departMs, n) {
    const cum = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + haversineKm(pt([line[i - 1][1], line[i - 1][0]]), pt([line[i][1], line[i][0]])));
    const total = cum[cum.length - 1] || 1, out = [];
    for (let j = 0; j < n; j++) {
      const target = total * j / Math.max(n - 1, 1);
      const i = Math.max(0, cum.findIndex((d) => d >= target - 1e-9));
      out.push({ lat: line[i][1], lon: line[i][0], km: cum[i], at: departMs + totalMin * 60e3 * cum[i] / total });
    }
    return out;
  }
  const ll4 = (xs, k) => xs.map((p) => p[k].toFixed(4)).join(',');
  const rainAlongUrl = (pts) => `https://api.open-meteo.com/v1/forecast?latitude=${ll4(pts, 'lat')}&longitude=${ll4(pts, 'lon')}`
    + '&hourly=precipitation_probability,precipitation&timezone=Asia%2FTokyo&forecast_days=7';
  // 各地点の、通過する時刻（1 時間単位）の降水確率と雨量。予報の範囲外は null
  function parseRainAlong(json, pts) {
    const arr = Array.isArray(json) ? json : [json];
    return pts.map((p, i) => {
      const h = arr[i] && arr[i].hourly;
      if (!h) return { ...p, prob: null, mm: null };
      const d = new Date(p.at);
      const key = `${ymd(d)}T${String(d.getHours()).padStart(2, '0')}:00`;
      const k = h.time.indexOf(key);
      return { ...p, prob: k < 0 ? null : h.precipitation_probability[k], mm: k < 0 ? null : h.precipitation[k] };
    });
  }
  const elevationUrl = (pts) => `https://api.open-meteo.com/v1/elevation?latitude=${ll4(pts, 'lat')}&longitude=${ll4(pts, 'lon')}`;
  const climbOf = (elev) => elev.reduce((a, e, i) => a + (i && e > elev[i - 1] ? e - elev[i - 1] : 0), 0);

  // ---- 日帰りプラン: 出発 → 目的地（見学）→ 近くで昼食 → もう 1 か所（温泉か近くの見どころ）→ 帰着 ----
  const STAY_MIN = { museum: 120, play: 180, garden: 90, onsen: 90, temple: 60, scenic: 60, shopping: 120, factory: 90, experience: 120, vehicle: 120 };
  const stayOf = (s) => Math.max(45, ...(s.genres || []).map((g) => STAY_MIN[g] || 60));
  // 自動で選ぶ行き先: 目的地 → 近くで昼食（1.5km 以内・昼に営業中か不明・チェーン以外）→ 温泉（15km 以内）か近くの見どころ（3km 以内）
  function autoPlanStops(spot, pool, cfg, mode, departMin, date = new Date()) {
    const move = (a, b) => travelMinutes(haversineKm(a, b), mode, cfg);
    const stops = [{ place: spot, stay: stayOf(spot), kind: 'main' }];
    const t = departMin + move(cfg.origin, spot) + stayOf(spot);
    const lunchAt = new Date(date); lunchAt.setHours(Math.floor(Math.max(t, 690) / 60), Math.max(t, 690) % 60, 0, 0);
    const near = (xs, km) => xs.map((x) => ({ x, d: haversineKm(spot, x) })).filter((o) => o.d <= km && o.x.id !== spot.id).sort((a, b) => a.d - b.d);
    const lunch = near(pool.filter((x) => (x.genres || []).includes('food') && !x.chain && openState(x.oh, lunchAt) !== false), 1.5)
      .sort((a, b) => (openState(b.x.oh, lunchAt) === true) - (openState(a.x.oh, lunchAt) === true) || a.d - b.d)[0];
    if (lunch) stops.push({ place: lunch.x, stay: 60, kind: 'lunch' });
    const second = near(pool.filter((x) => (x.genres || []).includes('onsen')), 15)[0]
      || near(pool.filter((x) => !(x.genres || []).includes('food') && (x.genres || []).some((g) => g !== 'lodging')), 3)[0];
    if (second) stops.push({ place: second.x, stay: stayOf(second.x), kind: 'extra' });
    return stops;
  }
  // 行き先の並びから時刻を出す。昼食は 11:30 より前にしない。homeMin（帰宅したい時刻）があれば、遅れ・余裕の分
  const fmtHM = (m) => `${Math.floor(m / 60) % 24}:${String(Math.round(m % 60)).padStart(2, '0')}`;
  function schedulePlan(stops, cfg, mode, departMin, homeMin = null) {
    const move = (a, b) => travelMinutes(haversineKm(a, b), mode, cfg);
    const steps = [{ time: fmtHM(departMin), what: `${cfg.origin.name}を出発` }];
    let t = departMin, prev = cfg.origin;
    stops.forEach((st, i) => {
      t += move(prev, st.place);
      if (st.kind === 'lunch') t = Math.max(t, 690);
      steps.push({ time: fmtHM(t), what: st.kind === 'lunch' ? `昼食: ${st.place.name}` : i === 0 ? `${st.place.name}に到着` : `${st.place.name}へ`,
        place: st.place, stay: st.stay, index: i, kind: st.kind, at: t });
      t += st.stay;
      prev = st.place;
    });
    t += move(prev, cfg.origin);
    steps.push({ time: fmtHM(t), what: `${cfg.origin.name}に帰着` });
    // 帰宅したい時刻に間に合わせるには、最後の場所を何時に出ればよいか
    const lastLeave = homeMin == null ? null : homeMin - move(prev, cfg.origin);
    return { steps, endMin: t, overMin: homeMin == null ? null : t - homeMin, lastLeave: lastLeave == null ? null : fmtHM(lastLeave) };
  }
  // 近い順に並べ替え（起点から、いちばん近い所へ順に）。昼食は動かさない位置に置いたまま
  function orderStops(stops, origin) {
    const rest = [...stops], out = [];
    let cur = origin;
    while (rest.length) {
      let k = 0;
      rest.forEach((s, i) => { if (haversineKm(cur, s.place) < haversineKm(cur, rest[k].place)) k = i; });
      out.push(rest[k]); cur = rest[k].place; rest.splice(k, 1);
    }
    return out;
  }
  const dayPlan = (spot, pool, cfg, mode, departMin, date = new Date()) =>
    schedulePlan(autoPlanStops(spot, pool, cfg, mode, departMin, date), cfg, mode, departMin).steps;

  // ---- 行った場所の記録: 都県ごとの数 ----
  function visitedStats(records) {
    const by = {};
    for (const r of records) { const p = r.pref || 'その他'; by[p] = (by[p] || 0) + 1; }
    return Object.entries(by).sort((a, b) => b[1] - a[1]);
  }
  const streetViewUrl = (s) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${s.lat},${s.lon}`;
  // 周辺の施設（コンビニ・トイレなど）を OpenStreetMap からその場で探す
  const NEARBY_KINDS = {
    conv: ['🏪コンビニ', 'nwr["shop"="convenience"]'], toilet: ['🚻トイレ', 'nwr["amenity"="toilets"]'],
    parking: ['🅿駐車場', 'nwr["amenity"="parking"]'], moto: ['🏍バイク駐車場', 'nwr["amenity"="motorcycle_parking"]'],
    fuel: ['⛽ガソリンスタンド', 'nwr["amenity"="fuel"]'], ev: ['🔌EV充電', 'nwr["amenity"="charging_station"]'],
    atm: ['🏧ATM', 'nwr["amenity"="atm"]'], cafe: ['☕カフェ', 'nwr["amenity"="cafe"]'],
  };
  const nearbyQuery = (p, kind, m = 2000) => 'data=' + encodeURIComponent(`[out:json][timeout:25];${NEARBY_KINDS[kind][1]}(around:${m},${p.lat},${p.lon});out center tags 30;`);
  function parseNearby(json, p) {
    return ((json && json.elements) || []).map((e) => {
      const c = e.lat != null ? e : e.center || {};
      const t = e.tags || {};
      return { name: t.name || t.brand || t.operator || '（名前なし）', lat: c.lat, lon: c.lon, oh: t.opening_hours, distKm: haversineKm(p, c) };
    }).filter((x) => x.lat != null).sort((a, b) => a.distKm - b.distKm);
  }

  // ---- 太陽の位置（NOAA の簡易式。誤差 1 分・0.1 度程度） ----
  const RAD = Math.PI / 180;
  function sunPosition(date, lat, lon) {
    const jd = date.getTime() / 864e5 + 2440587.5, t = (jd - 2451545) / 36525;
    const l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360, m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
    const c = Math.sin(m * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) + Math.sin(2 * m * RAD) * (0.019993 - 0.000101 * t) + Math.sin(3 * m * RAD) * 0.000289;
    const lam = l0 + c - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * t) * RAD);
    const eps = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60 + 0.00256 * Math.cos((125.04 - 1934.136 * t) * RAD);
    const dec = Math.asin(Math.sin(eps * RAD) * Math.sin(lam * RAD));
    const ra = Math.atan2(Math.cos(eps * RAD) * Math.sin(lam * RAD), Math.cos(lam * RAD));
    const gmst = (280.46061837 + 360.98564736629 * (jd - 2451545)) % 360;
    const ha = (gmst + lon) * RAD - ra;
    const alt = Math.asin(Math.sin(lat * RAD) * Math.sin(dec) + Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(ha));
    const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(lat * RAD) - Math.sin(lat * RAD) * Math.cos(ha));
    return { alt: alt / RAD, az: ((az / RAD) + 360) % 360 };
  }
  // その日（0 時から 24 時間）で、高度 target を上向き・下向きに横切る時刻と方角（2 分刻みで探して直線で補う）
  function sunCross(day, lat, lon, target) {
    const t0 = new Date(day); t0.setHours(0, 0, 0, 0);
    const out = { rise: null, set: null };
    let prev = sunPosition(t0, lat, lon).alt;
    for (let k = 1; k <= 720; k++) {
      const d = new Date(t0.getTime() + k * 120e3), p = sunPosition(d, lat, lon);
      if ((prev < target) !== (p.alt < target)) {
        const f = (target - prev) / (p.alt - prev), at = new Date(d.getTime() - 120e3 * (1 - f));
        out[p.alt > prev ? 'rise' : 'set'] = { at, az: sunPosition(at, lat, lon).az };
      }
      prev = p.alt;
    }
    return out;
  }
  const sunTimes = (day, p) => sunCross(day, p.lat, p.lon, -0.833);
  const DIR16 = ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東', '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'];
  const dir16 = (az) => DIR16[Math.round(az / 22.5) % 16];
  function bearing(a, b) {
    const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD);
    const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }
  // ダイヤモンド富士（太陽が富士山頂に重なる日）の予測。その場所から山頂が見える前提で、方角 ±0.3 度に入る日と時刻
  const FUJI = { lat: 35.3606, lon: 138.7274, ele: 3776 };
  function diamondFuji(p, from = new Date(), days = 366) {
    const dist = haversineKm(p, FUJI);
    if (dist < 8 || dist > 200) return [];
    const az = bearing(p, FUJI);
    const kind = az > 200 && az < 320 ? 'set' : az > 40 && az < 160 ? 'rise' : null;
    if (!kind) return [];
    const angle = Math.atan((FUJI.ele - (p.ele || 50) - dist * dist / (2 * 6371) * 1000 * 0.87) / (dist * 1000)) / RAD;
    const out = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(from.getTime() + i * 864e5);
      const x = sunCross(d, p.lat, p.lon, angle)[kind];
      if (x && Math.abs(x.az - az) < 0.3) out.push({ at: x.at, kind: kind === 'set' ? '夕方（沈む）' : '朝（昇る）' });
    }
    return out;
  }

  // ---- 到達圏（Valhalla の isochrone）と、多角形の中にあるか ----
  const ISO_COSTING = { car: 'auto', bike: 'motorcycle', bicycle: 'bicycle' };
  const isochroneUrl = (o, mode, minutes) => ISO_COSTING[mode] ? 'https://valhalla1.openstreetmap.de/isochrone?json=' + encodeURIComponent(JSON.stringify({
    locations: [{ lat: o.lat, lon: o.lon }], costing: ISO_COSTING[mode], contours: minutes.map((time) => ({ time })), polygons: true, denoise: 0.5, generalize: 150 })) : null;
  function inRing(p, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > p.lat) !== (yj > p.lat) && p.lon < (xj - xi) * (p.lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  // GeoJSON の Polygon / MultiPolygon（外周の中で、穴の外）
  function inGeometry(p, g) {
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    return polys.some((rings) => inRing(p, rings[0]) && !rings.slice(1).some((h) => inRing(p, h)));
  }

  // ---- カーブの多さ（1km あたりの向きの変化の合計・度）。100m おきに間引いてから測る ----
  const lonlat = ([lon, lat]) => ({ lat, lon }); // ルートの線は [経度, 緯度]
  function curviness(line) {
    const pts = [lonlat(line[0])];
    for (const q of line) if (haversineKm(pts[pts.length - 1], lonlat(q)) >= 0.1) pts.push(lonlat(q));
    let turn = 0, km = 0;
    for (let i = 1; i < pts.length; i++) {
      km += haversineKm(pts[i - 1], pts[i]);
      if (i < 2) continue;
      const h1 = bearing(pts[i - 2], pts[i - 1]), h2 = bearing(pts[i - 1], pts[i]);
      turn += Math.abs(((h2 - h1 + 540) % 360) - 180);
    }
    return km > 0.5 ? turn / km : 0;
  }
  const curvStars = (v) => (v < 40 ? 1 : v < 90 ? 2 : v < 160 ? 3 : v < 260 ? 4 : 5); // 箱根の林道・峠道で 200〜500

  // ---- 祝日（振替休日・春分・秋分を含む。2000〜2099 年） ----
  function baseHoliday(date) {
    const y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate(), wd = date.getDay();
    const nthMon = (n) => d === (8 - new Date(y, m - 1, 1).getDay()) % 7 + 1 + 7 * (n - 1);
    const fixed = { 1: [1], 2: [11, 23], 4: [29], 5: [3, 4, 5], 8: [11], 11: [3, 23] };
    const spring = Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
    const autumn = Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
    const isH = (fixed[m] || []).includes(d) || (m === 3 && d === spring) || (m === 9 && d === autumn)
      || (wd === 1 && ((m === 1 && nthMon(2)) || (m === 7 && nthMon(3)) || (m === 9 && nthMon(3)) || (m === 10 && nthMon(2))));
    return isH;
  }
  // 振替休日: 日曜の祝日のあと、最初の祝日でない日
  function jpHoliday(date) {
    if (baseHoliday(date)) return true;
    for (let k = 1; k < 7; k++) {
      const p = new Date(date.getFullYear(), date.getMonth(), date.getDate() - k);
      if (!baseHoliday(p)) return false;
      if (p.getDay() === 0) return true;
    }
    return false;
  }
  // 混みやすさの目安（実際の混雑ではなく、休日・連休・見頃・時間帯から）
  function crowdLevel(s, date) {
    const m = date.getMonth() + 1, d = date.getDate(), h = date.getHours();
    const reasons = [];
    if (date.getDay() === 0 || date.getDay() === 6 || jpHoliday(date)) reasons.push(jpHoliday(date) ? '祝日' : '週末');
    if ((m === 4 && d >= 29) || (m === 5 && d <= 5) || (m === 8 && d >= 11 && d <= 16) || (m === 12 && d >= 29) || (m === 1 && d <= 3)) reasons.push('大型連休');
    if (seasonNow(s, m).length) reasons.push('見頃の時期');
    if (h >= 10 && h < 15) reasons.push('昼の時間帯');
    const score = reasons.filter((r) => r !== '昼の時間帯').length + (reasons.includes('昼の時間帯') ? 0.5 : 0);
    return { level: score >= 2 ? 2 : score >= 1 ? 1 : 0, label: ['空いていそう', 'やや混みそう', '混みやすい'][score >= 2 ? 2 : score >= 1 ? 1 : 0], reasons };
  }

  // ---- 方面別の天気用: 起点から各方面へ km 先の地点 ----
  function destPoint(o, az, km) {
    const r = km / 6371, b = az * RAD, la = o.lat * RAD, lo = o.lon * RAD;
    const lat2 = Math.asin(Math.sin(la) * Math.cos(r) + Math.cos(la) * Math.sin(r) * Math.cos(b));
    const lon2 = lo + Math.atan2(Math.sin(b) * Math.sin(r) * Math.cos(la), Math.cos(r) - Math.sin(la) * Math.sin(lat2));
    return { lat: lat2 / RAD, lon: lon2 / RAD };
  }
  const dirPoints = (o, km = 70) => DIRS.map((d, i) => ({ dir: d, ...destPoint(o, i * 45, km) }));

  // ---- 圏外用の地図: ルートにかかるタイル（前後 pad 枚） ----
  function tilesAlong(line, zooms, pad = 1) {
    const out = new Map();
    for (const z of zooms) {
      const n = 2 ** z;
      for (const [lon, lat] of line) {
        const x = Math.floor((lon + 180) / 360 * n);
        const y = Math.floor((1 - Math.log(Math.tan(lat * RAD) + 1 / Math.cos(lat * RAD)) / Math.PI) / 2 * n);
        for (let dx = -pad; dx <= pad; dx++) for (let dy = -pad; dy <= pad; dy++) out.set(`${z}/${x + dx}/${y + dy}`, { z, x: x + dx, y: y + dy });
      }
    }
    return [...out.values()];
  }
  // ルートが通る、その月に閉鎖・通行止めの道（道の地点が 2 つ以上ルートから 500m 以内）
  const closedAlong = (line, roads, month) => roads.filter((r) => (r.closedMonths || []).includes(month)
    && stopsAlongRoute(r.points.map(pt), line, 0.5).length >= 2);

  // 帰り道に寄れる温泉: ルートから offKm 以内の温泉を、帰る向き（周回なら後半、目的地までなら目的地から起点へ）に並べる。
  // at: その温泉に着く時刻の目安（周回は出発時刻から、片道は「帰り始める時刻」backMs から）
  function onsenHome(items, line, totalMin, opts) {
    const { loop, departMs, backMs, offKm = 3 } = opts;
    const hits = stopsAlongRoute(items.filter((s) => (s.genres || []).includes('onsen')), line, offKm);
    const total = hits.length ? Math.max(...hits.map((h) => h.alongKm), 1) : 1;
    let len = 0;
    for (let i = 1; i < line.length; i++) len += haversineKm(lonlat(line[i - 1]), lonlat(line[i]));
    const kmh = len / Math.max(totalMin / 60, 0.1);
    const out = [];
    const seen = new Set();
    for (const h of hits) {
      const key = norm(h.name);
      if (seen.has(key)) continue;
      seen.add(key);
      if (loop) {
        if (h.alongKm < len * 0.5) continue; // 周回は後半だけ
        out.push({ ...h, homeKm: len - h.alongKm, at: departMs + h.alongKm / kmh * 3600e3 });
      } else {
        out.push({ ...h, homeKm: h.alongKm, at: backMs + (len - h.alongKm) / kmh * 3600e3 });
      }
    }
    // 家に近い（最後に寄れる）順
    return out.sort((a, b) => a.homeKm - b.homeKm).map((x) => ({ ...x, open: openState(x.oh, new Date(x.at)) }));
  }

  // Wikimedia Commons を施設名で探す（付近の写真より関係のある写真が出やすい）
  const commonsSearchUrl = (name, limit = 4) => 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', format: 'json', origin: '*', generator: 'search', gsrnamespace: '6', gsrsearch: name, gsrlimit: String(limit),
    prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '480' }).toString();
  // Google マップの写真（Places API (New)・利用者が自分の API キーを設定したときだけ）
  const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
  const placesBody = (s) => JSON.stringify({ textQuery: s.name, languageCode: 'ja', maxResultCount: 1,
    locationBias: { circle: { center: { latitude: s.lat, longitude: s.lon }, radius: 1000 } } });
  // 2km より離れた候補は同じ名前の別の場所として使わない
  function parsePlacesPhotos(j, s, key, limit = 4) {
    const p = j && j.places && j.places[0];
    if (!p || !p.location || haversineKm(s, { lat: p.location.latitude, lon: p.location.longitude }) > 2) return null;
    return { page: p.googleMapsUri || '', parking: p.parkingOptions || null, photos: (p.photos || []).slice(0, limit).map((ph) => ({
      thumb: `https://places.googleapis.com/v1/${ph.name}/media?maxWidthPx=480&key=${encodeURIComponent(key)}`,
      artist: ((ph.authorAttributions || [])[0] || {}).displayName || '', artistUri: ((ph.authorAttributions || [])[0] || {}).uri || '' })) };
  }
  // Google マップの駐車場情報（parkingOptions）→ 文。情報がなければ null。すべて false なら「なし」
  const PARK_OPT = [['freeParkingLot', '無料駐車場'], ['paidParkingLot', '有料駐車場'], ['freeGarageParking', '無料の立体・屋内駐車場'],
    ['paidGarageParking', '有料の立体・屋内駐車場'], ['freeStreetParking', '無料の路上駐車'], ['paidStreetParking', '有料の路上駐車（パーキングメーター）'], ['valetParking', 'バレーパーキング']];
  function parkingOptionsText(po) {
    if (!po || typeof po !== 'object' || !Object.keys(po).length) return null;
    const yes = PARK_OPT.filter(([k]) => po[k] === true).map(([, t]) => t);
    if (yes.length) return { has: true, text: `${yes.join('・')}あり` };
    return PARK_OPT.some(([k]) => po[k] === false) ? { has: false, text: '駐車場なし' } : null;
  }
  // 行った記録の少ない方面（少ない順。同じ数は seed で入れ替える）
  function lessVisitedDirs(records, origin, seed = 0) {
    const n = Object.fromEntries(DIRS.map((d) => [d, 0]));
    for (const r of records) n[direction(origin, r)]++;
    const rnd = mulberry32(seed);
    return DIRS.map((d) => ({ dir: d, count: n[d], r: rnd() })).sort((a, b) => a.count - b.count || a.r - b.r);
  }

  // ---- OpenPOI API（日本全国 約337万件・キー不要。Overture Maps と食品営業許可のオープンデータ） ----
  // 範囲は半径（最大 10km）か矩形。km が 10 を超えるときは矩形で
  function openPoiUrl(q, p, km, limit = 50) {
    const params = new URLSearchParams({ q: String(q).trim(), limit: String(Math.min(200, Math.max(1, limit))) });
    if (km <= 10) {
      params.set('center', `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`);
      params.set('radius', String(Math.max(1, Math.round(km * 1000))));
    } else {
      const dlat = km / 111, dlon = km / (111 * Math.cos(p.lat * RAD));
      params.set('bbox', [p.lon - dlon, p.lat - dlat, p.lon + dlon, p.lat + dlat].map((v) => v.toFixed(4)).join(','));
    }
    return `https://api.openpoiapi.com/v1/search?${params}`;
  }
  const FOOD_RE = /restaurant|cafe|coffee|food|bakery|ramen|noodle|sushi|izakaya|bar|diner|pizza|burger|curry|steak|yakiniku|soba|udon|bistro|dessert|食品|飲食|営業許可/i;
  const OP_GENRE = [[/hot_spring|onsen|spa|bath|sauna|温泉|銭湯/i, 'onsen'], [/museum|gallery|美術|博物/i, 'museum'], [/park|garden|公園|庭園/i, 'garden'],
    [/temple|shrine|寺|神社/i, 'temple'], [/shopping|mall|store|shop|market|商店|販売/i, 'shopping'], [/amusement|zoo|aquarium|theme|playground/i, 'play'],
    [/hotel|inn|lodging|旅館|宿/i, 'lodging'], [/viewpoint|scenic|展望/i, 'scenic']];
  function parseOpenPoi(j) {
    const out = [];
    for (const r of (j && Array.isArray(j.results) ? j.results : [])) {
      if (!r || typeof r.name !== 'string' || !r.name || typeof r.lat !== 'number' || typeof r.lng !== 'number') continue;
      const cat = typeof r.category === 'string' && r.category !== 'unknown' ? r.category : '';
      const src = typeof r.source === 'string' ? r.source : '';
      const g = FOOD_RE.test(`${cat} ${src}`) ? 'food' : (OP_GENRE.find(([re]) => re.test(cat)) || [0, 'sightseeing'])[1];
      out.push({ id: `op:${r.name}@${r.lat.toFixed(5)},${r.lng.toFixed(5)}`, name: r.name, kana: r.name_kana || undefined,
        lat: r.lat, lon: r.lng, genres: [g], indoor: g === 'food' || g === 'museum' || g === 'shopping', url: '',
        note: [cat.replace(/_/g, ' '), r.address].filter(Boolean).join('・'), op: true,
        attributions: Array.isArray(r.attributions) ? r.attributions : [] });
    }
    return out;
  }
  // 「近くの飲食店」「近くのラーメン」「温泉 近く」「周辺のカフェ」→ { word: '飲食店' }。近くの検索でなければ null
  function nearQuery(q) {
    const t = String(q || '').trim();
    // 「駐車場」「バイク 駐車場」「駐輪場」だけのときも、名前の検索ではなく近くの駐車場（駐車場という名前のスポットを探す人はいない）
    if (/^(?:バイク|二輪|オートバイ|原付|自転車)?\s*の?\s*(?:駐車場|駐輪場|パーキング)$/.test(t)) return { word: t.replace(/\s/g, '') };
    const m = t.match(/^(?:近くの|近くで|近所の|周辺の|付近の|この辺の|そばの)\s*(.+)$/) || t.match(/^(.+?)\s*(?:近く|周辺|付近|の近く)$/);
    return m && m[1].trim() ? { word: m[1].trim() } : null;
  }
  // 「飲食店」「ご飯」などは飲食すべて
  const ANY_FOOD = new Set(['飲食店', '飲食', 'ご飯', 'ごはん', '食事', 'グルメ', 'レストラン', 'ランチ', 'ディナー', '食べ物', 'お店']);
  const isAnyFood = (w) => ANY_FOOD.has(String(w).trim());
  // 近くの検索: 手元のデータ（items）から center の km 以内で、word に合うもの（飲食店なら飲食すべて）を近い順に
  function nearSearch(items, word, center, km, limit = 100) {
    const keys = isAnyFood(word) ? null : searchKeys(word);
    const out = [];
    for (const s of items) {
      if (s.lat == null) continue;
      const d = haversineKm(center, s);
      if (d > km) continue;
      if (keys ? !matchKeys(s, keys) : !(s.genres || []).includes('food')) continue;
      out.push({ ...s, distKm: d });
    }
    const seen = new Set();
    return out.sort((a, b) => a.distKm - b.distKm).filter((s) => {
      const k = `${norm(s.name)}@${s.lat.toFixed(3)},${s.lon.toFixed(3)}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    }).slice(0, limit);
  }
  // OpenPOI に送る言葉（「飲食店」などは「レストラン」に）
  const netWord = (w) => (isAnyFood(w) ? 'レストラン' : w);

  // ---- Wikipedia を施設名で探す（wikipedia タグのない場所の写真・説明用）。位置が 3km 以内の記事だけを使う ----
  const wikiSearchUrl = (s, lang = 'ja') => `https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({
    action: 'query', format: 'json', origin: '*', generator: 'search', gsrsearch: s.name, gsrlimit: '5',
    prop: 'pageimages|coordinates|extracts|info', piprop: 'thumbnail', pithumbsize: '480', exintro: '1', explaintext: '1',
    exsentences: '3', inprop: 'url', colimit: '5' }).toString();
  function parseWikiSearch(j, s) {
    const pages = Object.values((j && j.query && j.query.pages) || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
    for (const p of pages) {
      const c = (p.coordinates || [])[0];
      const near = c && haversineKm(s, { lat: c.lat, lon: c.lon }) <= 3;
      const sameName = norm(p.title).replace(/\(.*?\)|（.*?）/g, '') === norm(s.name);
      if (!(near || (sameName && !c)) || !p.extract) continue;
      // 記事名が施設名を含む（または逆）なら施設そのものの記事。そうでなければ付近の関連する記事として扱う
      const a = norm(p.title).replace(/\(.*?\)|（.*?）/g, ''), b = norm(s.name);
      return { text: shortExtract(p.extract), thumb: httpsOnly(p.thumbnail && p.thumbnail.source), page: httpsOnly(p.fullurl), byName: true,
        title: p.title, same: a.includes(b) || b.includes(a) };
    }
    return null;
  }

  // 入力補完: OpenPOI の /v1/suggest（言葉の候補 vocabulary と施設 results）
  const openPoiSuggestUrl = (q, p) => 'https://api.openpoiapi.com/v1/suggest?' + new URLSearchParams({ q: String(q).trim(), limit: '8',
    ...(p ? { center: `${p.lon.toFixed(4)},${p.lat.toFixed(4)}`, radius: '10000' } : {}) });
  function parseSuggest(j) {
    const words = (j && Array.isArray(j.vocabulary) ? j.vocabulary : []).map((v) => v && (v.query || v.label)).filter((x) => typeof x === 'string' && x);
    const places = (j && Array.isArray(j.results) ? j.results : []).map((r) => r && r.name).filter((x) => typeof x === 'string' && x);
    return { words, places };
  }
  // アプリの中だけで出せる候補: 料理のジャンル・「近くの○○」・名前の前方一致
  const NEAR_WORDS = ['飲食店', 'カフェ', 'ラーメン', 'コンビニ', '温泉', '公園', '駐車場', 'バイク駐車場', 'ガソリンスタンド'];
  function localSuggest(q, items, limit = 8) {
    const t = String(q || '').trim(), k = norm(t);
    if (!k) return [];
    const out = [];
    const add = (x) => { if (x && !out.includes(x) && out.length < limit) out.push(x); };
    if ('近くの'.startsWith(t) || t.startsWith('近く')) {
      const rest = t.replace(/^近くの?/, '');
      NEAR_WORDS.filter((w) => !rest || norm(w).startsWith(norm(rest))).forEach((w) => add(`近くの${w}`));
    }
    for (const [label, words] of FOOD_CATS) if ([label, ...words].some((w) => norm(w).startsWith(k))) add(label);
    for (const s of items) {
      if (out.length >= limit) break;
      if (norm(s.name).startsWith(k) || (s.kana && norm(s.kana).startsWith(k))) add(s.name);
    }
    return out;
  }
  // ---- 駐車場（OpenStreetMap からその場で）: 車の駐車場・バイク専用・二輪も止められる駐輪場・バイク可の駐車場 ----
  // 車は m、バイク（数が少ない）は mb まで探す
  const parkingQuery = (p, m = 600, mb = 1500) => 'data=' + encodeURIComponent(`[out:json][timeout:25];(`
    + `nwr["amenity"="parking"](around:${m},${p.lat},${p.lon});`
    + `nwr["amenity"="parking"]["motorcycle"~"^(yes|designated|permissive)$"](around:${mb},${p.lat},${p.lon});`
    + `nwr["amenity"="motorcycle_parking"](around:${mb},${p.lat},${p.lon});`
    + `nwr["amenity"="bicycle_parking"]["motorcycle"~"^(yes|designated|permissive)$"](around:${mb},${p.lat},${p.lon});`
    + `);out center tags 120;`);
  const YES = /^(yes|designated|permissive)$/;
  // その施設の駐車場らしいか: 100m 以内で、利用者用（access=customers）か名前にその施設名を含む
  const coreName = (n) => norm(n).replace(/[（(].*?[)）]/g, '').replace(/駐車場|パーキング|第[一二三四五1-9]|p$/g, '');
  function parseParking(json, p) {
    const car = [], bike = [];
    for (const e of (json && json.elements) || []) {
      const t = e.tags || {}, c = e.lat != null ? e : e.center || {};
      if (c.lat == null || /^(private|no)$/.test(t.access || '')) continue;
      const d = haversineKm(p, c);
      const name = t.name || t.operator || '';
      const capMoto = +(t['capacity:motorcycle'] || 0);
      const own = d <= 0.15 && !!name && !!p.name && coreName(p.name).length >= 2 && (coreName(name).includes(coreName(p.name)) || (coreName(name).length >= 2 && coreName(p.name).includes(coreName(name))));
      const x = { name, lat: c.lat, lon: c.lon, distKm: d, own, oh: t.opening_hours, access: t.access || '',
        fee: t.fee === 'yes' ? '有料' : t.fee === 'no' ? '無料' : '', capacity: +(t.capacity || 0) || null, capMoto: capMoto || null,
        kind: t.amenity === 'motorcycle_parking' ? 'バイク専用' : t.amenity === 'bicycle_parking' ? '駐輪場（二輪も可）'
          : t.parking === 'multi-storey' ? '立体駐車場' : t.parking === 'underground' ? '地下駐車場' : '駐車場',
        motoNo: t.motorcycle === 'no' };
      if (t.amenity === 'parking' && d <= 0.65) car.push(x);
      if (t.amenity !== 'parking' || YES.test(t.motorcycle || '') || capMoto > 0) bike.push({ ...x, motoOk: true });
    }
    const byOwnThenDist = (a, b) => (b.own - a.own) || a.distKm - b.distKm;
    return { car: car.sort(byOwnThenDist), bike: bike.sort(byOwnThenDist) };
  }
  // バイクを止められる場所をまとめる: 前もって集めたデータ（moto）＋その場の検索（live）＋OpenPOI の名前＋道の駅。
  // 40m 以内の重なりは 1 件に（確かな情報を優先）。likely（道の駅・SA・PA）は「たいてい止められる」
  const MOTO_NAME_RE = /バイク|二輪|オートバイ|原付|モーターサイクル|ﾊﾞｲｸ|タイムズのB|モトパーク|バイクパーク/;
  function mergeBikeSpots(p, km, sources) {
    const all = [];
    for (const [src, xs] of sources) {
      for (const x of xs || []) {
        if (x.lat == null) continue;
        const d = haversineKm(p, x);
        if (d > km) continue;
        all.push({ ...x, distKm: d, src });
      }
    }
    const rank = (x) => (x.official ? -1 : x.likely ? 2 : x.src === 'OpenPOI' ? 1 : 0);
    all.sort((a, b) => rank(a) - rank(b) || a.distKm - b.distKm);
    const out = [];
    for (const x of all) if (!out.some((y) => haversineKm(x, y) < 0.04)) out.push(x);
    return out.sort((a, b) => (!!b.own - !!a.own) || (!!a.likely - !!b.likely) || (!!b.official - !!a.official) * (Math.abs(a.distKm - b.distKm) < 0.3) || a.distKm - b.distKm);
  }
  // 前もって集めた車の駐車場（小さい形）→ 表示用
  const parkFromCell = (x) => ({ name: x.n || '', lat: x.la, lon: x.lo, fee: x.f === 1 ? '有料' : x.f === 0 ? '無料' : '', capacity: x.c || null,
    capMoto: x.cm || null, motoNo: x.m === 0, motoOk: x.m === 1 || x.cm > 0, access: x.a ? 'customers' : '',
    kind: x.t === 'ms' ? '立体駐車場' : x.t === 'ug' ? '地下駐車場' : x.k === 'fsq' ? '駐車場（Foursquare）' : '駐車場' });
  // コインパーキング（多くは二輪不可）の名前
  const COIN_RE = /タイムズ(?!のB)|リパーク|名鉄協商|NPC|コインパーキング|パラカ|ナビパーク|トラストパーク|エコロパーク|D-Parking|ザ・パーク|リメイク|PMO|ユアー/;
  // バイクも止められるかもしれない（未確認）: 二輪不可でなく、コインパーキングでなく、利用者用か 50 台以上
  const maybeMoto = (x) => !x.motoNo && !x.motoOk && !COIN_RE.test(x.name || '') && (x.access === 'customers' || (x.capacity || 0) >= 50);
  // その施設の駐車場らしいか（100m 以内で利用者用か同じ名前）
  function markOwn(xs, p) {
    for (const x of xs) {
      const d = haversineKm(p, x);
      x.distKm = d;
      x.own = d <= 0.15 && !!x.name && !!p.name && coreName(p.name).length >= 2 && (coreName(x.name).includes(coreName(p.name)) || (coreName(x.name).length >= 2 && coreName(p.name).includes(coreName(x.name))));
    }
    return xs;
  }
  // 40m 以内の重なりは 1 件に（先に入れたものを優先）
  function dedupeNear(xs, m = 0.04) {
    const out = [];
    for (const x of xs) if (!out.some((y) => haversineKm(x, y) < m)) out.push(x);
    return out;
  }
  // 自治体・都道府県の公式データ（data/moto_official.json）→ バイク欄の形に
  const officialMoto = (x) => ({ name: x.name, lat: x.lat, lon: x.lon, official: true, moped: x.moped && !x.moto,
    kind: !x.moto ? '公式・原付のみ' : x.ccUnknown ? '公式・二輪可（排気量の制限は現地で確認）' : '公式・自動二輪可', fee: x.fee || '', hours: x.hours || '', cap: x.capacity || null, addr: x.addr || '',
    srcName: [x.muni, x.src, x.license].filter(Boolean).join(' '), srcUrl: x.srcUrl || '' });
  const isParkingWord = (w) => /駐車|駐輪|パーキング|parking/i.test(String(w));
  const isBikeWord = (w) => /バイク|二輪|オートバイ|原付|モーターサイクル|駐輪/.test(String(w));

  // ---- データの更新（アプリから GitHub Actions に収集を依頼） ----
  const COLLECT_PARTS = { pois: '立ち寄り候補', spots: '観光スポット', cells: 'グルメ・史跡など', roads: 'ドライブコース', moto: 'バイク駐車場' };
  // 前回の収集で取れなかった・時間切れの種類（次の依頼で取り直す）
  const pendingParts = (st) => Object.keys(COLLECT_PARTS).filter((k) => st && st[`${k}_error`]);
  // 最新の実行（workflow_runs[0]）→ { state: 'queued'|'running'|'done'|'failed'|null, startedMin }
  function runState(j, now = Date.now()) {
    const r = j && Array.isArray(j.workflow_runs) ? j.workflow_runs[0] : null;
    if (!r) return { state: null };
    const started = Date.parse(r.run_started_at || r.created_at);
    const state = r.status === 'completed' ? (r.conclusion === 'success' ? 'done' : 'failed') : r.status === 'queued' || r.status === 'waiting' || r.status === 'pending' ? 'queued' : 'running';
    return { state, startedMin: Math.max(0, Math.round((now - started) / 60e3)), at: r.updated_at };
  }

  // ---- 交通費の目安 ----
  const round10 = (y) => Math.round(y / 10) * 10;
  // ガソリン代（円）= 距離 ÷ 燃費 × 単価
  const fuelCost = (km, kmPerL, yenPerL) => (km > 0 && kmPerL > 0 ? round10(km / kmPerL * yenPerL) : 0);
  // 高速料金の目安: NEXCO の普通区間の式（ターミナルチャージ 150 円＋ 24.6 円/km、消費税 10%）。軽自動車・二輪は距離の分が 0.8 倍。
  // 首都高・大都市近郊区間・割引（ETC 休日割引など）は反映しない
  function tollEstimate(km, cls = 'normal') {
    if (!(km > 0.5)) return 0;
    return round10((150 + 24.6 * km * (cls === 'light' ? 0.8 : 1)) * 1.1);
  }
  // ルートの有料区間の距離（Valhalla の maneuvers の toll）
  // 有料区間（高速道路など）の範囲 [[始まりの km, 終わりの km]]（出発から。Valhalla の案内ごとの距離を足して）
  function tollSpans(legs) {
    const out = [];
    let km = 0;
    for (const m of (legs || []).flatMap((l) => l.maneuvers || [])) {
      const len = m.length || 0;
      const last = out[out.length - 1], joined = last && Math.abs(last[1] - km) < 1e-6;
      // 無料の自動車専用道路（KK線など）をはさんでも、一般道へ降りていなければ同じ区間として続ける
      if (m.toll || (m.highway && joined)) { if (joined) last[1] = km + len; else out.push([km, km + len]); }
      km += len;
    }
    return out.map(([a, b]) => [Math.round(a * 100) / 100, Math.round(b * 100) / 100]);
  }
  const inSpans = (km, spans) => (spans || []).some(([a, b]) => km >= a && km <= b);
  const tollKmOf = (legs) => (legs || []).flatMap((l) => l.maneuvers || []).reduce((a, m) => a + (m.toll ? m.length || 0 : 0), 0);
  // 電車の運賃の目安: JR（幹線）の普通運賃表で。営業キロは直線距離の 1.25 倍とみなす
  const JR_FARE = [[3, 150], [6, 190], [10, 200], [15, 240], [20, 330], [25, 420], [30, 510], [35, 590], [40, 680], [45, 770], [50, 860],
    [60, 990], [70, 1170], [80, 1340], [90, 1520], [100, 1690], [120, 1980], [140, 2310], [160, 2640], [180, 3080], [200, 3410],
    [220, 3740], [240, 4070], [260, 4510], [280, 4840], [300, 5170], [330, 5720], [360, 6050], [400, 6600]];
  function trainFare(straightKm) {
    const km = Math.max(1, Math.ceil(straightKm * 1.25));
    const row = JR_FARE.find(([max]) => km <= max);
    return row ? row[1] : round10(6600 + (km - 400) * 16.2);
  }
  const yen = (n) => `${Math.round(n).toLocaleString()}円`;

  // ドライブコースの種類（地図の色分け用）
  const COURSE_TYPES = {
    pick: ['★おすすめ（厳選）', '#d6336c'], skyline: ['スカイライン・観光道路', '#1c7ed6'], toge: ['峠道', '#2f9e44'],
    water: ['海沿い・湖畔', '#0c8599'], kogen: ['高原', '#74b816'], toll: ['有料道路', '#c92a2a'], rindo: ['林道', '#8d6e63'],
    scenic: ['そのほかの景色の道', '#7048e8'], pass: ['峠（地点）', '#f08c00'] };
  function courseType(r) {
    if (r.pass) return 'pass';
    if (!String(r.id).startsWith('osm:')) return 'pick';
    const n = `${r.name} ${r.note || ''}`;
    if (r.toll) return 'toll';
    if (/林道/.test(n)) return 'rindo';
    if (/峠/.test(n)) return 'toge';
    if (/スカイライン|パークウェイ|ターンパイク|観光道路|ライン/.test(n)) return 'skyline';
    if (/海|湖|シーサイド|浜/.test(n)) return 'water';
    if (/高原/.test(n)) return 'kogen';
    return 'scenic';
  }

  // 入れ方の案内に使う端末の種類
  function platformOf(ua, standalone) {
    if (standalone) return 'installed';
    const u = String(ua || '');
    const ios = /iPhone|iPad|iPod/.test(u) || (/Macintosh/.test(u) && /Mobile/.test(u));
    if (ios) return /CriOS|FxiOS|EdgiOS|Line\/|FBAN|Instagram/.test(u) ? 'ios-other' : 'ios-safari';
    if (/Android/.test(u)) return /Line\/|FBAN|Instagram|; wv\)/.test(u) ? 'android-inapp' : 'android';
    return 'desktop';
  }

  // ホーム画面のショートカットなどで開いたときの指定（?tab=touring / ?q=近くの飲食店 / ?gacha=1）
  function launchParams(search) {
    const p = new URLSearchParams(search || '');
    const tab = ['spots', 'events', 'touring', 'settings'].includes(p.get('tab')) ? p.get('tab') : null;
    return { tab, q: (p.get('q') || '').slice(0, 50), gacha: p.get('gacha') === '1' };
  }

  // 手元のデータと同じ場所（同じ名前で 300m 以内）は除く
  const notInLocal = (xs, local) => xs.filter((x) => !local.some((s) => norm(s.name) === norm(x.name) && haversineKm(s, x) < 0.3));

  // 「ホテルおおるり、〒329-2921 栃木県那須塩原市塩原815 3」のように施設名・郵便番号・住所をまとめて打ったもの →
  // { name: 施設名, addr: 住所, tries: 国土地理院の住所検索で順に試す文字（番地をだんだん短く） }
  function placeQuery(q) {
    const t = String(q || '').normalize('NFKC').replace(/〒?\s*\d{3}-?\d{4}/g, ' ').replace(/[、,，。・]/g, ' ').replace(/\s+/g, ' ').trim();
    const m = t.match(/(北海道|東京都|京都府|大阪府|[^\s]{2,3}県|[^\s]{1,6}[市区町村]).*$/);
    let addr = m ? m[0] : '', name = m ? t.slice(0, m.index).trim() : t;
    addr = addr.replace(/(\d+)\s+(?=\d)/g, '$1-').replace(/\s+/g, ''); // 「815 3」→「815-3」
    const tries = [];
    if (addr) {
      let a = addr;
      for (let k = 0; k < 4 && a; k++) { if (!tries.includes(a)) tries.push(a); const b = a.replace(/[-‐－]?\d+(番地?|号)?$|丁目$/, ''); if (b === a) break; a = b; }
    }
    if (!addr || !name) tries.push(t);
    return { name, addr, tries };
  }
  const gsiSearchUrl = (q) => `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`;
  function parseGsi(j, limit = 8) {
    const out = [];
    for (const x of Array.isArray(j) ? j : []) {
      const [lon, lat] = (x.geometry && x.geometry.coordinates) || [];
      if (typeof lat !== 'number' || typeof lon !== 'number' || !x.properties || !x.properties.title) continue;
      out.push({ name: x.properties.title, lat, lon });
      if (out.length >= limit) break;
    }
    return out;
  }
  const summaryUrl = (ref) => `https://${ref.lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(ref.title)}`;

  // 説明は句点で区切って max 文字以内に収める（1 文目が長すぎるときは切って「…」）
  function shortExtract(text, max = 120) {
    const sentences = String(text || '').match(/[^。]+。?/g) || [];
    let out = '';
    for (const s of sentences) {
      if ((out + s).length > max) break;
      out += s;
    }
    return out || (text ? String(text).slice(0, max) + '…' : '');
  }
  const httpsOnly = (u) => (typeof u === 'string' && u.startsWith('https://') ? u : null);

  function parseSummary(j) {
    if (!j || j.type === 'disambiguation' || !j.extract) return null;
    const urls = j.content_urls || {};
    return { text: shortExtract(j.extract), thumb: httpsOnly(j.thumbnail && j.thumbnail.source),
      page: httpsOnly((urls.mobile && urls.mobile.page) || (urls.desktop && urls.desktop.page)) };
  }

  // 座標の近くで撮られた写真（Wikimedia Commons の位置情報付きファイル）
  const commonsNearbyUrl = (lat, lon, radius = 300, limit = 3) => 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', format: 'json', origin: '*', generator: 'geosearch', ggsnamespace: '6', ggscoord: `${lat}|${lon}`,
    ggsradius: String(radius), ggslimit: String(limit), prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '480' }).toString();

  function parseCommons(j) {
    const pages = Object.values((j && j.query && j.query.pages) || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
    const out = [];
    for (const p of pages) {
      const ii = (p.imageinfo || [])[0] || {};
      const meta = ii.extmetadata || {};
      const thumb = httpsOnly(ii.thumburl), page = httpsOnly(ii.descriptionurl);
      if (!thumb || !page) continue;
      const artist = String((meta.Artist && meta.Artist.value) || '').replace(/<[^>]+>/g, '').trim();
      out.push({ thumb, page, artist, license: (meta.LicenseShortName && meta.LicenseShortName.value) || '' });
    }
    return out;
  }

  // ---- 約10万件のデータ: 0.25 度（約25km）四方の升目に分けて、必要な分だけ読み込む ----
  const CELL = 4; // 1 度あたりの升目の数
  const cellId = (lat, lon) => `${Math.floor(lat * CELL)}_${Math.floor(lon * CELL)}`;
  // 半径 km の円に少しでもかかる升目（per は 1 度あたりの升目の数。グルメなどは 4、地方ごとのデータは 1）
  function cellsInRadius(o, km, per = CELL) {
    const dlat = km / 111, dlon = km / (111 * Math.cos(rad(o.lat)));
    const out = [];
    for (let y = Math.floor((o.lat - dlat) * per); y <= Math.floor((o.lat + dlat) * per); y++) {
      for (let x = Math.floor((o.lon - dlon) * per); x <= Math.floor((o.lon + dlon) * per); x++) {
        // 升目の中で起点にいちばん近い点までの距離
        const lat = Math.min(Math.max(o.lat, y / per), (y + 1) / per), lon = Math.min(Math.max(o.lon, x / per), (x + 1) / per);
        if (haversineKm(o, { lat, lon }) <= km) out.push(`${y}_${x}`);
      }
    }
    return out;
  }

  // 「詳しく」の関連スポット: 似たもの（同じジャンル・30km 以内）、周辺（2km 以内・飲食以外）、近くの飲食（1km 以内）
  function relatedSpots(s, items, { limit = 5, chains = false } = {}) {
    const g0 = s.genres && s.genres[0];
    const withD = [], names = new Set([norm(s.name)]);
    for (const x of [...items].sort((a, b) => haversineKm(s, a) - haversineKm(s, b))) {
      const n = norm(x.name);
      if (x.id === s.id || names.has(n)) continue; // 同じ名前（データの重複）は近い 1 件だけ
      names.add(n);
      const d = haversineKm(s, x);
      if (d <= 30) withD.push({ ...x, distKm: d });
    }
    withD.sort((a, b) => a.distKm - b.distKm);
    const isFood = (x) => (x.genres || []).includes('food');
    return {
      similar: withD.filter((x) => !isFood(x) && x.genres && x.genres[0] === g0).slice(0, limit),
      nearby: withD.filter((x) => !isFood(x) && x.distKm <= 2).slice(0, limit),
      food: withD.filter((x) => isFood(x) && x.distKm <= 1 && (chains || !x.chain)).slice(0, limit),
    };
  }

  const ymd = (d) => d.toLocaleDateString('sv-SE'); // 端末のローカル日付で YYYY-MM-DD
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

  function weekend(now, weeksAhead = 0) {
    const day = now.getDay(); // 0 = 日曜
    const sat = addDays(now, (day === 0 ? -1 : 6 - day) + 7 * weeksAhead);
    return [ymd(sat), ymd(addDays(sat, 1))];
  }

  function periodRange(name, now) {
    if (name === 'weekend') return weekend(now);
    if (name === 'next') return weekend(now, 1);
    if (name === 'month') return [ymd(now), ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0))];
    return [ymd(now), ymd(new Date(now.getFullYear(), now.getMonth() + 3, now.getDate()))];
  }

  const isStale = (iso, nowMs, hours) => !iso || nowMs - Date.parse(iso) > hours * 3600e3;

  return { haversineKm, travelMinutes, prefGroup, setMainPrefs, isCurated, onsenSpot, dropSameName, ONSEN_AREA_KM, filterSpots, filterEvents, distToRoute, stopsAlongRoute,
    weekSeed, pickRecommendations, snsLinks, gmapsDirUrl, ymd, weekend, periodRange, isStale,
    tierOf, direction, DIRS, norm, searchSpots, spanDays,
    decodePolyline, scenicScore, scenicStars, detourRoads, pinWaypoints, loopPoints, coursePoints, chainRoad, CHAIN_MODES, outerFromPoints, capPoints, jaOnly, jctGuide, samplesIn, safeSpot, rampFree, spreadAlong, spreadPick, splitLegs, toGpx,
    geocodeToken, parseGmapsRoute, isShortMapsUrl, routeFromPlaces, refineGenres, TIME_BANDS, timeBandState, roadNightClosed, roadNightView, routeShade,
    wikiRef, summaryUrl, shortExtract, parseSummary, commonsNearbyUrl, parseCommons, gmapsSearchUrl, gmapsPlaceDirUrl, gsiReverseUrl, parseGsiAddress, gsiSearchUrl, parseGsi,
    cellId, cellsInRadius, relatedSpots, FOOD_CATS, searchKeys, inFoodCat,
    openState, ohText, seasonNow, seasonText, routeSamples, rainAlongUrl, parseRainAlong, elevationUrl, climbOf,
    placeQuery, sxCloseLoop, JMA_TIMES, jmaFrames, frameAt, mmLevel, gridPoints, modelUrl, modelFrames, gridLevelAt, rainTrust, RAIN_COLORS, RAIN_LABELS, rainLevel, tilePixel, routeAt, departOptions, rainVerdict, rainDetourVias, nearestOnLine,
    dayPlan, autoPlanStops, schedulePlan, orderStops, visitedStats, streetViewUrl, NEARBY_KINDS, nearbyQuery, parseNearby,
    sunPosition, sunTimes, dir16, bearing, diamondFuji, isochroneUrl, inGeometry, curviness, curvStars,
    jpHoliday, crowdLevel, dirPoints, tilesAlong, closedAlong, onsenHome,
    commonsSearchUrl, PLACES_URL, placesBody, parsePlacesPhotos, parkingOptionsText, lessVisitedDirs, openPoiUrl, parseOpenPoi, notInLocal,
    nearQuery, isAnyFood, nearSearch, netWord, wikiSearchUrl, parseWikiSearch, openPoiSuggestUrl, parseSuggest, localSuggest, launchParams, platformOf, COURSE_TYPES, courseType, fuelCost, tollEstimate, tollKmOf, tollSpans, inSpans, trainFare, yen,
    parkingQuery, parseParking, isParkingWord, isBikeWord, mergeBikeSpots, MOTO_NAME_RE, parkFromCell, COIN_RE, maybeMoto, markOwn, dedupeNear, officialMoto, COLLECT_PARTS, pendingParts, runState };
})();

if (typeof module !== 'undefined') module.exports = Lib;
