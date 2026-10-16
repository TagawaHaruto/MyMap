const fs=require('fs'),crypto=require('crypto');
const pk=JSON.parse(fs.readFileSync('pkgs.json'));
const re=/駐輪|二輪|オートバイ|自転車駐車場|自転車等駐車|駐車施設|公営駐車場|駐車場一覧/;
const skip=/施設カルテ|保管|撤去|付置義務|リサイクル|サイクルポート|シェア|税|利用状況|放置|三輪町|三輪緑山|自転車レーン|走行空間|届出|指定管理|調査|保有台数/;
fs.mkdirSync('raw',{recursive:true});
function parseCSV(t){const rows=[];let row=[],f='',q=false;for(let i=0;i<t.length;i++){const c=t[i];if(q){if(c=='"'){if(t[i+1]=='"'){f+='"';i++}else q=false}else f+=c}else if(c=='"')q=true;else if(c==','){row.push(f);f=''}else if(c=='\n'){row.push(f.replace(/\r$/,''));rows.push(row);row=[];f=''}else f+=c}if(f||row.length){row.push(f);rows.push(row)}return rows.filter(r=>r.some(x=>x.trim()))}
(async()=>{const out=[];
for(const p of Object.values(pk)){if(!re.test(p.title)||skip.test(p.title))continue;
 for(const [i,r] of p.resources.entries()){const apiId=p.name+'-'+crypto.createHash('md5').update(r.url).digest('hex')+'-0';let rec={pkg:p.name,muni:p.organization?.title,title:p.title,res:r.name,url:r.url,fmt:r.format,lm:r.last_modified||r.created,lic:p.license_title,apiId};
  let data=null;
  try{let all=[],off=0,tot;for(;;){const res=await fetch(`https://service.api.metro.tokyo.lg.jp/api/${apiId}/json?limit=1000&offset=${off}`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});if(res.status!=200)throw new Error('api '+res.status);const j=await res.json();tot=j.total;all.push(...j.hits);rec.apiUpdated=j.metadata?.updated;off+=1000;if(off>=tot)break}data=all;rec.method='api'}catch(e){rec.apiErr=e.message}
  if(!data&&/csv/i.test(r.format+r.url)){try{const b=Buffer.from(await (await fetch(r.url)).arrayBuffer());let t=new TextDecoder('utf-8',{fatal:true});let s;try{s=t.decode(b)}catch{s=new TextDecoder('shift_jis').decode(b)}s=s.replace(/^﻿/,'');const rows=parseCSV(s);const h=rows[0].map(x=>x.trim());data=rows.slice(1).map(rw=>Object.fromEntries(h.map((k,j)=>[k,rw[j]])));rec.method='csv'}catch(e){rec.csvErr=e.message}}
  rec.n=data?data.length:0;rec.cols=data&&data[0]?Object.keys(data[0]).join('|'):'';
  const fn=`raw/${p.name}_${i}.json`;if(data)fs.writeFileSync(fn,JSON.stringify(data));rec.file=fn;out.push(rec);console.log([rec.muni,p.title,r.name,rec.fmt,rec.method||'FAIL',rec.n,rec.apiErr||'',rec.csvErr||''].join('\t'))}}
fs.writeFileSync('index.json',JSON.stringify(out,null,1))})()
