// 全国版 3/4: 取得した表から「バイク（自動二輪か原付）を止められる行」だけを取り出して共通の形にする。
// usage: node jp_build.js <workdir>      （先に jp_fetch.js）
// 出力: <workdir>/stage_jp.json（座標がない行は lat=null。jp_finalize.js でジオコーディング）
// 判定ルールは NOTES.md「全国版」の節。推測で台数・可否を作らない:
//   moto  = 自動二輪（50cc超）可、moped = 原付（50cc以下）可
//   「バイク」「二輪車」だけで排気量区分がない → moto/moped とも true + ccUnknown（NOTES.md の東京版の規則）
//   自動二輪が「125cc以下」「原付二種」「小型」に限られる → moto true + ccUnknown（大型は止められないので現地で確認）
//   「自動二輪」「普通自動二輪」「大型」「125cc超」が明記 → moto true（ccUnknown なし）
//   台数は二輪・原付の台数が分かるときだけ（自転車と合算の総数しかないときは null）
const fs = require('fs');
const W = process.argv[2] || '.';
const idx = JSON.parse(fs.readFileSync(`${W}/index.json`));
const N = (s) => String(s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const num = (s) => { const m = N(s).replace(/,/g, '').match(/\d+/); return m ? +m[0] : 0; };
const sumN = (s, re) => [...N(s).replace(/,/g, '').matchAll(re)].reduce((a, m) => a + +m[1], 0);
const LIC = (s) => {
  const t = N(s);
  if (/^(pdl|Public Data License 1\.0)$/i.test(t)) return '公共データ利用規約 第1.0版 (PDL1.0)';
  if (/2\.1|cc-by-21/i.test(t)) return 'CC BY 2.1 JP';
  if (/2\.0/.test(t)) return 'CC BY 2.0';
  if (/4[._]?0|4\.0/.test(t)) return 'CC BY 4.0';
  if (/^(cc-by|CC BY|CC-BY|Creative Commons Attribution|クリエイティブ・コモンズ 表示)$/i.test(t)) return 'CC BY';
  return '';
};
// 表を {h: 見出し, rows: 行の配列, c(r, 見出しの正規表現)} で返す。hr = 見出し行の位置
function T(id, hr = 0, sheet) {
  const s = idx.find((x) => x.id === id); if (!s || !s.tab) throw new Error('no table ' + id);
  const t = JSON.parse(fs.readFileSync(s.tab)); const rows = sheet ? t[sheet] : Object.values(t)[0];
  const h = rows[hr].map(N);
  const col = (re) => { const i = h.findIndex((x) => re.test(x)); if (i < 0) throw new Error(`${id}: no column ${re}`); return i; };
  return { s, h, rows: rows.slice(hr + 1), c: (r, re) => N(r[col(re)]), col };
}
// 住所の頭に都道府県（と市）を補う。pref は「神奈川県平塚市」のように市まで書くと、市を省いた住所に付ける
function fullAddr(pref, a) {
  a = N(a); if (!a) return '';
  const P = (pref.match(/^(北海道|東京都|京都府|大阪府|.{2,3}?県)/) || [''])[0], C = pref.slice(P.length);
  if (a.startsWith(P)) return a;
  if (C && a.startsWith(C)) return P + a;
  if (!C && /^[^0-9]{1,8}?[市郡]/.test(a)) return P + a;
  return pref + a;
}
{ const assert = require('assert'); // fullAddr の確認
  assert.strictEqual(fullAddr('神奈川県平塚市', '錦町5'), '神奈川県平塚市錦町5');
  assert.strictEqual(fullAddr('広島県', '広島市中区基町'), '広島県広島市中区基町');
  assert.strictEqual(fullAddr('千葉県君津市', '君津市東坂田一丁目1番4'), '千葉県君津市東坂田一丁目1番4');
  assert.strictEqual(fullAddr('大阪府', '大阪府茨木市永代町2番19号'), '大阪府茨木市永代町2番19号'); }
const out = []; const used = [];
// meta: {id, muni, src?, srcUrl?, license?, pref}
function add(m, o) {
  const s = idx.find((x) => x.id === m.id);
  let lat = N(o.lat) === '' ? null : +N(o.lat), lon = N(o.lon) === '' ? null : +N(o.lon);
  if (lat != null && lat > 100 && lon < 50) [lat, lon] = [lon, lat]; // 緯度・経度の列が逆のデータ
  const dec = (v) => (N(v).split('.')[1] || '').length;
  if (!(lat > 20 && lat < 46 && lon > 122 && lon < 154) || (dec(o.lat) <= 2 && dec(o.lon) <= 2)) lat = lon = null; // 範囲外・小数2桁以下（1km 程度ずれる）は使わず住所から
  const addr = fullAddr(m.pref || '', o.addr);
  const lic = m.license || LIC(s.license);
  if (!lic) throw new Error('license unknown: ' + m.id);
  out.push({ name: N(o.name), lat: lat == null ? null : Math.round(lat * 1e5) / 1e5, lon: lon == null ? null : Math.round(lon * 1e5) / 1e5, addr,
    moto: !!o.moto, moped: !!o.moped, ...(o.moto && o.ccUnknown ? { ccUnknown: true } : {}), fee: N(o.fee), hours: N(o.hours), capacity: o.capacity || null,
    muni: m.muni, src: m.src || N(s.title).replace(/^【[^】]*】/, ''), srcUrl: m.srcUrl || s.page, license: lic });
  if (!used.includes(m.id)) used.push(m.id);
}
const run = (id, fn) => { try { fn(); } catch (e) { console.error('SKIP', id, e.message); } };

// ---------- 関東 ----------
run('web__0', () => { // 平塚市: バイク定期/一時の括弧に排気量
  const t = T('web__0'); const m = { id: 'web__0', muni: '平塚市', pref: '神奈川県平塚市' };
  for (const r of t.rows) {
    const f = [t.c(r, /バイク定期/), t.c(r, /バイク一時/)].filter((x) => x && x !== '-'), cap = num(t.c(r, /バイク収容/));
    if (!f.length && !cap) continue; const tx = f.join(' ');
    const m50 = /50cc以下/.test(tx), m125 = /125cc以下/.test(tx);
    add(m, { name: t.c(r, /名称/) + '駐輪場', addr: t.c(r, /所在地/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moped: true, moto: !m50 || m125, ccUnknown: true, capacity: cap,
      fee: f.map((x, i) => (i ? '' : '') + x).join(' / '), hours: t.c(r, /営業時間/) });
  }
});
run('web__1', () => { // つくば市: 見出し2段。9/10 = 駐車可能な車両(定期/一時), 11-16 料金, 17-22 供用台数（定期: 自転車,原付,自二 / 一時: 同）
  const t = T('web__1', 1); const m = { id: 'web__1', muni: 'つくば市', pref: '茨城県' }; let nm = '', ad = '';
  for (const r of t.rows.slice(1)) {
    const R = r.map(N); if (R[2]) nm = R[2]; if (R[4]) ad = R[4]; if (!nm) continue;
    const veh = R[9] + ' ' + R[10]; const p = num(R[18]) + num(R[21]), b = num(R[19]) + num(R[22]);
    const moped = /原付/.test(veh), moto = /自動二輪/.test(veh); if (!moped && !moto) continue;
    add(m, { name: nm + (R[3] ? ' ' + R[3] : ''), addr: ad, moped, moto, ccUnknown: moto && !/大型|400cc/.test(veh), capacity: p + b,
      fee: [R[12] !== '-' && R[12] && '原付定期 ' + R[12], R[13] !== '-' && R[13] && '自動二輪定期 ' + R[13], R[15] !== '-' && R[15] && '原付一時 ' + R[15], R[16] !== '-' && R[16] && '自動二輪一時 ' + R[16]].filter(Boolean).join(' / '),
      hours: R[6] && '平日 ' + R[6] });
  }
});
run('web__2', () => { const t = T('web__2'); const m = { id: 'web__2', muni: '海老名市', pref: '神奈川県' }; // 名称に「原動機付自転車駐車場」
  for (const r of t.rows) if (/原動機付自転車/.test(t.c(r, /^名称$/))) add(m, { name: t.c(r, /^名称$/), addr: t.c(r, /住所/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moped: true }); });
run('sagamihara__rosei__0', () => { const t = T('sagamihara__rosei__0'); // CKAN にライセンス表示なし。市オープンデータサイトの規約が CC BY 4.0
  const m = { id: 'sagamihara__rosei__0', muni: '相模原市', pref: '神奈川県', license: 'CC BY 4.0' };
  for (const r of t.rows) if (/バイク/.test(t.c(r, /施設名/))) add(m, { name: t.c(r, /施設名/), addr: t.c(r, /住所/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moto: true, moped: true, ccUnknown: true }); });
run('chiba__2576__0', () => { // 船橋市: 1 行 = 施設×区分（自転車/原付/原付2種）。施設ごとにまとめる。座標なし
  const t = T('chiba__2576__0'); const m = { id: 'chiba__2576__0', muni: '船橋市', pref: '千葉県' }; const g = {};
  for (const r of t.rows) { const k = t.c(r, /区分/); if (!/原付/.test(k)) continue; const o = g[t.c(r, /名称/)] ||= { name: t.c(r, /名称/), addr: t.c(r, /位置/).replace(/,/g, ''), moped: false, moto: false, capacity: 0, fee: [] };
    if (k === '原付') o.moped = true; if (k === '原付2種') { o.moto = true; o.ccUnknown = true; } o.capacity += num(t.c(r, /収容台数/)); o.fee.push(`${k} ${num(t.c(r, /収容台数/))}台`); }
  for (const o of Object.values(g)) add(m, { ...o, fee: '', hours: '' });
});
run('chiba__3366__0', () => { // 柏市: 説明「◆定期利用(自・原・自二) ◆一時利用(…)」
  const t = T('chiba__3366__0'); const m = { id: 'chiba__3366__0', muni: '柏市', pref: '千葉県' };
  for (const r of t.rows) { const d = t.c(r, /説明/); const moped = /原/.test(d), moto = /自二/.test(d); if (!moped && !moto) continue;
    add(m, { name: t.c(r, /名称/), addr: t.c(r, /住所/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moped, moto, fee: d.replace(/自二/g, '自動二輪').replace(/原/g, '原付').replace(/自(?![動転])/g, '自転車') }); } });
run('chiba__3432__0', () => { // 流山市: 原動機付自転車 = 原付の年間定期料金、一時利用(バイク)=可/不可（排気量区分なし）
  const t = T('chiba__3432__0'); const m = { id: 'chiba__3432__0', muni: '流山市', pref: '千葉県' };
  for (const r of t.rows) { const p = t.c(r, /原動機付自転車/), b = t.c(r, /一時利用\(バイク\)/); const moped = /\d/.test(p), bike = b === '可'; if (!moped && !bike) continue;
    add(m, { name: t.c(r, /^名称$/), addr: t.c(r, /所在地/), lat: t.c(r, /^y$/), lon: t.c(r, /^x$/), moped: true, moto: bike, ccUnknown: true, fee: [moped && `原付 年間定期 ${p}円`, bike && 'バイク一時利用 可'].filter(Boolean).join(' / ') }); } });
run('chiba__3653__0', () => { const t = T('chiba__3653__0'); const m = { id: 'chiba__3653__0', muni: '我孫子市', pref: '千葉県' };
  for (const r of t.rows) if (/原動機付自転車/.test(t.c(r, /^名称$/))) add(m, { name: t.c(r, /^名称$/), addr: t.c(r, /住所/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moped: true, hours: t.c(r, /特記/) }); });
run('chiba__3678__0', () => { // 君津市: 種類「自転車・原付(125cc以下…)併用」、台数(原付)
  const t = T('chiba__3678__0'); const m = { id: 'chiba__3678__0', muni: '君津市', pref: '千葉県君津市' };
  for (const r of t.rows) { const k = t.c(r, /種類/); if (!/原付/.test(k)) continue;
    add(m, { name: t.c(r, /駐車場名/), addr: t.c(r, /所在地/).replace(/ほか$/, ''), moped: true, moto: /125cc/.test(k), ccUnknown: true, capacity: num(t.c(r, /台数 ?\(原付\)/)), fee: t.c(r, /料金/) }); } });
run('gspatial__122033-051__2', () => { // 市川市（2018年。G空間情報センターに収録）: 利用種別「○自転車、○原付」
  const id = 'gspatial__122033-051__2', t = T(id); const m = { id, muni: '市川市', pref: '千葉県市川市' };
  for (const r of t.rows) { const k = t.c(r, /利用種別/); if (!/○原付/.test(k)) continue;
    const fee = [t.c(r, /利用料$/), t.c(r, /^料金$/)].filter(Boolean).join(' '); // 料金欄に「普通自動二輪(125cc以下)も駐輪できます」とある所は自動二輪も
    add(m, { name: t.c(r, /^施設名称$/), addr: t.c(r, /住所/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moped: true, moto: /自動二輪/.test(fee), ccUnknown: /125cc以下/.test(fee), fee }); } });
run('bodik__142018_wagamap_lid_20__0', () => { // 横須賀市（よこすかわが街ガイド）: 備考4 の料金に「バイク」（排気量区分なし）
  const id = 'bodik__142018_wagamap_lid_20__0', t = T(id); const m = { id, muni: '横須賀市', pref: '神奈川県', srcUrl: 'https://data.bodik.jp/dataset/142018_wagamap_lid_20' };
  for (const r of t.rows) { const f = r.map(N).slice(6, 11).join(' '); if (!/バイク/.test(f)) continue;
    add(m, { name: t.c(r, /^名称$/), addr: t.c(r, /住所/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moto: true, moped: true, ccUnknown: true, fee: (f.match(/料金:[^。]*/) || [''])[0], hours: (f.match(/営業時間[^ ]*/) || [''])[0] }); } });
run('saitama__1163__0', () => { // 川越市（令和7年3月31日現在）: 説明「原動機付自転車(50cc以下)も可」、最大駐輪台数「…原付N台」
  const t = T('saitama__1163__0'); const m = { id: 'saitama__1163__0', muni: '川越市', pref: '埼玉県' };
  for (const r of t.rows) { const d = t.c(r, /説明/), c = t.c(r, /最大駐輪台数/); if (!/原動機付|原付/.test(d + c)) continue;
    add(m, { name: t.c(r, /_名称$/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moped: true, capacity: sumN(c, /原付:?(\d+)台/g) }); } });
run('saitama__2082__0', () => { // 越谷市: 最大駐輪台数「自転車:N台_バイク小:N台_バイク中:N台_バイク大:N台」（小・中・大の排気量の定義は書かれていない）
  const t = T('saitama__2082__0'); const m = { id: 'saitama__2082__0', muni: '越谷市', pref: '埼玉県' };
  for (const r of t.rows) { const c = t.c(r, /最大駐輪台数/); if (!/バイク/.test(c)) continue;
    add(m, { name: t.c(r, /_名称$/) + '自転車駐車場', lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moto: true, moped: true, ccUnknown: !/バイク大/.test(c), capacity: sumN(c, /バイク[^:_]*:[^_\d]*(\d+)台/g),
      fee: t.c(r, /説明/).split('_').filter((x) => /バイク/.test(x)).join(' / ') }); } });
run('saitama__2081__0', () => stdCarPark('saitama__2081__0', { muni: '越谷市', pref: '埼玉県' }));

// ---------- 東北・北海道 ----------
run('sapporo__sapporo_bicycle_parking_space__0', () => { // 札幌市（2018年9月）: 原動機付自転車の駐車可否「50cc以下は可/125cc以下は可/不可」。座標なし
  const t = T('sapporo__sapporo_bicycle_parking_space__0'); const m = { id: 'sapporo__sapporo_bicycle_parking_space__0', muni: '札幌市', pref: '北海道' };
  for (const r of t.rows) { const k = t.c(r, /可否/); if (!/可$/.test(k) || /不可/.test(k)) continue;
    add(m, { name: t.c(r, /駐輪場名/), addr: t.c(r, /住所/), moped: true, moto: /125cc/.test(k), ccUnknown: true, fee: '原付 ' + k }); } });
run('web__8', () => { // 仙台市: コメント「利用可能車両:自転車・バイク」（排気量区分なし）
  const t = T('web__8'); const m = { id: 'web__8', muni: '仙台市', pref: '宮城県' };
  for (const r of t.rows) { const d = t.c(r, /コメント/).replace(/&lt;br&gt;|<br>/g, '\n'); const v = (d.match(/利用可能車両:([^\n]*)/) || [])[1] || ''; if (!/バイク/.test(v)) continue;
    add(m, { name: t.c(r, /名称/), addr: t.c(r, /住所/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moto: true, moped: true, ccUnknown: true, hours: (d.match(/開設時間:([^\n]*)/) || [])[1], fee: (d.match(/利用料金:([^\n]*)/) || [])[1] }); } });
run('web__9', () => { const t = T('web__9'); const m = { id: 'web__9', muni: '山形市', pref: '山形県' }; // バイク収容台数（排気量区分なし）
  for (const r of t.rows) { const b = num(t.c(r, /バイク収容/)); if (!b) continue;
    add(m, { name: t.c(r, /^名称$/), addr: t.c(r, /住所/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moto: true, moped: true, ccUnknown: true, capacity: b, fee: [t.c(r, /料金1/), t.c(r, /料金2/)].filter((x) => /バイク/.test(x)).join(' '), hours: `${t.c(r, /開始時間/)}-${t.c(r, /終了時間/)}` }); } });
run('miyagi__1315__0', () => { const t = T('miyagi__1315__0'); const m = { id: 'miyagi__1315__0', muni: '柴田町', pref: '宮城県' }; // 備考「自転車N台 バイクN台」
  for (const r of t.rows) { const b = sumN(t.c(r, /^備考$/), /バイク(\d+)台/g); if (!b) continue;
    add(m, { name: t.c(r, /^名称$/), addr: t.c(r, /連結表記/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moto: true, moped: true, ccUnknown: true, capacity: b, hours: t.c(r, /日時備考/) }); } });

// ---------- 中部 ----------
run('web__4', () => { // 浜松市営バイク駐車場: ○/×
  const t = T('web__4'); const m = { id: 'web__4', muni: '浜松市', pref: '静岡県' };
  for (const r of t.rows) { const a = t.c(r, /\(~50cc\)/) === '○', b = t.c(r, /51cc~125cc/) === '○', c = t.c(r, /126cc~/) === '○'; if (!a && !b && !c) continue;
    add(m, { name: t.c(r, /名称/), addr: t.c(r, /所在地/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moped: a, moto: b || c, ccUnknown: !c, capacity: num(t.c(r, /収容可能台数/)), fee: t.c(r, /料金/), hours: t.c(r, /利用可能時間/) }); } });
run('web__5', () => { const t = T('web__5'); const m = { id: 'web__5', muni: '新潟市', pref: '新潟県新潟市' }; // 対象車種「自転車・原付」
  for (const r of t.rows) if (/原付/.test(t.c(r, /SAFIELD003/))) add(m, { name: t.c(r, /SAFIELD001/), addr: t.c(r, /SAFIELD002/), lat: t.c(r, /latitude/), lon: t.c(r, /longitude/), moped: true, hours: t.c(r, /SAFIELD004/), fee: t.c(r, /SAFIELD005/) }); });
run('web__6', () => { const t = T('web__6'); const m = { id: 'web__6', muni: '豊橋市', pref: '愛知県' }; // 駐車可能台数「原付N台」「自動二輪車N台」
  for (const r of t.rows) { const d = t.c(r, /駐車可能台数/); const p = sumN(d, /原付(\d+)台/g), b = sumN(d, /自動二輪車?(\d+)台/g); if (!p && !b) continue;
    add(m, { name: t.c(r, /駐輪場名/), addr: t.c(r, /所在地/), lat: t.c(r, /10進_Y/), lon: t.c(r, /10進_X/), moped: !!p, moto: !!b, capacity: p + b, fee: t.c(r, /料金/), hours: t.c(r, /業務時間/) }); } });
run('ishikawa__172014_bicycle_parking__0', () => { // 金沢市: 備考「駐輪可能台数(自転車N台、原付N台、バイク可(125cc以下))」
  const t = T('ishikawa__172014_bicycle_parking__0'); const m = { id: 'ishikawa__172014_bicycle_parking__0', muni: '金沢市', pref: '石川県' };
  for (const r of t.rows) { const d = t.c(r, /^備考$/); const p = sumN(d, /原付(\d+)台/g), bike = /バイク可/.test(d); if (!p && !bike && !/原付/.test(d)) continue;
    add(m, { name: t.c(r, /^名称$/), addr: t.c(r, /連結表記/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moped: true, moto: bike, ccUnknown: true, capacity: p || null, fee: [t.c(r, /料金種別/), t.c(r, /料金備考/)].filter(Boolean).join(' '), hours: `${t.c(r, /開始時刻/)}-${t.c(r, /終了時刻/)}` }); } });

// ---------- 近畿 ----------
run('web__3', () => { // 大阪市（マップナビおおさか）: 分類 = バイク駐車場(時間貸/月極), 駅周辺駐輪場(原動機付自転車)。民間施設を含む
  const t = T('web__3'); const m = { id: 'web__3', muni: '大阪市', pref: '大阪府大阪市' };
  for (const r of [...t.rows].sort((a, b) => /月極/.test(N(a[4])) - /月極/.test(N(b[4])))) {
    const k = N(r[4]) || N(r[14]); if (!/バイク駐車場|原動機付自転車/.test(k)) continue;
    const d = N(r[10]); const g = (key) => (d.match(new RegExp('【' + key + '】([^【]*)')) || [])[1] || '';
    const lim = g('車両制限'), cap = g('収容台数');
    const mopedOnly = /原動機付自転車/.test(k), motoOnly = /自動二輪に限る|50cc以上|50cc超(?!.*50cc以下)/.test(lim) && !/原付|50cc以下|50cc未満/.test(lim + cap);
    const big = /大型(?!不可)|自動二輪|50cc超|50cc以上|125cc超/.test(lim + cap) && !/大型不可|125cc以下/.test(lim + cap);
    add(m, { name: N(r[0]), addr: N(r[1]), lat: N(r[13]), lon: N(r[12]), moped: !motoOnly, moto: !mopedOnly, ccUnknown: !big, capacity: sumN(cap, /(\d+)台/g),
      fee: [/月極/.test(k) && '月極', g('料金')].filter(Boolean).join(' '), hours: g('営業時間') });
  } });
run('bodik__271403_sakai_churinzyo__0', () => { const t = T('bodik__271403_sakai_churinzyo__0'); const m = { id: 'bodik__271403_sakai_churinzyo__0', muni: '堺市', pref: '大阪府堺市' };
  for (const r of t.rows) if (t.c(r, /原動機付自転車の利用可否/) === '可') add(m, { name: '堺市 ' + t.c(r, /駐車場名/) + '自転車駐車場', addr: t.c(r, /所在地/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moped: true, hours: t.c(r, /利用時間/), fee: t.c(r, /料金/) + (t.c(r, /一時使用/) === '否' ? '（一時使用不可）' : '') }); });
run('bodik__272116_p_42665_42665__0', () => { // 茨木市 原付・自動二輪駐車場: 料金1(原付), 料金2(自動二輪)。座標なし
  const t = T('bodik__272116_p_42665_42665__0'); const m = { id: 'bodik__272116_p_42665_42665__0', muni: '茨木市', pref: '大阪府' };
  for (const r of t.rows) { const a = t.c(r, /料金1/), b = t.c(r, /料金2/), c = t.c(r, /定期料金\(原付\)/), d = t.c(r, /定期料金\(自動二輪/); const moped = !!(a || c), moto = !!(b || d); if (!moped && !moto) continue;
    add(m, { name: '茨木市 ' + t.c(r, /駐車場名/) + ' 原付・自動二輪駐車場', addr: t.c(r, /住所/), moped, moto, fee: [a && '原付 ' + a, b && '自動二輪 ' + b, c && '原付定期 ' + c, d && '自動二輪定期 ' + d].filter(Boolean).join(' / '), hours: t.c(r, /営業時間/) }); } });
run('bodik__272078_tyurinjyo__0', () => { // 高槻市: 利用料金 一時/定期 (原付)(自動二輪)。自動二輪(小型)=125cc以下
  const t = T('bodik__272078_tyurinjyo__0'); const m = { id: 'bodik__272078_tyurinjyo__0', muni: '高槻市', pref: '大阪府' };
  for (const r of t.rows) { const p = [t.c(r, /一時\(原付\)/), t.c(r, /定期\(原付\)/)].filter(Boolean), b = [t.c(r, /一時\(自動二輪\)/), t.c(r, /定期\(自動二輪\)/)].filter(Boolean); if (!p.length && !b.length) continue;
    add(m, { name: t.c(r, /名称/), addr: t.c(r, /住所/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moped: !!p.length, moto: !!b.length, ccUnknown: !/中型|大型/.test(b.join()), fee: [...p.map((x) => '原付 ' + x), ...b].join(' / '), hours: t.c(r, /利用時間/) }); } });
run('bodik__272159_shieityurinjyo__0', () => { // 寝屋川市: 金額に「原付:…」「自動二輪:…」
  const t = T('bodik__272159_shieityurinjyo__0'); const m = { id: 'bodik__272159_shieityurinjyo__0', muni: '寝屋川市', pref: '大阪府' };
  for (const r of t.rows) { const f = t.c(r, /金額/); const moped = /原付:/.test(f), moto = /自動二輪車?:/.test(f); if (!moped && !moto) continue;
    add(m, { name: t.c(r, /^名称$/), addr: t.c(r, /住所/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moped, moto, fee: f.split(/、(?=自転車|原付|自動二輪)/).filter((x) => /原付|自動二輪/.test(x)).join(' / '), hours: t.c(r, /特記/) || `${t.c(r, /開始時間/)}-${t.c(r, /終了時間/)}` }); } });
run('bodik__272159_koueicyuusyajyou__0', () => stdCarPark('bodik__272159_koueicyuusyajyou__0', { muni: '寝屋川市', pref: '大阪府' }));
run('bodik__272248_bicycle_parking__0', () => { const t = T('bodik__272248_bicycle_parking__0'); const m = { id: 'bodik__272248_bicycle_parking__0', muni: '摂津市', pref: '大阪府' };
  for (const r of t.rows) if (/原動機付自転車含む/.test(t.c(r, /^説明$/))) add(m, { name: t.c(r, /^名称$/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moped: true }); });
run('bodik__252034_cityparking_bike__0', () => carType('bodik__252034_cityparking_bike__0', '長浜市'));
run('bodik__252034_cityparking__0', () => carType('bodik__252034_cityparking__0', '長浜市'));
function carType(id, muni) { // 長浜市: 駐車可能車種（原動機付自転車 / 普通自動二輪車(125cc以下) / 大型自動二輪車）
  const t = T(id); const m = { id, muni, pref: '滋賀県' };
  for (const r of t.rows) { const k = t.c(r, /車種/); const moped = /原動機付/.test(k), moto = /自動二輪/.test(k); if (!moped && !moto) continue;
    add(m, { name: t.c(r, /名称/), addr: t.c(r, /所在地/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moped, moto, ccUnknown: moto && /125cc以下/.test(k) && !/大型/.test(k), fee: '駐車可能車種: ' + k }); }
}
run('himeji__tyurin__0', () => { // 姫路市 公設駐輪場: 利用料金に「原付」「バイク(小)(中)(大)」「バイク」
  const t = T('himeji__tyurin__0'); const m = { id: 'himeji__tyurin__0', muni: '姫路市', pref: '兵庫県姫路市' };
  for (const r of t.rows) { const f = t.c(r, /利用料金/); const moped = /原付/.test(f), bike = /バイク/.test(f); if (!moped && !bike) continue;
    add(m, { name: t.c(r, /^駐輪場$/) + (t.c(r, /種別/) === '民営' ? '(民営)' : ''), addr: '', lat: t.c(r, /y座標/), lon: t.c(r, /x座標/), moped: true, moto: bike, /* 場所 は駅名なので住所にしない */ ccUnknown: !/バイク\(大\)/.test(f), fee: f, hours: t.c(r, /営業時間/) }); } });
run('himeji__tyusyajo__1', () => { // 姫路市 公営駐車場: 大手前公園地下駐車場（大型バイク 48台。125cc以下・原付は不可と備考に明記）
  const t = T('himeji__tyusyajo__1'); const m = { id: 'himeji__tyusyajo__1', muni: '姫路市', pref: '兵庫県' };
  for (const r of t.rows) { const c = t.c(r, /収容台数/), b = t.c(r, /備考/); if (!/バイク/.test(c + t.c(r, /^駐車場$/))) continue;
    const noSmall = /125cc以下のものを除く/.test(b);
    add(m, { name: t.c(r, /^駐車場$/).replace(/\(.*\)$/, ''), addr: t.c(r, /場所/), lat: t.c(r, /y座標/), lon: t.c(r, /x座標/), moto: true, moped: !noSmall, ccUnknown: !noSmall && !/大型/.test(c), capacity: sumN(c, /バイク ?(\d+)台/g), fee: (t.c(r, /利用料金/).match(/バイク:[^ ]*( \S+)?/) || [''])[0], hours: t.c(r, /営業時間/) }); } });

// ---------- 中国・四国 ----------
run('web__7', () => { // 広島市（ひろしま地図ナビ）: 備考「◇一時利用:原付、自動二輪 ◇登録利用:自転車、原付、自動二輪」
  const t = T('web__7'); const m = { id: 'web__7', muni: '広島市', pref: '広島県' };
  for (const r of t.rows) { const d = t.c(r, /備考/); const u = (d.match(/◇(一時|登録)利用:[^◇]*/g) || []).join(' '); const moped = /原付/.test(u), moto = /自動二輪/.test(u); if (!moped && !moto) continue;
    add(m, { name: t.c(r, /^名称$/) + (/駐輪|駐車/.test(t.c(r, /^名称$/)) ? '' : (t.c(r, /分類/) === '市営駐車場' ? '駐車場' : '駐輪場')), addr: t.c(r, /所在地/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moped, moto, fee: u, hours: (d.match(/◇営業時間[^:]*:([^◇]*)/) || [])[1] }); } });
run('hiroshima__6199__0', () => { // 益田市 公営駐輪場（XLS）: 料金備考「原動機付自転車(バイク)/1日:200円…」
  const id = 'hiroshima__6199__0', t = T(id); const m = { id, muni: '益田市', pref: '島根県' };
  for (const r of t.rows) { const f = t.c(r, /料金備考/); if (!/原動機付/.test(f)) continue;
    add(m, { name: t.c(r, /^名称$/), addr: t.c(r, /連結表記/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moped: true, fee: f, hours: `${t.c(r, /開始時刻/)}-${t.c(r, /終了時刻/)}` }); } });
run('web__10', () => { const t = T('web__10'); const m = { id: 'web__10', muni: '鳥取市', pref: '鳥取県' }; // maxBikes「収容台数:自転車N台、原付N台」
  for (const r of t.rows) { const p = sumN(t.c(r, /maxBikes/), /原付(\d+)台/g); if (!p) continue; add(m, { name: t.c(r, /^name$/), lat: t.c(r, /latitude/), lon: t.c(r, /longitude/), moped: true, capacity: p }); } });
run('yamaguchi__352080-bicycle_parking__0', () => { const id = 'yamaguchi__352080-bicycle_parking__0', t = T(id); const m = { id, muni: '岩国市', pref: '山口県' };
  for (const r of t.rows) if (/原動機付自転車/.test(t.c(r, /_名称$/))) add(m, { name: t.c(r, /_名称$/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moped: true, capacity: num(t.c(r, /最大駐輪台数/)) }); });
run('yamaguchi__352080-car_park__0', () => stdCarPark('yamaguchi__352080-car_park__0', { muni: '岩国市', pref: '山口県' }));
run('yamaguchi__eg-car-park__1', () => stdCarPark('yamaguchi__eg-car-park__1', { muni: '周南市', pref: '山口県' }));
run('yamaguchi__352110_public_parking-lot__1', () => stdCarPark('yamaguchi__352110_public_parking-lot__1', { muni: '長門市', pref: '山口県' }));

// ---------- 九州・沖縄 ----------
run('bodik__431001_050102__0', () => nirin('bodik__431001_050102__0', '熊本市')); // 熊本市が出しているもの（九州先端研の同名データは使わない）
run('bodik__432024_bicycle_parking__0', () => nirin('bodik__432024_bicycle_parking__0', '八代市'));
function nirin(id, muni) { // 熊本県内の様式: 駐輪台数(原付), 駐輪台数(二輪)（二輪の排気量区分なし）
  const t = T(id); const m = { id, muni, pref: '熊本県' };
  for (const r of t.rows) { const p = num(t.c(r, /\(原付\)/)), b = num(t.c(r, /\(二輪\)/)); if (!p && !b) continue;
    add(m, { name: t.c(r, /施設名称$/), addr: t.c(r, /連結標記/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moped: !!p, moto: !!b, ccUnknown: true, capacity: p + b, fee: [t.c(r, /有料・無料/), t.c(r, /2時間無料/) && '2時間無料: ' + t.c(r, /2時間無料/)].filter(Boolean).join(' '), hours: t.c(r, /供用時間/) }); }
}
run('bodik__442011_bicycleparkinglot__0', () => { // 大分市: 50cc以下原付 / 125cc以下原付 / 自転車・50cc以下共用 / 125cc超自動二輪 の台数
  const id = 'bodik__442011_bicycleparkinglot__0', t = T(id); const m = { id, muni: '大分市', pref: '大分県' };
  for (const r of t.rows) { const a = num(r[4]), b = num(r[5]), c = num(r[6]), d = num(r[7]); if (!a && !b && !c && !d) continue;
    add(m, { name: t.c(r, /^名称$/), addr: t.c(r, /所在地/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moped: !!(a || c), moto: !!(b || d), ccUnknown: !d, capacity: a + b + d || null, fee: N(r[8]) !== '-' && N(r[8]) ? '自動二輪 ' + N(r[8]) : '', hours: t.c(r, /開場時間/) }); } });
run('bodik__422011_bicycle_parking__0', () => { // 長崎市: 名称「…二輪車等駐車場」（排気量区分なし）
  const id = 'bodik__422011_bicycle_parking__0', t = T(id); const m = { id, muni: '長崎市', pref: '長崎県' };
  for (const r of t.rows) if (/二輪/.test(t.c(r, /^名称$/))) add(m, { name: t.c(r, /^名称$/), addr: t.c(r, /連結表記/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moto: true, moped: true, ccUnknown: true, capacity: num(t.c(r, /最大駐輪台数/)),
    fee: [t.c(r, /^料金種別$/), t.c(r, /^料金$/) && t.c(r, /^料金$/) + '円', t.c(r, /料金備考/)].filter(Boolean).join(' '), hours: `${t.c(r, /開始時刻/)}-${t.c(r, /終了時刻/)}` }); });
run('bodik__422011_car_park__0', () => stdCarPark('bodik__422011_car_park__0', { muni: '長崎市', pref: '長崎県' }));
run('bodik__470007_public-parking-lots-list__0', () => stdCarPark('bodik__470007_public-parking-lots-list__0', { muni: '沖縄県', pref: '沖縄県' }));
// 近畿の標準様式（公営駐車場）
run('bodik__262056miyazutyuusyajyou__0', () => stdCarPark('bodik__262056miyazutyuusyajyou__0', { muni: '宮津市', pref: '京都府' }));
run('bodik__r5ujipablic_carpark__0', () => stdCarPark('bodik__r5ujipablic_carpark__0', { muni: '宇治市', pref: '京都府' }));
run('bodik__262099_chushajyo1__1', () => stdCarPark('bodik__262099_chushajyo1__1', { muni: '長岡京市', pref: '京都府' }, 'bodik__262099_chushajyo1__0')); // 座標が小数2桁なので施設シートの住所から
run('bodik__260002_koueityuusyajou__0', () => stdCarPark('bodik__260002_koueityuusyajou__0', { muni: '京都府', pref: '京都府' }));
run('bodik__282251_car_park__0', () => stdCarPark('bodik__282251_car_park__0', { muni: '朝来市', pref: '兵庫県' }));
run('bodik__282197_churinjyo__0', () => { // 三田市: うち、原付台数 / 自動二輪台数
  const id = 'bodik__282197_churinjyo__0', t = T(id); const m = { id, muni: '三田市', pref: '兵庫県' };
  for (const r of t.rows) { const p = num(t.c(r, /原付台数/)), b = num(t.c(r, /自動二輪台数/)); if (!p && !b) continue;
    add(m, { name: t.c(r, /駐輪場名/), addr: t.c(r, /住所/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moped: !!p, moto: !!b, capacity: p + b }); } });
run('bodik__232114_public_bicycle_parking__0', () => { // 豊田市: 駐輪場名「…バイク専用駐輪場」
  const id = 'bodik__232114_public_bicycle_parking__0', t = T(id); const m = { id, muni: '豊田市', pref: '愛知県' };
  for (const r of t.rows) if (/バイク/.test(t.c(r, /駐輪場名/))) add(m, { name: t.c(r, /駐輪場名/), addr: t.c(r, /所在地/), lat: t.c(r, /緯度/), lon: t.c(r, /経度/), moto: true, moped: true, ccUnknown: true }); });

// 自治体標準オープンデータセット「公営駐車場一覧」: 車種（バイク・二輪車・自動二輪車・原動機付自転車）と 最大駐車台数_バイク
function stdCarPark(id, meta, facId) {
  const t = T(id); const m = { id, ...meta }; const g = (r, re) => { try { return t.c(r, re); } catch { return ''; } };
  const fac = {}; if (facId) { const f = T(facId); for (const r of f.rows) fac[f.c(r, /施設_ID/)] = f.c(r, /施設_住所|住所_連結表記/); } // 施設シート（GIF 施設一覧）の住所
  for (const r of t.rows) {
    const k = g(r, /車種$/), b = num(g(r, /最大駐車台数_バイク/)), nm = g(r, /(公営駐車場_)?名称$/);
    if (/〇〇|○○/.test(nm)) continue; // 様式の記入例
    const kk = k.replace(/[^;、]*(以外|除く)[^;、]*/g, '');
    const exMoto = /自動二輪/.test(kk), exMoped = /原動機付/.test(kk);
    const generic = /バイク|(?<!自動)二輪車/.test(kk) || (b > 0 && !exMoto && !exMoped); // 区分のない「バイク」「二輪車」、または台数だけ
    if (!generic && !exMoto && !exMoped) continue;
    add(m, { name: nm, addr: g(r, /連結表記|住所_連結|所在地_連結/) || fac[g(r, /施設_ID/)], lat: g(r, /緯度/), lon: g(r, /経度/), moped: generic || exMoped, moto: generic || exMoto, ccUnknown: !exMoto,
      capacity: b, fee: [g(r, /料金種別$/), g(r, /(公営駐車場_)?料金$/), g(r, /料金備考$/)].filter(Boolean).join(' '), hours: g(r, /日時備考$/) || (g(r, /開始時刻$/) && `${g(r, /開始時刻$/)}-${g(r, /終了時刻$/)}`) });
  }
}

fs.writeFileSync(`${W}/stage_jp.json`, JSON.stringify(out, null, 1));
fs.writeFileSync(`${W}/used_jp.json`, JSON.stringify(used));
const c = {}; for (const o of out) c[o.muni] = (c[o.muni] || 0) + 1;
console.log('records', out.length, 'noLatLon', out.filter((o) => o.lat == null).length, 'moto', out.filter((o) => o.moto).length, 'mopedOnly', out.filter((o) => !o.moto).length, 'ccUnknown', out.filter((o) => o.ccUnknown).length);
console.log(JSON.stringify(c));
