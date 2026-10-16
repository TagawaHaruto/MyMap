// Build Tokyo official motorcycle-parking dataset from fetched raw files.
const fs = require('fs');
const J = f => JSON.parse(fs.readFileSync(f));
const N = s => String(s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const num = s => { const m = N(s).replace(/,/g, '').match(/\d+/); return m ? +m[0] : 0; };
const R5 = x => Math.round(+x * 1e5) / 1e5;
const pk = J('pkgs.json');
const ix = J('index.json');
const xl = (base) => { const f = fs.readdirSync('dl').find(x => x.startsWith(base + '.') && x.endsWith('.json')); const d = J('dl/' + f); return d.slice(1).map(r => Object.fromEntries(d[0].map((k, i) => [N(k), r[i] ?? '']))); };
const LIC = { 'CC-BY-4.0': 'CC BY 4.0' };
const spec = apiId => `https://spec.api.metro.tokyo.lg.jp/spec/${apiId}`;
function src(pkg, resIdx, viaApi = true) {
  const p = pk[pkg], r = p.resources[resIdx], e = ix.find(x => x.pkg === pkg && x.url === r.url);
  return { src: p.title, srcUrl: viaApi && e?.method === 'api' ? spec(e.apiId) : r.url, license: LIC[p.license_id] || p.license_title, muni: p.organization.title };
}
const out = [];
const add = (s, o) => out.push({ name: N(o.name), lat: o.lat === '' || o.lat == null ? null : R5(o.lat), lon: o.lon === '' || o.lon == null ? null : R5(o.lon), addr: N(o.addr), moto: !!o.moto, moped: !!o.moped, fee: N(o.fee), hours: N(o.hours), capacity: o.capacity || null, muni: s.muni, src: s.src, srcUrl: s.srcUrl, license: s.license });
const hrs = (a, b) => (a || b) ? `${N(a)}-${N(b)}`.replace(/^0:00-(0:00|24:00(:00)?)$|^00:00-00:00$/, '24時間') : '';

// 中央区 区営二輪車駐車場 (capacity from 公営駐車場一覧 バイク台数)
{ const s = src('t131024d0000000015', 0); const cap = { 銀座: 30, 京橋: 32, 浜町: 53, 備前橋: 20, 月島: 26 };
  for (const r of J('raw/t131024d0000000015_0.json')) add(s, { name: r['駐車場名'], lat: r['緯度'], lon: r['経度'], addr: '東京都中央区' + r['所在地'], moto: 1, moped: 1, fee: r['駐車料金'], hours: r['利用時間'], capacity: cap[Object.keys(cap).find(k => r['駐車場名'].startsWith(k))] }); }
// 目黒区
{ const s = src('t131105d0000000206', 0);
  for (const r of J('raw/t131105d0000000206_0.json')) {
    const cap = num(r['収容台数_一般原動機付自転車・特定小型原動機付自転車・自動二輪']);
    const fm = N(r['一時利用料_自動二輪']), fp = N(r['一時利用料_一般原動機付自転車']), tp = N(r['定期利用料_地上_一般原動機付自転車']);
    if (!cap && !fm && !fp && !tp) continue;
    add(s, { name: r['名称'], lat: r['緯度'], lon: r['経度'], addr: r['住所'], moto: !!fm, moped: !!(fp || tp) || !fm, capacity: cap,
      fee: [fp && '原付一時 ' + fp, tp && '原付定期 ' + tp, fm && '自動二輪一時 ' + fm].filter(Boolean).join(' / '), hours: hrs(r['開始時間'], r['終了時間']) }); } }
// 町田市 (rows per vehicle type; merge by facility)
{ const s = src('t132098d0000000013', 0); const g = {};
  for (const r of J('raw/t132098d0000000013_0.json')) { const t = N(r['種類']); if (!/バイク/.test(t)) continue;
    const k = r['施設名']; const o = g[k] ||= { name: k, lat: r['緯度'], lon: r['経度'], addr: r['所在地'], moto: 0, moped: 0, capacity: 0, fee: [], hours: r['入退場時間'] };
    const un = t === 'バイク' || t === '自転車・バイク'; // 排気量区分なし → 両方可とみなす
    if (un || /~125|125~|全排気量/.test(t)) o.moto = 1; if (un || /~50|~125|全排気量/.test(t)) o.moped = 1;
    if (t === '自転車・バイク') o.mixed = 1; else o.capacity += num(r['収容台数(台)'] ?? r['収容台数（台）']);
    const f1 = N(r['一時料金（円）']), f2 = N(r['定期料金（円）']); o.fee.push([t, f1 && `一時${f1}円`, f2 && `定期${f2}円`].filter(Boolean).join(' ')); }
  for (const o of Object.values(g)) add(s, { ...o, capacity: o.mixed ? null : o.capacity, fee: o.fee.join(' / ') }); }
// 品川区 区営
{ const s = src('t131091d0000000117', 0);
  for (const r of J('raw/t131091d0000000117_0.json')) { const c = num(r['定期利用バイク']) + num(r['当日利用バイク']); if (!c) continue;
    const m = N(r['名称(所在地)'] ?? r['名称（所在地）']).match(/^(.*?)\((.*)\)$/) || [0, N(r['名称（所在地）']), ''];
    add(s, { name: m[1] + '自転車駐輪場', lat: r['緯度'], lon: r['経度'], addr: m[2] && '東京都品川区' + m[2], moto: 1, moped: 1, capacity: c, fee: '', hours: '' }); } }
// 品川区 民間
{ const s = src('t131091d0000000118', 0);
  for (const r of J('raw/t131091d0000000118_0.json')) { if (N(r['column1']) !== 'バイク') continue; const f = N(r['定期利用一カ月']);
    const spec1 = /原付一種/.test(f), spec2 = /原付二種/.test(f);
    add(s, { name: N(r['名称']) + '(民間バイク駐輪場)', lat: r['緯度'], lon: r['経度'], addr: '東京都品川区' + r['所在地'], moto: spec2 || !spec1, moped: spec1 || !spec2, fee: `定期1カ月 ${f} / 一日 ${N(r['一日利用'])}`, hours: '' }); } }
// 台東区 自転車駐車場 (原付専用)
{ const s = src('t131067d0000000242', 0);
  for (const r of J('raw/t131067d0000000242_0.json')) if (/原動機付自転車/.test(r['名称'])) add(s, { name: r['名称'], lat: r['Y座標'], lon: r['X座標'], addr: '東京都台東区' + r['所在地'], moto: 0, moped: 1 }); }
// 台東区 / 千代田区 / 狛江市 公営駐車場 (バイク区画)
for (const [pkg, fac] of [['t131067d0000000387'], ['t131016d0000000008'], ['t132195d0000000391', 't132195d0000000391_1'], ['t131229d0000000012', 't131229d0000000012_1']]) {
  const s = src(pkg, 0); const facs = fac ? J(`raw/${fac}.json`) : [];
  for (const r of J(`raw/${pkg}_0.json`)) { const t = N(r['公営駐車場_車種']); const c = num(r['公営駐車場_最大駐車台数_バイク']);
    if (!/バイク|二輪|原動機/.test(t.replace('自動二輪除く', ''))) continue; const f = facs.find(x => x['施設_ID'] === r['施設_ID']) || {};
    const moto = /バイク|自動二輪/.test(t), moped = /バイク|原動機/.test(t);
    add(s, { name: r['公営駐車場_名称'], lat: r['公営駐車場_緯度'], lon: r['公営駐車場_経度'], addr: /\d/.test(N(f['住所_連結表記'])) ? f['住所_連結表記'] : /神田花岡町/.test(r['公営駐車場_名称']) ? '東京都千代田区神田花岡町' : '', moto, moped, capacity: c, hours: f['施設_日時備考'] || '' }); } }
// 千代田区 公営駐輪場 (原付)
{ const s = src('t131016d0000000009', 0);
  for (const r of J('raw/t131016d0000000009_0.json')) { const c = [...N(r['公営駐輪場_説明']).matchAll(/原付 (\d+)台/g)].reduce((a, m) => a + +m[1], 0); if (!c) continue;
    add(s, { name: r['公営駐輪場_名称'], lat: r['公営駐輪場_緯度'], lon: r['公営駐輪場_経度'], moto: 0, moped: 1, capacity: c, fee: '年間登録制', hours: '' }); } }
// 杉並区 公営駐輪場 (一覧1 + 施設一覧2 join)
{ const s = src('t131156d0000000211', 0); const fac = J('raw/t131156d0000000211_1.json');
  for (const r of J('raw/t131156d0000000211_0.json')) { const d = N(r['公営駐輪場_説明']);
    const a = num((d.match(/バイク【125ccまで】 ([\d,]+)台/) || [])[1]), b = num((d.match(/バイク【125cc超過】 ([\d,]+)台/) || [])[1]); if (!a && !b) continue;
    const f = fac.find(x => x['施設_ID'] === r['施設_ID']) || {};
    const fee = N(f['施設_料金備考']).split(';').filter(x => /バイク.*(1日使用|1回使用 ?\d|定期使用【一般】1カ月)/.test(x)).join(' / ');
    add(s, { name: r['公営駐輪場_名称'], lat: r['公営駐輪場_緯度'], lon: r['公営駐輪場_経度'], addr: f['住所_連結表記'], moto: 1, moped: !!a, capacity: a + b, fee, hours: N(f['施設_日時備考']).split(';')[0] || hrs(f['施設_開始時刻'], f['施設_終了時刻']) }); } }
// 杉並区 自転車駐車場等一覧 (令和5年8月; 民営バイク駐車場のみ。座標なし→ジオコード)
{ const s = src('t131156d0000000009', 0);
  for (const r of J('raw/t131156d0000000009_0.json')) if (/バイク/.test(N(r['column2']))) add(s, { name: N(r['column2']) + '(民営)', addr: '東京都' + N(r['column4']), moto: 1, moped: 1 }); }
// 中野区
{ const s = src('t131148d0000000155', 0);
  for (const r of J('raw/t131148d0000000155_0.json')) if (N(r['バイク利用']) === '可') add(s, { name: r['名称'], lat: r['緯度'], lon: r['経度'], addr: r['所在地'], moto: 1, moped: 1, fee: r['バイク一時利用料'] && 'バイク一時 ' + r['バイク一時利用料'], hours: r['入出庫可能時間'] }); }
// 標準データセット「公営駐輪場」説明欄パース系
const std = [
  ['t131121d0000000011', 0, d => ({ p: [...d.matchAll(/収容台数_原付_\S+ (\d+)/g)].reduce((a, m) => a + +m[1], 0) })], // 世田谷
  ['t132195d0000000392', 0, d => ({ b: num((d.match(/バイク ?(\d+)台/) || [])[1]) })], // 狛江
  ['t132209d0000000012', 0, d => ({ p: [...d.matchAll(/収容定数\(台\) 原付[^;]*? (\d+)(?=;|$)/g)].reduce((a, m) => a + +m[1], 0) })], // 東大和
  ['t132144d3100000013', 0, d => ({ p: num((d.match(/原動機付自転車 (\d+)台/) || [])[1]) })], // 国分寺
  ['t132039d0000000008', 0, d => ({ p: num((d.match(/原付月極 (\d+)/) || [])[1]) + num((d.match(/原付一時 (\d+)/) || [])[1]) })], // 武蔵野
  ['t132080d3100001971', 0, d => ({ b: num((d.match(/バイク収容台数 (\d+)/) || [])[1]) })], // 調布
];
function parseCSV(t){const rows=[];let row=[],f='',q=false;for(let i=0;i<t.length;i++){const c=t[i];if(q){if(c=='"'){if(t[i+1]=='"'){f+='"';i++}else q=false}else f+=c}else if(c=='"')q=true;else if(c==','){row.push(f);f=''}else if(c=='\n'){row.push(f.replace(/\r$/,''));rows.push(row);row=[];f=''}else f+=c}if(f||row.length){row.push(f);rows.push(row)}return rows.filter(r=>r.some(x=>x.trim()))}
const setaFac = (() => { const r = parseCSV(fs.readFileSync('dl/setagaya_facility.csv', 'utf8')); return r.slice(1).map(x => Object.fromEntries(r[0].map((k, i) => [k, x[i]]))); })();
for (const [pkg, ri, parse] of std) { const s = src(pkg, ri); const facs = pkg === 't131121d0000000011' ? setaFac : pk[pkg].resources.length > 1 ? J(`raw/${pkg}_1.json`) : [];
  for (const r of J(`raw/${pkg}_${ri}.json`)) { const { p = 0, b = 0 } = parse(N(r['公営駐輪場_説明'])); if (!p && !b) continue;
    const f = facs.find(x => x['施設_ID'] === r['施設_ID']) || {};
    add(s, { name: r['公営駐輪場_名称'], lat: r['公営駐輪場_緯度'] || f['住所_緯度'], lon: r['公営駐輪場_経度'] || f['住所_経度'], addr: f['住所_連結表記'], moto: !!b, moped: true, capacity: p + b, fee: N(f['施設_料金備考']).split(';').filter(x => /原付|バイク/.test(x)).join(' / '), hours: f['施設_日時備考'] || hrs(f['施設_開始時刻'], f['施設_終了時刻']) }); } }
// 練馬区
{ const s = src('t131202d0000000133', 0);
  for (const r of J('raw/t131202d0000000133_0.json')) { const c = num((N(r['説明']).match(/原付適正収容数 ?(\d+)/) || [])[1]); if (!c) continue;
    add(s, { name: r['名称'], lat: r['緯度'], lon: r['経度'], addr: r['所在地_連結表記'], moto: 0, moped: 1, capacity: c, fee: [r['料金'], r['料金備考']].map(N).filter(Boolean).join(' '), hours: hrs(r['開始時刻'], r['終了時刻']) }); } }
// 八王子市 (施設一覧: 住所付き)
{ const s = src('t132012d0000000095', 0);
  for (const r of J('raw/t132012d0000000095_0.json')) { const c = num((N(r['施設_説明']).match(/バイク(\d+)台/) || [])[1]); if (!c) continue;
    add(s, { name: r['施設_名称'], lat: r['住所_緯度'], lon: r['住所_経度'], addr: r['住所_連結表記'], moto: 1, moped: 1, capacity: c, fee: r['施設_料金備考'], hours: hrs(r['施設_開始時刻'], r['施設_終了時刻']) }); } }
// 調布市 施設カルテ (オートバイ駐車場; 新4に無いもの)
for (const [pkg, f] of [['t132080d3100000262', '14014_1'], ['t132080d3100000260', '14040_1']]) { const s = src(pkg, 0, false);
  const d = J(`dl/${f}.xlsx.施設カルテ.json`).map(r => r.filter(x => x)); const g = k => (d.find(r => r[0] === k) || [])[1] || '';
  const name = d.find(r => r[0] === '施設ID' || r[0] === '施設ＩＤ')[3]; const sv = N(g('提供サービス'));
  add(s, { name, addr: '東京都調布市' + N(d.find(r => r[0] === '所在地')[1]), moto: 1, moped: /原動機付自転車/.test(sv), capacity: num((sv.match(/収容台数(\d+)台/) || [])[1]), fee: '有料(' + (sv.match(/(月ぎめ及び日ぎめ|月ぎめ)/) || [''])[0] + ')', hours: N(g('開館時間（通常）')) }); }
// 大田区 (xlsx)
{ const s = src('t131113d0000000031', 0, false);
  for (const r of xl('131113_churinjou-o.xlsx')) { const p = num(r['収容台数(原動機付自転車)']), m = num(r['収容台数(自動二輪車)']); if (!p && !m) continue;
    add(s, { name: r['名称'], lat: r['緯度1'], lon: r['経度1'], addr: r['所在地'], moto: !!m, moped: !!p, capacity: p + m, fee: [['一時', r['一時利用部分の有料/無料の別(原付・自動二輪)']], ['定期', r['定期利用部分の有料/無料の別(原付・自動二輪)']]].filter(x => N(x[1])).map(x => x[0] + ':' + N(x[1])).join(' '), hours: r['入出庫可能時間'] }); } }
// 青梅市 (xlsm + 施設xlsx)
{ const s = src('t132055d0000000023', 0, false); const fac = xl('132055_facility_3.xlsx');
  for (const r of xl('132055_bicycle_parking.xlsm')) { let p = 0, m = 0, tot = 0;
    for (const seg of N(r['公営駐輪場_説明']).split(';')) { if (!/原動機付|自動二輪/.test(seg)) continue; const c = [...seg.matchAll(/利用 ?(\d+) ?台/g)].reduce((a, x) => a + +x[1], 0); if (!c) continue;
      tot += c; if (/原動機付/.test(seg)) p = 1; if (/50cc超|125cc超/.test(seg)) m = 1; }
    if (!tot) continue; const f = fac.find(x => x['施設_ID'] === r['施設_ID']) || {};
    const fee = N(f['施設_料金備考']).split(';').filter(x => /(原動機付|自動二輪).*\d/.test(x) && !/不可$/.test(x)).map(x => x.replace(/^料金_/, '')).join(' / ');
    add(s, { name: '青梅市 ' + r['公営駐輪場_名称'] + '駐輪場', lat: f['住所_緯度'], lon: f['住所_経度'], addr: f['住所_連結表記'], moto: m > 0, moped: p > 0, capacity: tot, fee }); } }
// 荒川区 (zip csv)
{ const s = src('t131181d0000000008', 0, false); const t = fs.readFileSync('dl/131181_bicycle_parking/131181_bicycle_parking/131181_bicycle_parking.csv', 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/).map(l => l.split(','));
  for (const r of t.slice(1)) if (/原付/.test(r[6])) add(s, { name: r[3], lat: r[7], lon: r[8], moto: 0, moped: 1, fee: '', hours: '' }); }
// 立川市 (種別=バイク; 座標なし→ジオコード)
{ const s = src('t132021d0000000023', 0);
  for (const r of J('raw/t132021d0000000023_0.json')) if (r['種別'] === 'バイク' && N(r['所在地'])) add(s, { name: N(r['名称']).replace(/有料$/, '有料自転車等駐車場').replace(/自転車等$/, '自転車等駐車場'), addr: '東京都立川市' + r['所在地'], moto: 1, moped: 1, capacity: num(r['収容台数(台)']) }); }

fs.writeFileSync('stage1.json', JSON.stringify(out, null, 1));
console.log('records', out.length, 'noLatLon', out.filter(o => o.lat == null).length, 'noAddr', out.filter(o => !o.addr).length);
