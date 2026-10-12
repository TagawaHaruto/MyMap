// MyMap の純粋関数。画面にもネットにも依存しない（node lib.test.js で検証）。
const Lib = (() => {
  const rad = (d) => d * Math.PI / 180;
  const MAIN_PREFS = ['東京', '神奈川', '埼玉', '千葉', '山梨'];

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

  // 一覧の段: 0=厳選・⭐、1=公式サイトか Wikipedia がある、2=その他（自動収集の名前だけの場所など）
  function tierOf(s, favs) {
    if (favs && favs.has(s.id)) return 0;
    if (!s.poi && !String(s.id).startsWith('osm:')) return 0;
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
      const minutes = travelMinutes(haversineKm(cfg.origin, s), f.mode, cfg);
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
  ];
  const FOOD_KEYS = new Map(FOOD_CATS.map(([label, words]) => [label, words.map(norm)]));
  const FOOD_NOT = { 'そば・うどん': [norm('中華そば')] }; // 「そば」で中華そば（ラーメン）を出さない
  // 検索語 → 探す文字列の一覧（ジャンル名・その呼び方なら全部の呼び方）
  function searchKeys(q) {
    const k = norm(q);
    for (const [label, keys] of FOOD_KEYS) if (norm(label) === k || keys.includes(k)) return Object.assign([...keys], { label });
    return k ? [k] : [];
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
    const out = [];
    for (const s of items) {
      if (!matchKeys(s, keys)) continue;
      out.push({ ...s, minutes: travelMinutes(haversineKm(cfg.origin, s), mode, cfg), tier: tierOf(s, favs) });
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
  function distToRoute(p, line) {
    const k = Math.cos(rad(p.lat));
    const xy = ([lon, lat]) => [lon * k * 111.32, lat * 110.57];
    const [px, py] = xy([p.lon, p.lat]);
    let best = { km: Infinity, along: 0 }, acc = 0;
    for (let i = 0; i + 1 < line.length; i++) {
      const [ax, ay] = xy(line[i]), [bx, by] = xy(line[i + 1]);
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy, len = Math.sqrt(len2);
      const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d < best.km) best = { km: d, along: acc + t * len };
      acc += len;
    }
    return best;
  }

  // ponytail: 全候補×全線分の総当たり。重くなったら線を間引くか bbox で前絞りする
  function stopsAlongRoute(items, line, maxKm) {
    // 経路の外接矩形＋余白の外にある候補は、距離計算の前に除く（結果は同じで数倍速い）
    const pad = maxKm / 90 + 0.001;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [lon, lat] of line) { x0 = Math.min(x0, lon); x1 = Math.max(x1, lon); y0 = Math.min(y0, lat); y1 = Math.max(y1, lat); }
    return items
      .filter((s) => s.lon >= x0 - pad && s.lon <= x1 + pad && s.lat >= y0 - pad && s.lat <= y1 + pad)
      .map((s) => { const r = distToRoute(s, line); return { ...s, offKm: r.km, alongKm: r.along }; })
      .filter((s) => s.offKm <= maxKm)
      .sort((a, b) => a.alongKm - b.alongKm);
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
  const loopPoints = (origin, road) => [origin, ...road.points.map(pt), origin];

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
  function dayPlan(spot, pool, cfg, mode, departMin, date = new Date()) {
    const move = (a, b) => travelMinutes(haversineKm(a, b), mode, cfg);
    const fmt = (m) => `${Math.floor(m / 60) % 24}:${String(Math.round(m % 60)).padStart(2, '0')}`;
    const steps = [];
    let t = departMin;
    steps.push({ time: fmt(t), what: `${cfg.origin.name}を出発` });
    t += move(cfg.origin, spot);
    steps.push({ time: fmt(t), what: `${spot.name}に到着`, place: spot, stay: stayOf(spot) });
    t += stayOf(spot);
    const lunchAt = new Date(date); lunchAt.setHours(Math.floor(Math.max(t, 690) / 60), Math.max(t, 690) % 60, 0, 0);
    const near = (xs, km) => xs.map((x) => ({ x, d: haversineKm(spot, x) })).filter((o) => o.d <= km && o.x.id !== spot.id).sort((a, b) => a.d - b.d);
    const lunch = near(pool.filter((x) => (x.genres || []).includes('food') && !x.chain && openState(x.oh, lunchAt) !== false), 1.5)
      .sort((a, b) => (openState(b.x.oh, lunchAt) === true) - (openState(a.x.oh, lunchAt) === true) || a.d - b.d)[0];
    if (lunch) {
      t = Math.max(t, 690); // 昼食は 11:30 以降
      steps.push({ time: fmt(t), what: `昼食: ${lunch.x.name}`, place: lunch.x, stay: 60 });
      t += 60;
    }
    const second = near(pool.filter((x) => (x.genres || []).includes('onsen')), 15)[0]
      || near(pool.filter((x) => !(x.genres || []).includes('food') && (x.genres || []).some((g) => g !== 'lodging')), 3)[0];
    let last = spot;
    if (second) {
      t += move(spot, second.x);
      steps.push({ time: fmt(t), what: `${second.x.name}へ`, place: second.x, stay: stayOf(second.x) });
      t += stayOf(second.x);
      last = second.x;
    }
    t += move(last, cfg.origin);
    steps.push({ time: fmt(t), what: `${cfg.origin.name}に帰着` });
    return steps;
  }

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
  function curviness(line) {
    const pts = [line[0]];
    for (const q of line) if (haversineKm(pt(pts[pts.length - 1]), pt(q)) >= 0.1) pts.push(q);
    let turn = 0, km = 0;
    for (let i = 1; i < pts.length; i++) {
      km += haversineKm(pt(pts[i - 1]), pt(pts[i]));
      if (i < 2) continue;
      const h1 = bearing(pt(pts[i - 2]), pt(pts[i - 1])), h2 = bearing(pt(pts[i - 1]), pt(pts[i]));
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
  // 半径 km の円に少しでもかかる升目
  function cellsInRadius(o, km) {
    const dlat = km / 111, dlon = km / (111 * Math.cos(rad(o.lat)));
    const out = [];
    for (let y = Math.floor((o.lat - dlat) * CELL); y <= Math.floor((o.lat + dlat) * CELL); y++) {
      for (let x = Math.floor((o.lon - dlon) * CELL); x <= Math.floor((o.lon + dlon) * CELL); x++) {
        // 升目の中で起点にいちばん近い点までの距離
        const lat = Math.min(Math.max(o.lat, y / CELL), (y + 1) / CELL), lon = Math.min(Math.max(o.lon, x / CELL), (x + 1) / CELL);
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

  return { haversineKm, travelMinutes, prefGroup, filterSpots, filterEvents, distToRoute, stopsAlongRoute,
    weekSeed, pickRecommendations, snsLinks, gmapsDirUrl, ymd, weekend, periodRange, isStale,
    tierOf, direction, DIRS, norm, searchSpots, spanDays,
    decodePolyline, scenicScore, scenicStars, detourRoads, pinWaypoints, loopPoints, toGpx,
    wikiRef, summaryUrl, shortExtract, parseSummary, commonsNearbyUrl, parseCommons, gmapsSearchUrl, gmapsPlaceDirUrl, gsiReverseUrl, parseGsiAddress, gsiSearchUrl, parseGsi,
    cellId, cellsInRadius, relatedSpots, FOOD_CATS, searchKeys, inFoodCat,
    openState, ohText, seasonNow, seasonText, routeSamples, rainAlongUrl, parseRainAlong, elevationUrl, climbOf,
    dayPlan, visitedStats, streetViewUrl, NEARBY_KINDS, nearbyQuery, parseNearby,
    sunPosition, sunTimes, dir16, bearing, diamondFuji, isochroneUrl, inGeometry, curviness, curvStars,
    jpHoliday, crowdLevel, dirPoints, tilesAlong, closedAlong };
})();

if (typeof module !== 'undefined') module.exports = Lib;
