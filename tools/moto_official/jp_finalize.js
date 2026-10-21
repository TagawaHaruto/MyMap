// 全国版 4/4: 座標・住所を国土地理院の API で補い、重複を除き、東京の既存分（data/moto_official.json）と合わせて出力する。
// usage: node --use-system-ca jp_finalize.js <workdir> [出力先 = C:/Users/B3469/osmdata/moto_official_japan.json]
// 座標がない行: GSI 住所検索 https://msearch.gsi.go.jp/address-search/AddressSearch?q=<住所>（1件目。市区町村名が合わないものは使わない）
// 住所がない行: GSI 逆ジオコーダ LonLatToAddress → data/muni.json の市区町村名 + 町丁目 +「付近」
// 同名で約 50m 以内は 1 件に。座標は小数 5 桁。fee は 200 文字まで。
const fs = require('fs'), path = require('path');
const W = process.argv[2] || '.', OUT = process.argv[3] || 'C:/Users/B3469/osmdata/moto_official_japan.json';
const ROOT = path.join(__dirname, '..', '..');
const tokyo = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'moto_official.json'))); // 東京の既存分（書き換えない）
const muniName = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'muni.json'))); // {市区町村コード(先頭0なし・検査数字なし): 名称}
const d = JSON.parse(fs.readFileSync(`${W}/stage_jp.json`));
const cacheF = `${W}/geocache.json`; const cache = fs.existsSync(cacheF) ? JSON.parse(fs.readFileSync(cacheF)) : {};
const R5 = (x) => Math.round(+x * 1e5) / 1e5;
const get = async (u) => { for (let i = 0; ; i++) { try { const r = await fetch(u, { signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error(r.status); return await r.json(); } catch (e) { if (i >= 2) throw e; } } };
const km = (a, b) => { const r = Math.PI / 180, x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r; return 6371 * Math.hypot(x, y); };
(async () => {
  const geo = [], dropped = [];
  for (const o of d) {
    if (o.lat == null && o.addr) {
      const q = o.addr.replace(/\(.*?\)|（.*?）/g, '').replace(/(の一部|地内|先|ほか|外)$/, '').trim();
      const k = 'f:' + q; cache[k] ??= await get('https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent(q));
      const h = cache[k][0]; const city = o.muni.replace(/[都道府県]$/, '');
      if (h && h.properties.title.includes(city)) { o.lon = R5(h.geometry.coordinates[0]); o.lat = R5(h.geometry.coordinates[1]); o.approx = !/\d+(番|号)/.test(h.properties.title.normalize('NFKC')); geo.push(`${o.muni} ${o.name} <- ${q} => ${h.properties.title}${o.approx ? '（番地なし＝町丁目などの代表点）' : ''}`); }
    }
    if (o.lat != null && !o.addr) {
      const k = `r:${o.lat},${o.lon}`; cache[k] ??= await get(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${o.lat}&lon=${o.lon}`);
      const r = cache[k]?.results; const m = r && muniName[String(+r.muniCd)];
      if (m && r.lv01Nm && r.lv01Nm !== '－') o.addr = `${m}${r.lv01Nm}付近`; else if (m) o.addr = `${m}付近`;
    }
  }
  fs.writeFileSync(cacheF, JSON.stringify(cache));
  let kept = d.filter((o) => { const ok = o.lat != null && o.lat > 20 && o.lat < 46 && o.lon > 122 && o.lon < 154; if (!ok) dropped.push(`${o.muni} ${o.name} (${o.addr || '住所なし'})`); return ok; });
  const seen = []; kept = kept.filter((o) => { const dup = seen.find((s) => s.name === o.name && km(s, o) < 0.05); if (!dup) seen.push(o); return !dup; });
  for (const o of kept) if (o.fee.length > 200) o.fee = o.fee.slice(0, 199) + '…';
  const pick = ({ name, lat, lon, addr, moto, moped, fee, hours, capacity, muni, src, srcUrl, license, ccUnknown }) => ({ name, lat: R5(lat), lon: R5(lon), addr, moto, moped, fee, hours, capacity, muni, src, srcUrl, license, ...(ccUnknown ? { ccUnknown } : {}) });
  const all = [...tokyo.map(pick), ...kept.map(pick)];
  const assert = require('assert'); // 出力の形の確認（lib.js の officialMoto が読む形）
  for (const o of all) {
    assert(o.name && o.src && o.srcUrl && o.license && o.muni, 'missing field: ' + JSON.stringify(o));
    assert(o.lat > 20 && o.lat < 46 && o.lon > 122 && o.lon < 154 && R5(o.lat) === o.lat && R5(o.lon) === o.lon, 'bad coord: ' + o.name);
    assert(typeof o.moto === 'boolean' && typeof o.moped === 'boolean' && (o.moto || o.moped), 'no vehicle: ' + o.name);
    assert(!o.ccUnknown || o.moto, 'ccUnknown without moto: ' + o.name);
  }
  assert.deepStrictEqual(all.slice(0, tokyo.length), tokyo); // 東京の分はそのまま
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(all, null, 1));
  // 報告用の集計
  const per = {}; for (const o of all) { const k = `${o.muni}|${o.src}|${o.license}|${o.srcUrl}`; per[k] ??= { n: 0, moto: 0, mopedOnly: 0, ccUnknown: 0 }; per[k].n++; o.moto ? per[k].moto++ : per[k].mopedOnly++; if (o.ccUnknown) per[k].ccUnknown++; }
  const approx = {}; for (const o of kept.filter((o) => o.approx)) approx[o.muni] = (approx[o.muni] || 0) + 1;
  fs.writeFileSync(`${W}/report_jp.json`, JSON.stringify({ per, geocoded: geo, dropped, approxGeocode: approx, reverseAddr: kept.filter((o) => /付近$/.test(o.addr)).length }, null, 1));
  console.log('approx by muni', JSON.stringify(approx));
  console.log('total', all.length, 'tokyo', tokyo.length, 'national', kept.length, 'moto', all.filter((o) => o.moto).length, 'mopedOnly', all.filter((o) => !o.moto).length, 'ccUnknown', all.filter((o) => o.ccUnknown).length);
  console.log('geocoded', geo.length, 'approx(番地なし)', kept.filter((o) => o.approx).length, 'reverse付近', kept.filter((o) => /付近$/.test(o.addr)).length, 'dupRemoved', d.length - dropped.length - kept.length, 'dropped', dropped.length);
  console.log('dropped:', dropped.join(' | '));
})();
