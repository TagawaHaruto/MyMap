// 全国版 1/4: カタログ（CKAN と dataeye の CKAN 互換 API）を語で検索して候補データセットを集める。
// usage: node --use-system-ca jp_search.js <workdir>
// 出力: <workdir>/pkgs.json  { "<catalog>|<name>": {cat, name, title, org, license, modified, url, resources:[{name,url,format,modified}]} }
// 東京都カタログは東京版（search.js / fetchall.js）で扱うのでここには入れない。
const fs = require('fs');
const W = process.argv[2] || '.';
// [検索API, データセットページの接頭辞]
const CATS = {
  bodik: ['https://data.bodik.jp/api/3/action/package_search', 'https://data.bodik.jp/dataset/'], // BODIK ODCS（九州・近畿など多数）
  gspatial: ['https://www.geospatial.jp/ckan/api/3/action/package_search', 'https://www.geospatial.jp/ckan/dataset/'], // G空間情報センター
  sapporo: ['https://ckan.pf-sapporo.jp/api/3/action/package_search', 'https://ckan.pf-sapporo.jp/dataset/'],
  ishikawa: ['https://ckan.opendata.pref.ishikawa.lg.jp/api/3/action/package_search', 'https://ckan.opendata.pref.ishikawa.lg.jp/dataset/'],
  gifu: ['https://gifu-opendata.pref.gifu.lg.jp/api/3/action/package_search', 'https://gifu-opendata.pref.gifu.lg.jp/dataset/'],
  sagamihara: ['https://opendata.city.sagamihara.kanagawa.jp/api/3/action/package_search', 'https://opendata.city.sagamihara.kanagawa.jp/dataset/'],
  yamaguchi: ['https://yamaguchi-opendata.jp/ckan/api/3/action/package_search', 'https://yamaguchi-opendata.jp/ckan/dataset/'],
  himeji: ['https://city.himeji.gkan.jp/gkan/api/3/action/package_search', 'https://city.himeji.gkan.jp/gkan/dataset/'],
  utsunomiya: ['https://catalog.city.utsunomiya.tochigi.jp/api/3/action/package_search', 'https://catalog.city.utsunomiya.tochigi.jp/dataset/'],
  // dataeye（一般社団法人データクレイドル）の CKAN 互換 API。start はページ番号
  chiba: ['https://opendata.pref.chiba.lg.jp/ckan_api/package_search', 'https://opendata.pref.chiba.lg.jp/datasets/'],
  saitama: ['https://opendata.pref.saitama.lg.jp/ckan_api/package_search', 'https://opendata.pref.saitama.lg.jp/datasets/'],
  okayama: ['https://www.okayama-opendata.jp/ckan_api/package_search', 'https://www.okayama-opendata.jp/datasets/'],
  miyagi: ['https://miyagi.dataeye.jp/ckan_api/package_search', 'https://miyagi.dataeye.jp/datasets/'],
  hiroshima: ['https://hiroshima-opendata.dataeye.jp/ckan_api/package_search', 'https://hiroshima-opendata.dataeye.jp/datasets/'],
  shimane: ['https://shimane-opendata.jp/ckan_api/package_search', 'https://shimane-opendata.jp/datasets/'],
  iwate: ['https://iwate.dataeye.jp/ckan_api/package_search', 'https://iwate.dataeye.jp/datasets/'],
};
const KW = ['自動二輪', '二輪', 'バイク', 'オートバイ', '原付', '原動機付自転車', '駐輪場', '駐輪', '自転車駐車場', '自転車等駐車場', '公営駐車場', '公営駐輪場'];
const get = async (u) => { for (let i = 0; ; i++) { try { const r = await fetch(u, { signal: AbortSignal.timeout(60000) }); if (r.ok) return r.json(); throw new Error(r.status); } catch (e) { if (i >= 2) throw e; } } };
(async () => {
  const pk = {};
  for (const [cat, [base, page]] of Object.entries(CATS)) {
    const dataeye = base.includes('/ckan_api/');
    for (const k of KW) {
      for (let pg = 0; ; pg++) {
        let j; try { j = await get(`${base}?rows=1000&start=${dataeye ? pg + 1 : pg * 1000}&q=${encodeURIComponent(k)}`); } catch (e) { console.error(cat, k, 'ERR', e.message); break; }
        const rs = j.result?.results || [];
        for (const p of rs) pk[`${cat}|${p.name || p.id}`] = {
          cat, name: p.name || p.id, title: p.title, org: p.organization?.title || '', license: p.license_title || p.license_id || '',
          modified: p.metadata_modified || '', url: page + (dataeye ? p.id : p.name), notes: (p.notes || '').slice(0, 300),
          resources: (p.resources || []).map((r) => ({ name: r.name, url: r.url, format: r.format, modified: r.last_modified || r.created || '', license: r.license_title || r.resource_license_id || r.license || '' })), // dataeye はリソースごとに resource_license_id
        };
        console.error(cat, k, j.result?.count, pg);
        if ((pg + 1) * 1000 >= (j.result?.count || 0) || !rs.length) break;
      }
    }
  }
  fs.writeFileSync(`${W}/pkgs.json`, JSON.stringify(pk));
  console.log('packages', Object.keys(pk).length);
})();
