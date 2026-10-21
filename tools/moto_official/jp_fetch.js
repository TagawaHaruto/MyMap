// 全国版 2/4: 候補データセットのファイルを取得して表（2次元配列）にする。
// usage: node --use-system-ca jp_fetch.js <workdir>      （先に jp_search.js）
// 出力: <workdir>/raw/<id>.<ext>（取得したまま）, <workdir>/tab/<id>.json（{シート名: [[セル...]...]}。CSV・JSON はシート名 "_"）, <workdir>/index.json
// XLSX は python（openpyxl）で表にする（jp_xlsx.py）。取得したファイルは信頼しないデータとして扱い、実行しない。
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const W = process.argv[2] || '.';
for (const d of ['raw', 'tab']) fs.mkdirSync(`${W}/${d}`, { recursive: true });

// カタログ検索で拾ったもののうち、題名で絞る
const RE = /駐輪|二輪|オートバイ|バイク|原付|原動機付|自転車駐車|自転車等駐車|駐車施設|駐車場/;
const SKIP = /保管|撤去|付置|リサイクル|シェア|税|利用状況|放置|走行|届出|調査|保有台数|事故|台数|統計|免許|登録|ナンバー|交通量|件数|運転|盗難|ヘルメット|補助|年報|予算|決算|計画|交通安全|違反|騒音|排出|販売|生産|輸出|輸入|犯罪|禁止|検知|おもいやり|思いやり|支え合い|妊婦|県営住宅|土地利用|共同住宅|道路台帳|利用データ|使用料|P&R|満空|自転車数$|^\d{6}_東京都|^東京都_/;
// カタログ以外（市のサイト・地図システムのオープンデータ）。license は配布ページの表示
const EXTRA = [
  { cat: 'web', org: '平塚市', title: '駐輪場【公営】', page: 'https://www.city.hiratsuka.kanagawa.jp/keikaku/page81_00019.html', url: 'https://www.city.hiratsuka.kanagawa.jp/common/200203598.csv', license: 'CC BY 4.0' },
  { cat: 'web', org: 'つくば市', title: '自転車等駐車場一覧データセット', page: 'https://www.city.tsukuba.lg.jp/kurashi/kotsu/jitensha/1001481.html', url: 'https://www.city.tsukuba.lg.jp/material/files/group/131/bicycle_ichiran.xlsx', license: 'CC BY 4.0' },
  { cat: 'web', org: '海老名市', title: '駐車場・駐輪場(201906)', page: 'https://www.city.ebina.kanagawa.jp/shisei/denshi/opendata/1008755/1004083.html', url: 'https://www.city.ebina.kanagawa.jp/_res/projects/default_project/_page_/001/004/083/car_cycle_R1.6.csv', license: 'CC BY 4.0' },
  { cat: 'web', org: '大阪市', title: '施設情報ポイントデータ（駐車場・駐輪場）', page: 'https://www.city.osaka.lg.jp/toshikeikaku/page/0000250227.html', url: 'https://www.mapnavi.city.osaka.lg.jp/osakacity/osakacity/opendatafile/map_1/CSV/opendata_1010.csv', license: 'CC BY 4.0' },
  { cat: 'web', org: '浜松市', title: '浜松市営バイク駐車場', page: 'https://opendata.pref.shizuoka.jp/dataset/11955.html', url: 'https://static.hamamatsu.odpf.net/opendata/v01/221309_bike_parking/221309_bike_parking.csv', license: 'CC BY 4.0' },
  { cat: 'web', org: '新潟市', title: 'GIS 駐輪場', page: 'https://www.city.niigata.lg.jp/shisei/seisaku/it/open-data/opendata-gis/od-gis_kankobunspo/od-gis_pkbicycles.html', url: 'https://www.city.niigata.lg.jp/shisei/seisaku/it/open-data/opendata-gis/od-gis_kankobunspo/od-gis_pkbicycles.files/od_gis_10093_pkbicycles.csv', license: 'CC BY 2.1 JP' },
  { cat: 'web', org: '豊橋市', title: '豊橋市 駐輪場', page: 'https://opendata-east-mikawa.jp/node/270', url: 'https://opendata-east-mikawa.jp/sites/default/files/resources/%E9%A7%90%E8%BC%AA%E5%A0%B4%E3%82%AA%E3%83%BC%E3%83%97%E3%83%B3%E3%83%87%E3%83%BC%E3%82%BF%EF%BC%88CSV%EF%BC%89.csv', license: 'CC BY 4.0' },
  { cat: 'web', org: '広島市', title: '市営駐車場・駐輪場（ひろしま地図ナビ）', page: 'https://www2.wagmap.jp/hiroshimacity/OpenDataDetail?lid=607', url: 'https://www2.wagmap.jp/hiroshimacity/hiroshimacity/opendatafile/map_1/CSV/opendata_607.csv', license: 'CC BY' },
  { cat: 'web', org: '仙台市', title: '駐輪場（せんだいくらしのマップ）', page: 'https://www.city.sendai.jp/joho-kikaku/shise/security/kokai/opendata_churinjo.html', url: 'https://www2.wagmap.jp/sendaicity/sendaicity/opendatafile/map_235/CSV/opendata_928.csv', license: 'CC BY 4.0' },
  { cat: 'web', org: '山形市', title: '市営駐車場・駐輪場一覧', page: 'https://www.city.yamagata-yamagata.lg.jp/opendata/category/1007068/1005180.html', url: 'https://www.city.yamagata-yamagata.lg.jp/_res/projects/default_project/_page_/001/005/180/chuushachuurin.csv', license: 'CC BY 4.0' },
  { cat: 'web', org: '鳥取市', title: '公営駐輪場一覧', page: 'https://odp-pref-tottori.tori-info.co.jp/dataset/1887.html', url: 'https://odp-pref-tottori.tori-info.co.jp/dataset/1887/resource/9613/312011_bicycle_parking.csv', license: 'CC BY' },
];

const ext = (u, f) => { const e = (String(f || '').toLowerCase().match(/csv|xlsx|xls|geojson|json/) || [])[0] || (decodeURIComponent(u).toLowerCase().match(/\.(csv|xlsx|xls|geojson|json)(\?|$)/) || [])[1]; return e; };
const dl = async (u, f) => {
  try { const r = await fetch(u, { signal: AbortSignal.timeout(90000) }); if (!r.ok) throw new Error('HTTP ' + r.status); fs.writeFileSync(f, Buffer.from(await r.arrayBuffer())); }
  catch (e) { // 古い TLS（DH 鍵が短い等）で node が失敗するホストは curl で取り直す（TLS の検証は無効にしない）
    if (!/DH_KEY|SSL|fetch failed/i.test(e.message + (e.cause?.code || ''))) throw e;
    execFileSync('curl', ['-sSfL', '--max-time', '90', '-o', f, u]);
  }
};
function parseCSV(t) { const rows = []; let row = [], f = '', q = false; for (let i = 0; i < t.length; i++) { const c = t[i]; if (q) { if (c == '"') { if (t[i + 1] == '"') { f += '"'; i++ } else q = false } else f += c } else if (c == '"' && f === '') q = true; else if (c == ',') { row.push(f); f = '' } else if (c == '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = '' } else f += c } if (f || row.length) { row.push(f); rows.push(row) } return rows.filter((r) => r.some((x) => x.trim())) }
const decode = (b) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(b).replace(/^﻿/, '') } catch { return new TextDecoder('shift_jis').decode(b) } };

(async () => {
  const pk = JSON.parse(fs.readFileSync(`${W}/pkgs.json`));
  const src = [];
  for (const p of Object.values(pk)) {
    if (!RE.test(p.title) || SKIP.test(p.title)) continue;
    p.resources.forEach((r, i) => src.push({ cat: p.cat, org: p.org, title: p.title, page: p.url, url: r.url, format: r.format, res: r.name, license: r.license || p.license, modified: r.modified || p.modified, id: `${p.cat}__${p.name}__${i}` }));
  }
  EXTRA.forEach((x, i) => src.push({ ...x, id: `web__${i}` }));
  const idx = [];
  for (const s of src) {
    // 地図システム wagmap の詳細ページ URL は CSV の URL に置き換える
    const wg = (s.url || '').match(/^https:\/\/www2\.wagmap\.jp\/(\w+)\/OpenDataDetail\?lid=(\d+)&mids=(\d+)/);
    if (wg) { s.url = `https://www2.wagmap.jp/${wg[1]}/${wg[1]}/opendatafile/map_${wg[3]}/CSV/opendata_${wg[2]}.csv`; s.format = 'CSV'; }
    const e = ext(s.url || '', s.format);
    if (!e || !s.url) { idx.push({ ...s, skip: 'format ' + s.format }); continue; }
    const id = s.id.replace(/[^\w.-]/g, '_'), raw = `${W}/raw/${id}.${e}`;
    try {
      if (!fs.existsSync(raw)) await dl(s.url, raw);
      let tab;
      if (e === 'csv') tab = { _: parseCSV(decode(fs.readFileSync(raw))) };
      else if (e === 'xlsx' || e === 'xls') tab = JSON.parse(execFileSync('python', ['-P', path.join(__dirname, 'jp_xlsx.py'), raw], { maxBuffer: 1 << 28 }).toString());
      else if (e === 'json' || e === 'geojson') { const j = JSON.parse(decode(fs.readFileSync(raw))); const fe = j.features || (Array.isArray(j) ? j : null); if (!fe) throw new Error('json shape'); tab = { _: [Object.keys(fe[0].properties || fe[0]).concat(['_lon', '_lat']), ...fe.map((f) => Object.values(f.properties || f).map(String).concat(f.geometry?.coordinates?.slice?.(0, 2) || ['', '']))] }; }
      else throw new Error('unsupported ' + e);
      fs.writeFileSync(`${W}/tab/${id}.json`, JSON.stringify(tab));
      idx.push({ ...s, id, ext: e, raw, tab: `${W}/tab/${id}.json` });
      console.error('ok', id, s.org, s.title);
    } catch (err) { idx.push({ ...s, id, ext: e, err: err.message.slice(0, 200) }); console.error('ERR', id, s.org, s.title, err.message.slice(0, 120)); }
  }
  fs.writeFileSync(`${W}/index.json`, JSON.stringify(idx, null, 1));
  console.log('sources', idx.length, 'ok', idx.filter((x) => x.tab).length, 'err', idx.filter((x) => x.err).length, 'skip', idx.filter((x) => x.skip).length);
})();
