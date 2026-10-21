# XLSX / XLS -> JSON {sheet: [[cell, ...], ...]} on stdout.
# usage: python -P jp_xlsx.py <file.xlsx|file.xls>   (-P: カレント・スクリプトのフォルダを import 先にしない)
# .xls は xlrd が要る（pip install xlrd か、xlrd の wheel を PYTHONPATH に置く）
import sys, json, datetime, warnings
warnings.filterwarnings("ignore")

def cell(v):
    if v is None:
        return ''
    if isinstance(v, (datetime.date, datetime.datetime, datetime.time)):
        return v.isoformat()
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)

f = open(sys.argv[1], 'rb')
if f.read(4) != b'PK\x03\x04':  # 拡張子が .xls でも中身が xlsx のことがあるので先頭で判定
    import xlrd
    wb = xlrd.open_workbook(sys.argv[1])
    sheets = [(s.name, (s.row_values(i) for i in range(s.nrows))) for s in wb.sheets()]
else:
    import openpyxl
    f.seek(0)
    wb = openpyxl.load_workbook(f, read_only=True, data_only=True)
    sheets = [(ws.title, ws.iter_rows(values_only=True)) for ws in wb.worksheets]
out = {}
for name, it in sheets:
    rows = []
    for r in it:
        cells = [cell(v) for v in r]
        if any(c.strip() for c in cells):
            rows.append(cells)
    out[name] = rows
sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode('utf-8'))
