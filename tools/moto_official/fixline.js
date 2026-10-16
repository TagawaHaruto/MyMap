const fs=require('fs');const L=fs.readFileSync('build.js','utf8').split('\n');
const i=L.findIndex(l=>l.startsWith('function parseCSV'));
L.splice(i,2,String.raw`function parseCSV(t){const rows=[];let row=[],f='',q=false;for(let i=0;i<t.length;i++){const c=t[i];if(q){if(c=='"'){if(t[i+1]=='"'){f+='"';i++}else q=false}else f+=c}else if(c=='"')q=true;else if(c==','){row.push(f);f=''}else if(c=='\n'){row.push(f.replace(/\r$/,''));rows.push(row);row=[];f=''}else f+=c}if(f||row.length){row.push(f);rows.push(row)}return rows.filter(r=>r.some(x=>x.trim()))}`);
fs.writeFileSync('build.js',L.join('\n'));
