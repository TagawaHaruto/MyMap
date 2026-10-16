const fs = require('fs');
const d = JSON.parse(fs.readFileSync('stage1.json'));
const cache = fs.existsSync('geocache.json') ? JSON.parse(fs.readFileSync('geocache.json')) : {};
const R5 = x => Math.round(+x * 1e5) / 1e5;
const get = async u => (await fetch(u)).json();
(async () => {
  for (const o of d) {
    if (o.lat == null && o.addr) {
      const k = 'f:' + o.addr; cache[k] ??= await get('https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent(o.addr.replace(/先$|\(.*\)$/, '')));
      const h = cache[k][0]; if (h) { o.lon = R5(h.geometry.coordinates[0]); o.lat = R5(h.geometry.coordinates[1]); o.geocoded = h.properties.title; }
    }
    if (o.lat != null && !o.addr) {
      const k = `r:${o.lat},${o.lon}`; cache[k] ??= await get(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${o.lat}&lon=${o.lon}`);
      const lv = cache[k]?.results?.lv01Nm; if (lv && lv !== '－') { o.addr = `東京都${o.muni}${lv}付近`; o.addrApprox = true; }
    }
  }
  fs.writeFileSync('geocache.json', JSON.stringify(cache));
  const dropped = d.filter(o => o.lat == null || !(o.lat > 35.4 && o.lat < 35.95 && o.lon > 138.9 && o.lon < 140));
  let kept = d.filter(o => !dropped.includes(o));
  // dedupe: same name within 50 m
  const seen = []; kept = kept.filter(o => { const dup = seen.find(s => s.name === o.name && Math.hypot(s.lat - o.lat, s.lon - o.lon) < 0.0005); if (!dup) seen.push(o); return !dup; });
  for (const o of kept) { if (o.fee.length > 200) o.fee = o.fee.slice(0, 199) + '…'; }
  const outRec = kept.map(({ name, lat, lon, addr, moto, moped, fee, hours, capacity, muni, src, srcUrl, license }) => ({ name, lat, lon, addr, moto, moped, fee, hours, capacity, muni, src, srcUrl, license }));
  fs.writeFileSync('C:/Users/B3469/AppData/Local/Temp/mm_moto_tokyo.json', JSON.stringify(outRec, null, 1));
  console.log('kept', outRec.length, 'moto', outRec.filter(o => o.moto).length, 'mopedOnly', outRec.filter(o => !o.moto).length);
  console.log('dropped', dropped.map(o => o.muni + ':' + o.name + ':' + o.addr).join(' | '));
  console.log('geocoded', kept.filter(o => o.geocoded).map(o => o.name + ' <- ' + o.addr + ' => ' + o.geocoded + ' ' + o.lat + ',' + o.lon).join('\n'));
  console.log('approxAddr', kept.filter(o => o.addrApprox).length);
  const c = {}; for (const o of outRec) { c[o.muni] ??= [0, 0]; c[o.muni][0]++; o.moto && c[o.muni][1]++; } console.log(JSON.stringify(c));
  const cs = {}; for (const o of outRec) { const k = o.muni + '|' + o.src; cs[k] = (cs[k] || 0) + 1 } console.log(JSON.stringify(cs));
})();
