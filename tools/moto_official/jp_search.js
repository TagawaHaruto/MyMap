// 全国版 1/4: CKAN カタログを語で検索して候補データセットを集める。
// usage: node --use-system-ca jp_search.js <workdir>
// 出力: <workdir>/pkgs.json  { "<catalog>|<name>": {cat, name, title, org, license, modified, url, resources:[{name,url,format,modified}]} }
const fs = require('fs');
const W = process.argv[2] || '.';
const CATS = {
  egov: 'https://data.e-gov.go.jp/data/api/3/action/package_search', // e-Gov データポータル（多くの自治体が登録）
  bodik: 'https://data.bodik.jp/api/3/action/package_search', // BODIK ODCS
  gspatial: 'https://www.geospatial.jp/ckan/api/3/action/package_search', // G空間情報センター
  sapporo: 'https://ckan.pf-sapporo.jp/api/3/action/package_search', // 札幌市
};
const PAGE = { egov: 'https://data.e-gov.go.jp/data/dataset/', bodik: 'https://data.bodik.jp/dataset/', gspatial: 'https://www.geospatial.jp/ckan/dataset/', sapporo: 'https://ckan.pf-sapporo.jp/dataset/' };
const KW = ['自動二輪', '二輪', 'バイク', 'オートバイ', '原付', '原動機付自転車', '駐輪場', '駐輪', '自転車駐車場', '自転車等駐車場', '公営駐車場', '公営駐輪場'];
const get = async (u) => { for (let i = 0; ; i++) { try { const r = await fetch(u, { signal: AbortSignal.timeout(60000) }); if (r.ok) return r.json(); throw new Error(r.status); } catch (e) { if (i >= 2) throw e; } } };
(async () => {
  const pk = {};
  for (const [cat, base] of Object.entries(CATS)) {
    for (const k of KW) {
      for (let start = 0; ; start += 1000) {
        let j; try { j = await get(`${base}?rows=1000&start=${start}&q=${encodeURIComponent(k)}`); } catch (e) { console.error(cat, k, 'ERR', e.message); break; }
        for (const p of j.result.results) pk[`${cat}|${p.name}`] = {
          cat, name: p.name, title: p.title, org: p.organization?.title || '', license: p.license_title || p.license_id || '', licenseId: p.license_id || '',
          modified: p.metadata_modified, url: PAGE[cat] + p.name, notes: (p.notes || '').slice(0, 300),
          resources: (p.resources || []).map((r) => ({ name: r.name, url: r.url, format: r.format, modified: r.last_modified || r.created })),
        };
        console.error(cat, k, j.result.count, start);
        if (start + 1000 >= j.result.count) break;
      }
    }
  }
  fs.writeFileSync(`${W}/pkgs.json`, JSON.stringify(pk));
  console.log('packages', Object.keys(pk).length);
})();
