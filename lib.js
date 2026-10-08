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

  function searchSpots(items, q, cfg, favs, mode, limit = 50) {
    const key = norm(q);
    if (!key) return [];
    const out = [];
    for (const s of items) {
      if (!norm(s.name).includes(key) && !norm(s.kana).includes(key) && !(s.tags || []).some((t) => norm(t).includes(key))) continue;
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
    // 期間内に始まる・3日以内のものを先に、長期の展示は最後。その中は近い順（位置不明は後ろ）
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

  function snsLinks(s) {
    const tag = (s.tags && s.tags[0]) || s.name.replace(/\s+/g, '');
    return {
      instagram: `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`,
      x: `https://x.com/search?q=${encodeURIComponent('#' + tag)}`,
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
    tierOf, direction, DIRS, norm, searchSpots, spanDays };
})();

if (typeof module !== 'undefined') module.exports = Lib;
