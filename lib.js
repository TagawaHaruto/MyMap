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
    if (h === undefined) { h = [s.name, s.kana, ...(s.tags || [])].map(norm).join('\u0000'); normCache.set(s, h); }
    return h;
  };

  function searchSpots(items, q, cfg, favs, mode, limit = 50) {
    const key = norm(q);
    if (!key) return [];
    const out = [];
    for (const s of items) {
      if (!haystack(s).includes(key)) continue;
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
  const gmapsSearchUrl = (s) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.name)}`;
  // 目的地の検索: 国土地理院の地名・住所検索（無料・登録不要）
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
    const withD = [];
    for (const x of items) {
      if (x.id === s.id || x.name === s.name) continue;
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
    wikiRef, summaryUrl, shortExtract, parseSummary, commonsNearbyUrl, parseCommons, gmapsSearchUrl, gsiSearchUrl, parseGsi,
    cellId, cellsInRadius, relatedSpots };
})();

if (typeof module !== 'undefined') module.exports = Lib;
