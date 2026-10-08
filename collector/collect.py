"""MyMap 収集スクリプト（Python 標準ライブラリのみ）。

使い方: python collector/collect.py
config.json の sources を順に取得し、data/events.json と data/status.json を更新する。
"""
import datetime as dt
import json
import math
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
# ただしこれに当てはまるカテゴリは除外しない（「スポーツ・健康」「親子教室」など）
KEEP = '祭|まつり|催し|イベント|文化|芸術|スポーツ|キッズ|子ども|こども|親子|展示|鑑賞|観光'
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
    skip, keep = re.compile(src.get('excludePattern', EXCLUDE)), re.compile(KEEP)
    out = []
    for e in data['events']:
        names = [cats.get(c, '') for c in e.get('category', [])]
        if names and all(skip.search(n) and not keep.search(n) for n in names):
            continue
        days = sorted(d.replace('/', '-') for d in e.get('opendays', []))
        days = [d for d in days if d >= today]
        if not days:
            continue
        place = e.get('place2') if isinstance(e.get('place2'), str) else e.get('place') if isinstance(e.get('place'), str) else None
        url = urllib.parse.urljoin(src.get('url', ''), e['url'])  # 相対 URL は収集元基準で解決
        out.append(ev(src, e.get('outer') or e['url'], e['eventtitle'], days[0], days[-1], url, place))
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
            if not url.startswith(('http://', 'https://')):  # javascript: 等
                continue
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


# ---- 立ち寄り候補・絶景（OpenStreetMap / Overpass） ----

def bbox(origin, radius_km):
    dlat = radius_km / 111
    dlon = radius_km / (111 * math.cos(math.radians(origin['lat'])))
    return f"({origin['lat'] - dlat:.3f},{origin['lon'] - dlon:.3f},{origin['lat'] + dlat:.3f},{origin['lon'] + dlon:.3f})"


def overpass_query(origin, radius_km):
    # 429（混雑）を避けるため全種類を 1 回の問い合わせにまとめる
    bb = bbox(origin, radius_km)
    parts = ['nwr["name"~"^道の駅"]', 'nwr["amenity"="public_bath"]["bath:type"="onsen"]["name"]',
             'nwr["tourism"="viewpoint"]["name"]', 'nwr["waterway"="waterfall"]["name"]["wikipedia"]',
             'nwr["natural"="peak"]["name"]["wikipedia"]', 'nwr["natural"~"^(valley|gorge)$"]["name"]["wikipedia"]',
             'nwr["natural"="water"]["water"="lake"]["name"]["wikipedia"]',
             'nwr["natural"~"^(beach|cape)$"]["name"]["wikipedia"]']
    return '[out:json][timeout:180];(' + ''.join(p + bb + ';' for p in parts) + ');out center tags;'


def poi_kind(t):
    name = t.get('name', '')
    if name.startswith('道の駅'):
        bus = t.get('highway') == 'bus_stop' or 'public_transport' in t or name.endswith(('入口', '前'))
        return None if bus else 'michinoeki'
    if t.get('amenity') == 'public_bath':
        return 'onsen'
    if t.get('tourism') == 'viewpoint':
        return 'viewpoint'
    if not t.get('wikipedia'):
        return None
    if t.get('waterway') == 'waterfall':
        return 'waterfall'
    nat = t.get('natural')
    if nat == 'peak':
        return 'peak'
    if nat in ('valley', 'gorge'):
        return 'gorge'
    if nat == 'water' and t.get('water') == 'lake':
        return 'lake'
    if nat in ('beach', 'cape'):
        return 'coast'
    return None


def wiki_url(tag):
    if not tag or ':' not in tag:
        return None
    lang, title = tag.split(':', 1)
    return f'https://{lang}.wikipedia.org/wiki/' + urllib.parse.quote(title.replace(' ', '_'))


def parse_overpass(text):
    seen, out = set(), []
    for el in json.loads(text)['elements']:
        t = el.get('tags', {})
        kind = poi_kind(t)
        pos = el if 'lat' in el else el.get('center')
        if not kind or not pos or not t.get('name') or (kind, t['name']) in seen:  # 同名（建物と駐車場など）は 1 件に
            continue
        seen.add((kind, t['name']))
        out.append({'name': t['name'], 'lat': pos['lat'], 'lon': pos['lon'], 'kind': kind,
                    'wikipedia': wiki_url(t.get('wikipedia'))})
    return out


def refresh_pois(cfg, status, fetch, now):
    last = status.get('pois_at')
    if last and now - dt.datetime.fromisoformat(last) < dt.timedelta(days=7):
        return
    try:
        body = urllib.parse.urlencode({'data': overpass_query(cfg['origin'], cfg['poiRadiusKm'])}).encode()
        pois = parse_overpass(fetch('https://overpass-api.de/api/interpreter', data=body, timeout=240))  # 1〜2 分かかる
        save(os.path.join(DATA, 'pois.json'), pois)
        status['pois_at'], status['pois_error'] = now.isoformat(timespec='seconds'), None
        print(f'pois: {len(pois)}')
    except Exception as err:  # 失敗したら前回の pois.json を残す
        status['pois_error'] = f'{type(err).__name__}: {err}'[:300]
        print(f'[pois] {status["pois_error"]}', file=sys.stderr)

# ---- 自動収集スポット（OpenStreetMap。厳選リストとは別ファイル） ----

# 種類ごとに分けて取得する（1 回にまとめると Overpass が 504 を返すため）
SPOT_QUERIES = [
    ('museum', 'nwr["tourism"~"^(museum|gallery)$"]["name"]'),
    ('attraction', 'nwr["tourism"="attraction"]["name"]'),
    ('park', 'nwr["tourism"~"^(theme_park|zoo|aquarium)$"]["name"]'),
    ('viewpoint', 'nwr["tourism"="viewpoint"]["name"]'),
    ('garden', 'nwr["leisure"="garden"]["name"]'),
    ('bigpark', 'nwr["leisure"="park"]["name"]["wikipedia"]'),
    ('temple', 'nwr["amenity"="place_of_worship"]["name"]["wikipedia"]'),
    ('bath', 'nwr["amenity"="public_bath"]["name"]'),
    ('shop', 'nwr["shop"~"^(mall|department_store)$"]["name"]'),
    ('play', 'nwr["leisure"~"^(water_park|amusement_arcade|trampoline_park|miniature_golf)$"]["name"]'),
    ('planetarium', 'nwr["amenity"="planetarium"]["name"]'),
]
VEHICLE_WORDS = re.compile('鉄道|電車|機関車|航空|飛行|宇宙|ロケット|自動車|クルマ|モーター|バイク|オートバイ|船|交通|乗り物')


def osm_genre(t):
    """タグ → (genres, 屋内か, 種類の表示名)。対象外は None。"""
    tour, leis, amen = t.get('tourism'), t.get('leisure'), t.get('amenity')
    if tour in ('museum', 'gallery'):
        g = (['museum'], True, '美術館' if tour == 'gallery' else '博物館')
    elif amen == 'planetarium':
        g = (['museum'], True, 'プラネタリウム')
    elif tour == 'aquarium':
        g = (['play'], True, '水族館')
    elif tour == 'zoo':
        g = (['play'], False, '動物園')
    elif tour == 'theme_park':
        g = (['play'], False, '遊園地・テーマパーク')
    elif tour == 'viewpoint':
        g = (['scenic'], False, '展望台')
    elif tour == 'attraction':
        g = (['sightseeing'], False, '観光名所')
    elif leis == 'garden':
        g = (['garden'], False, '庭園')
    elif leis == 'park':
        g = (['play'], False, '公園')
    elif leis in ('amusement_arcade', 'trampoline_park'):
        g = (['play'], True, '屋内の遊び場')
    elif leis in ('water_park', 'miniature_golf'):
        g = (['play'], False, 'プール・遊び場')
    elif amen == 'place_of_worship':
        g = (['temple'], False, '寺社')
    elif amen == 'public_bath':
        g = (['onsen'], True, '温泉' if t.get('bath:type') == 'onsen' else '銭湯・入浴施設')
    elif t.get('shop') in ('mall', 'department_store'):
        g = (['shopping'], True, 'ショッピング')
    else:
        return None
    if VEHICLE_WORDS.search(t['name']) or t.get('museum') in ('railway', 'transport', 'aviation', 'technology'):
        g = (['vehicle'] + g[0], g[1], g[2])
    return g


def parse_osm_spots(text, exclude_names=frozenset(), kind=None, seen=None):
    seen = set() if seen is None else seen
    out = []
    for el in json.loads(text)['elements']:
        t = el.get('tags', {})
        pos = el if 'lat' in el else el.get('center')
        if not t.get('name') or not pos or t['name'] in exclude_names:
            continue
        g = osm_genre(t)
        key = (t['name'], round(pos['lat'], 3), round(pos['lon'], 3))  # 建物と敷地など、近くの同名は 1 件に
        if not g or key in seen:
            continue
        seen.add(key)
        site = t.get('website', '')
        pref = re.sub('[都府県]$', '', t.get('addr:province', '')) or None
        out.append({'id': f"osm:{el['type']}:{el['id']}", 'name': t['name'], 'lat': round(pos['lat'], 5),
                    'lon': round(pos['lon'], 5), 'pref': pref, 'genres': g[0], 'indoor': g[1],
                    'url': site if site.startswith(('http://', 'https://')) else wiki_url(t.get('wikipedia')) or '',
                    'note': g[2], 'k': kind})
    return out


def refresh_spots(cfg, status, fetch, now, old, exclude_names, sleep=time.sleep):
    """週 1 回だけ取り直す。失敗した種類は前回分を残す。取り直さないときは None。"""
    last = status.get('spots_at')
    if last and now - dt.datetime.fromisoformat(last) < dt.timedelta(days=7):
        return None
    bb, seen, out, errors = bbox(cfg['origin'], cfg['poiRadiusKm']), set(), [], []
    for i, (kind, q) in enumerate(SPOT_QUERIES):
        if i:
            sleep(5)  # Overpass への配慮
        body = urllib.parse.urlencode({'data': f'[out:json][timeout:180];{q}{bb};out center tags;'}).encode()
        for attempt in (1, 2):
            try:
                out += parse_osm_spots(fetch('https://overpass-api.de/api/interpreter', data=body, timeout=240),
                                       exclude_names, kind, seen)
                break
            except Exception as err:
                if attempt == 1:
                    sleep(30)  # 混雑（429/504）は少し待って 1 回だけ再試行
                    continue
                errors.append(f'{kind}: {type(err).__name__}: {err}'[:120])
                out += [s for s in old if s.get('k') == kind]
    status['spots_at'] = now.isoformat(timespec='seconds')
    status['spots_error'] = ' / '.join(errors) or None
    if errors:
        print(f"[spots] {status['spots_error']}", file=sys.stderr)
    return out


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


def merge_spans(events):
    """月をまたぐ一覧ページで分かれた同じイベント（同 URL・同タイトル）を 1 件にまとめる。"""
    merged = {}
    for e in events:
        m = merged.setdefault((e['url'], e['title']), e)
        m['start'], m['end'] = min(m['start'], e['start']), max(m['end'], e['end'])
    return list(merged.values())


def finalize(events, today, months_ahead):
    first, last = today.isoformat(), (today + dt.timedelta(days=31 * months_ahead)).isoformat()
    seen, out = set(), []
    for e in sorted(events, key=lambda x: (x['start'], x['title'])):
        key = (e['title'], e['start'])
        bad_url = not str(e['url']).startswith(('http://', 'https://'))  # javascript: 等は表示しない
        if key in seen or bad_url or e['end'] < first or e['start'] > last:
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
            got = merge_spans(got)
            if not got and any(e['source'] == src['id'] and e['end'] >= today.isoformat() for e in old_events):
                raise ValueError('0件（ページ構造の変化の可能性）')
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


def save(path, obj, compact=False):
    tmp = path + '.tmp'  # 書きかけで壊さないよう、一時ファイルから置き換える
    with open(tmp, 'w', encoding='utf-8') as f:
        if compact:  # 1 万件超のファイルは 1 行 1 件で小さく
            f.write('[\n' + ',\n'.join(json.dumps(x, ensure_ascii=False, separators=(',', ':')) for x in obj) + '\n]\n')
        else:
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
    refresh_pois(cfg, status, fetch, dt.datetime.now(JST))
    curated = {s['name'] for s in load(os.path.join(DATA, 'spots.json'), [])}
    spots = refresh_spots(cfg, status, fetch, dt.datetime.now(JST), load(os.path.join(DATA, 'osm_spots.json'), []), curated)
    if spots is not None:
        save(os.path.join(DATA, 'osm_spots.json'), spots, compact=True)
        print(f'osm spots: {len(spots)}')
    status['updated_at'] = now_iso()
    save(os.path.join(DATA, 'status.json'), status)
    print(f'events: {len(events)}')


if __name__ == '__main__':
    main()
