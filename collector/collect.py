"""MyMap 収集スクリプト（Python 標準ライブラリのみ）。

使い方: python collector/collect.py
config.json の sources を順に取得し、data/events.json と data/status.json を更新する。
"""
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from html import unescape

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
JST = dt.timezone(dt.timedelta(hours=9))

# 全カテゴリがこれに当てはまる event.js のイベントは除外（自治体ごとに名前が違うため部分一致）
EXCLUDE = '相談|講座|講習|講演|教室|説明会|会議|議会|審議|委員会|健康|福祉|しごと|はたらく'
# 会場名・タイトルの語 → 屋内か（上から順に最初に当たったもの）
INDOOR_WORDS = [
    ('体育館', True), ('ホール', True), ('劇場', True), ('文化センター', True), ('公民館', True), ('図書館', True),
    ('博物館', True), ('美術館', True), ('プラネタリウム', True), ('プレイス', True), ('たづくり', True), ('会館', True),
    ('スタジアム', False), ('競技場', False), ('公園', False), ('広場', False), ('グラウンド', False),
    ('河川敷', False), ('ハイキング', False), ('マルシェ', False), ('まつり', False), ('祭り', False),
]
MORE = re.compile(r'^(もっと見る|続きを見る|一覧)')


def clean(s):
    return re.sub(r'\s+', ' ', unescape(re.sub(r'<[^>]+>', '', str(s)))).strip()


def fnum(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def ev(src, key, title, start, end, url, place=None, lat=None, lon=None):
    # 座標が無いイベントは収集元の所在地で代用（距離の目安用）
    return {'id': f"{src['id']}:{key}", 'title': clean(title), 'start': start, 'end': end or start,
            'place': clean(place) if place else src.get('place'),
            'lat': lat if lat is not None else src.get('lat'), 'lon': lon if lon is not None else src.get('lon'),
            'pref': src.get('pref'), 'indoor': src.get('indoor'), 'url': url, 'source': src['id']}


# ---- パーサ（text → event のリスト。通信しない） ----

def parse_eventjs(text, src, today):
    body = text[text.index('{'):text.rindex('}') + 1]
    body = re.sub(r'([{\n]\s*)([A-Za-z_]\w*)\s*:', r'\1"\2":', body)  # 行頭の素のキーを JSON 用に引用
    data = json.loads(body)
    cats = data.get('categories', {})
    skip = re.compile(src.get('excludePattern', EXCLUDE))
    out = []
    for e in data['events']:
        names = [cats.get(c, '') for c in e.get('category', [])]
        if names and all(skip.search(n) for n in names):
            continue
        days = sorted(d.replace('/', '-') for d in e.get('opendays', []))
        days = [d for d in days if d >= today]
        if not days:
            continue
        place = e.get('place2') if isinstance(e.get('place2'), str) else e.get('place') if isinstance(e.get('place'), str) else None
        out.append(ev(src, e.get('outer') or e['url'], e['eventtitle'], days[0], days[-1], e['url'], place))
    return out


def parse_daylist(text, src, today, year, month, page_url):
    """1 行 = 1 日（「N日」を含むセル）の一覧表。同じリンクは開始日〜終了日にまとめる。"""
    text = re.sub(r'<script.*?</script>|<style.*?</style>', '', text, flags=re.S)
    spans = {}
    for row in re.findall(r'<tr[^>]*>(.*?)</tr>', text, re.S):
        m = re.search(r'(\d{1,2})日', re.sub(r'<[^>]+>', '', row))
        if not m:
            continue
        try:
            day = dt.date(year, month, int(m.group(1))).isoformat()
        except ValueError:
            continue
        for href, title in re.findall(r'<a href="([^"#]+)"[^>]*>(.*?)</a>', row, re.S):
            # ponytail: 混雑日の「もっと見る」先（日別ページ）は追わない。取りこぼしが気になったら日別ページも取得する
            if MORE.match(clean(title)):
                continue
            url = urllib.parse.urljoin(page_url, unescape(href))
            span = spans.setdefault(url, [clean(title), day, day])
            span[1], span[2] = min(span[1], day), max(span[2], day)
    return [ev(src, url, t, a, b, url) for url, (t, a, b) in spans.items() if b >= today and t]


def to_jst_date(iso):
    return dt.datetime.fromisoformat(iso.replace('Z', '+00:00')).astimezone(JST).date().isoformat()


def parse_doorkeeper(text, src, today):
    out = []
    for item in json.loads(text):
        e = item['event']
        start, end = to_jst_date(e['starts_at']), to_jst_date(e.get('ends_at') or e['starts_at'])
        if end < today:
            continue
        out.append(ev(src, e['id'], e['title'], start, end, e['public_url'], e.get('venue_name'),
                      fnum(e.get('lat')), fnum(e.get('long'))))
    return out


def parse_nextdata(text, src, today):
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', text, re.S)
    events = json.loads(m.group(1))['props']['pageProps']['content']['events']
    base = urllib.parse.urlsplit(src['url'])
    out = []
    for e in events:
        dates = (e.get('acfEvent') or {}).get('dates') or []
        if not dates:
            continue
        start = min(d['startDate'] for d in dates)
        end = max(d.get('endDate') or d['startDate'] for d in dates)
        if end < today:
            continue
        url = f"{base.scheme}://{base.netloc}/events/archives/{e['databaseId']}"
        out.append(ev(src, e['databaseId'], e['title'], start, end, url))
    return out


PARSERS = {'eventjs': parse_eventjs, 'daylist': parse_daylist, 'doorkeeper': parse_doorkeeper, 'nextdata': parse_nextdata}


# ---- 取得と集約 ----

def source_pages(src, today, months):
    """収集元 1 つ分の (URL, パーサへの追加引数) のリスト。"""
    t = src['type']
    if t == 'doorkeeper':
        q = urllib.parse.quote(src['query'])
        return [(f'https://api.doorkeeper.jp/events?q={q}&since={today.isoformat()}&sort=starts_at', {})]
    if t == 'nextdata':
        return [(src['url'].format(page=p), {}) for p in range(1, src.get('pages', 1) + 1)]
    if t == 'daylist':
        pages, y, m = [], today.year, today.month
        for i in range(months):
            # 当月だけ別 URL のサイトがある（府中市: list_calendar.html）
            url = src['firstUrl'] if i == 0 and src.get('firstUrl') else src['url'].format(Y=y, M=m, YM=f'{y}{m:02d}')
            pages.append((url, {'year': y, 'month': m, 'page_url': url}))
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        return pages
    return [(src['url'], {})]


def guess_indoor(text):
    for word, indoor in INDOOR_WORDS:
        if word in text:
            return indoor
    return None


def finalize(events, today, months_ahead):
    first, last = today.isoformat(), (today + dt.timedelta(days=31 * months_ahead)).isoformat()
    seen, out = set(), []
    for e in sorted(events, key=lambda x: (x['start'], x['title'])):
        key = (e['title'], e['start'])
        if key in seen or e['end'] < first or e['start'] > last:
            continue
        seen.add(key)
        if e['indoor'] is None:
            e['indoor'] = guess_indoor(f"{e['place'] or ''} {e['title']}")
        out.append(e)
    return out


def now_iso():
    return dt.datetime.now(JST).isoformat(timespec='seconds')


def collect_events(cfg, today, old_events, status, fetch):
    events = []
    for src in cfg['sources']:
        st = status['sources'].setdefault(src['id'], {'ok_at': None, 'count': 0, 'error': None})
        try:
            got = []
            for url, kw in source_pages(src, today, cfg['eventMonthsAhead']):
                got += PARSERS[src['type']](fetch(url), src, today.isoformat(), **kw)
            events += got
            st.update(ok_at=now_iso(), count=len(got), error=None)
        except Exception as err:  # 1 つの収集元の失敗で全体を止めない。前回分を残す
            events += [e for e in old_events if e['source'] == src['id']]
            st['error'] = f'{type(err).__name__}: {err}'[:300]
            print(f"[{src['id']}] {st['error']}", file=sys.stderr)
    ids = {s['id'] for s in cfg['sources']}
    status['sources'] = {k: v for k, v in status['sources'].items() if k in ids}
    return finalize(events, today, cfg['eventMonthsAhead'])


def make_fetch(cfg):
    ua = f"MyMap-collector (+https://github.com/{cfg['github']['owner']}/{cfg['github']['repo']})"
    last = [0.0]

    def fetch(url, data=None, timeout=60):
        wait = 1.0 - (time.time() - last[0])  # 1 秒以上あける
        if wait > 0:
            time.sleep(wait)
        req = urllib.request.Request(url, data=data, headers={'User-Agent': ua})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw, charset = r.read(), r.headers.get_content_charset()
        finally:
            last[0] = time.time()
        return raw.decode(charset or 'utf-8', errors='replace')
    return fetch


def load(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save(path, obj):
    tmp = path + '.tmp'  # 書きかけで壊さないよう、一時ファイルから置き換える
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def main():
    cfg = load(os.path.join(ROOT, 'config.json'), None)
    today = dt.datetime.now(JST).date()
    status = load(os.path.join(DATA, 'status.json'), {})
    status.setdefault('sources', {})
    old = load(os.path.join(DATA, 'events.json'), [])
    fetch = make_fetch(cfg)
    events = collect_events(cfg, today, old, status, fetch)
    save(os.path.join(DATA, 'events.json'), events)
    status['updated_at'] = now_iso()
    save(os.path.join(DATA, 'status.json'), status)
    print(f'events: {len(events)}')


if __name__ == '__main__':
    main()
