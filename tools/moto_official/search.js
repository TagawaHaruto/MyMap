const fs=require('fs');
(async()=>{const kws=['二輪','自動二輪','オートバイ','バイク','原付','原動機付自転車','駐輪場','自転車駐車場','自転車等駐車場','駐車場'];
const pk={};
for(const k of kws){let start=0;for(;;){const u='https://catalog.data.metro.tokyo.lg.jp/api/3/action/package_search?rows=1000&start='+start+'&q='+encodeURIComponent(k);const j=await (await fetch(u)).json();for(const p of j.result.results)pk[p.name]=p;console.error(k,j.result.count,start);start+=1000;if(start>=j.result.count)break;}}
fs.writeFileSync('pkgs.json',JSON.stringify(pk));
for(const p of Object.values(pk)){console.log([p.name,p.organization?.title,p.title,p.resources.length].join('\t'))}
})()
