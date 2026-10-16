const fs=require('fs');let s=fs.readFileSync('build.js','utf8');const rep=(a,b)=>{if(!s.includes(a))throw a;s=s.replace(a,b)};
rep("if (/~125|125~|全排気量|自転車・バイク/.test(t)) o.moto = 1; if (/~50|~125|全排気量|自転車・バイク/.test(t)) o.moped = 1;",
    "const un = t === 'バイク' || t === '自転車・バイク'; if (un || /~125|125~|全排気量/.test(t)) o.moto = 1; if (un || /~50|~125|全排気量/.test(t)) o.moped = 1;");
rep("o.fee.push(`${t.replace('バイク', '')} 一時${N(r['一時料金（円）']) || '-'}円/定期${N(r['定期料金（円）']).replace(/^\(.*?\)/, '') || '-'}円`); }",
    "const f1 = N(r['一時料金（円）']), f2 = N(r['定期料金（円）']); o.fee.push([t.replace('バイク', 'バイク'), f1 && `一時${f1}円`, f2 && `定期${f2}円`].filter(Boolean).join(' ')); }");
rep(".filter(x => /(原動機付|自動二輪).*\d/.test(x))", ".filter(x => /(原動機付|自動二輪).*\d/.test(x) && !/利用不可$/.test(x))");
rep("fee: N(r['一時利用部分の有料/無料の別(原付・自動二輪)']) && '一時:' + N(r['一時利用部分の有料/無料の別(原付・自動二輪)']) + ' 定期:' + N(r['定期利用部分の有料/無料の別(原付・自動二輪)']),",
    "fee: [['一時', r['一時利用部分の有料/無料の別(原付・自動二輪)']], ['定期', r['定期利用部分の有料/無料の別(原付・自動二輪)']]].filter(x => N(x[1])).map(x => x[0] + ':' + N(x[1])).join(' '),");
fs.writeFileSync('build.js',s);
