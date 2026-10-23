"""MyMap 収集スクリプト。

使い方: python collector/collect.py（OpenStreetMap の処理に pyosmium が要る: pip install osmium）
config.json の sources のイベントを取得し、週 1 回は全国の OpenStreetMap データから立ち寄り候補・スポット・
グルメなどを作り直して data/ に書き出す。MYMAP_PBF に .osm.pbf のパスを入れると、ダウンロードせずにそれを使う（試験用）。
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
# 会場名・タイトルの語 → 屋内か（上から順に最初に当たったもの。屋内の具体語 → 屋外の語 → 広い語の順）
INDOOR_WORDS = [
    ('体育館', True), ('ホール', True), ('劇場', True), ('文化センター', True), ('公民館', True), ('図書館', True),
    ('博物館', True), ('美術館', True), ('プラネタリウム', True), ('プレイス', True), ('たづくり', True), ('会館', True),
    ('児童館', True), ('児童センター', True), ('歴史館', True), ('資料館', True), ('資料室', True), ('ミュージアム', True),
    ('MUSEUM', True), ('ショールーム', True), ('会議室', True), ('学習館', True), ('集会所', True), ('温水プール', True),
    ('アリーナ', True), ('保健センター', True),
    ('スタジアム', False), ('競技場', False), ('公園', False), ('広場', False), ('グラウンド', False),
    ('河川敷', False), ('ハイキング', False), ('マルシェ', False), ('まつり', False), ('祭り', False),
    ('テニスコート', False), ('農園', False), ('キャンプ', False), ('森', False),
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


# ---- 立ち寄り候補・絶景（OpenStreetMap）。条件は Overpass の文の形で書き、osm_pbf が解釈する ----
POI_QUERIES = [
    ('michinoeki', ['nwr["name"~"^道の駅"]']),
    ('onsen', ['nwr["amenity"="public_bath"]["bath:type"="onsen"]["name"]']),
    ('viewpoint', ['nwr["tourism"="viewpoint"]["name"]']),
    ('scenic', ['nwr["waterway"="waterfall"]["name"]["wikipedia"]',
                'nwr["natural"~"^(peak|valley|gorge|beach|cape)$"]["name"]["wikipedia"]',
                'nwr["natural"="water"]["water"="lake"]["name"]["wikipedia"]']),
    # 24 時間営業のガソリンスタンド（深夜のツーリング・ドライブ用）。名前がなくてもブランド名で出す
    ('fuel24', ['nwr["amenity"="fuel"]["opening_hours"~"^(24/7|Mo-Su 00:00-24:00)$"]']),
]


def extra_tags(t):
    """営業時間・電話番号・車いす対応（あるものだけ。ファイルを小さくするため）。"""
    out = {}
    if t.get('opening_hours'):
        out['oh'] = t['opening_hours'][:120]
    tel = t.get('phone') or t.get('contact:phone')
    if tel:
        out['tel'] = tel.split(';')[0].strip()[:20]
    if t.get('wheelchair') in ('yes', 'limited', 'no'):
        out['wc'] = t['wheelchair']
    return out


def poi_kind(t):
    name = t.get('name') or ''
    if name.startswith('道の駅'):
        bus = t.get('highway') == 'bus_stop' or 'public_transport' in t or name.endswith(('入口', '前'))
        return None if bus else 'michinoeki'
    if t.get('amenity') == 'public_bath':
        return 'onsen'
    if t.get('amenity') == 'fuel':
        return 'fuel24'
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


def overpass_elements(text):
    """要素のリスト（osm_pbf の結果）はそのまま。Overpass の JSON は、実行時エラー（タイムアウト等）でも
    200 と空の結果を返すので、remark を見て例外にする。"""
    if isinstance(text, list):
        return text
    data = json.loads(text)
    remark = data.get('remark') or ''
    if 'error' in remark.lower():
        raise RuntimeError(remark[:200])
    return data['elements']


def parse_overpass(text):
    seen, out = set(), []
    for el in overpass_elements(text):
        t = el.get('tags', {})
        kind = poi_kind(t)
        pos = el if 'lat' in el else el.get('center')
        if kind == 'fuel24':  # 同じブランド名が多いので、名前と位置で 1 件に
            if not pos:
                continue
            name = t.get('name') or t.get('brand') or t.get('operator') or 'ガソリンスタンド'
            key = (kind, name, round(pos['lat'], 3), round(pos['lon'], 3))
            if key in seen:
                continue
            seen.add(key)
            x = {'name': name[:40], 'lat': round(pos['lat'], 5), 'lon': round(pos['lon'], 5), 'kind': kind, 'oh': '24/7'}
            if t.get('self_service') in ('yes', 'no'):
                x['self'] = 1 if t['self_service'] == 'yes' else 0
            if t.get('brand') and t['brand'] not in name:
                x['brand'] = t['brand'][:20]
            out.append(x)
            continue
        if not kind or not pos or not t.get('name'):
            continue
        # 同じ名前で 1km ほどの範囲（建物と駐車場など）は 1 件に。全国では同じ名前の別の場所（「展望台」など）が多いので位置も見る
        key = (kind, t['name'], round(pos['lat'], 2), round(pos['lon'], 2))
        if key in seen:
            continue
        seen.add(key)
        out.append({'name': t['name'], 'lat': pos['lat'], 'lon': pos['lon'], 'kind': kind,
                    'wikipedia': wiki_url(t.get('wikipedia')), **extra_tags(t)})
    return out


# ---- 自動収集スポット（OpenStreetMap。厳選リストとは別ファイル） ----
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
    # 休日に出かける先になる大型店（IKEA・コストコ）。家具店・倉庫店として登録されているので、ブランドで拾う
    ('bigstore', 'nwr["brand:wikidata"~"^(Q54078|Q715583)$"]["shop"]["name"]'),
    # 温泉: 入浴施設の印（public_bath）がない温泉もある（温泉の印・源泉や地獄・名前に温泉の入ったサウナや宿として登録）
    ('onsen', ['nwr["leisure"="hot_spring"]["name"]', 'nwr["amenity"="spa"]["name"]',
               'nwr["natural"~"^(hot_spring|spring)$"]["name"~"温泉|湯|地獄"]', 'nwr["leisure"="sauna"]["name"~"温泉|の湯"]',
               'nwr["tourism"~"^(hotel|guest_house|hostel|motel)$"]["name"~"温泉"]']),
    # 体験: 脱出ゲーム・カート/サーキット・ボルダリング・陶芸/ガラス工房・果物狩り/牧場
    ('experience', ['nwr["leisure"="escape_game"]["name"]', 'nwr["sport"~"karting|motor|climbing"]["name"]',
                    'nwr["craft"~"^(pottery|glassblower|handicraft)$"]["name"]',
                    'nwr["landuse"~"^(orchard|farmyard|farmland|vineyard|meadow)$"]["name"~"狩|摘み|観光農園|体験農園|果樹園|ぶどう園|いちご園|ブルーベリー|牧場"]']),
]
FARM_WORDS = re.compile('狩|摘み|観光農園|体験農園|果樹園|ぶどう園|いちご園|ブルーベリー|牧場')
CRAFT = {'pottery': '陶芸体験', 'glassblower': 'ガラス工房', 'handicraft': '工芸体験'}
BIG_STORES = {'Q54078': 'IKEA（家具・雑貨。スウェーデン料理のレストランも）', 'Q715583': 'コストコ（会員制の大型倉庫店）'}
VEHICLE_WORDS = re.compile('鉄道|電車|機関車|航空|飛行|宇宙|ロケット|自動車|クルマ|モーター|バイク|オートバイ|船|交通|乗り物')


PREFS = ('北海道 青森 岩手 宮城 秋田 山形 福島 茨城 栃木 群馬 埼玉 千葉 東京 神奈川 新潟 富山 石川 福井 山梨 長野 岐阜 静岡 愛知 三重 '
         '滋賀 京都 大阪 兵庫 奈良 和歌山 鳥取 島根 岡山 広島 山口 徳島 香川 愛媛 高知 福岡 佐賀 長崎 熊本 大分 宮崎 鹿児島 沖縄').split()
PROVINCE_ROMAJI = {'tokyo': '東京', 'kanagawa': '神奈川', 'saitama': '埼玉', 'chiba': '千葉', 'yamanashi': '山梨'}


def norm_province(v):
    """都道府県名（境界の name や addr:province）→ 表示名（「東京都」→「東京」、北海道はそのまま）。知らない値は None。"""
    v = (v or '').strip()
    name = v if v == '北海道' else re.sub('[都府県]$', '', v)
    return name if name in PREFS else PROVINCE_ROMAJI.get(v.lower())


def osm_genre(t):
    """タグ → (genres, 屋内か, 種類の表示名)。対象外は None。"""
    tour, leis, amen, name = t.get('tourism'), t.get('leisure'), t.get('amenity'), t.get('name', '')
    if leis == 'hot_spring' or amen == 'spa':
        g = (['onsen'], True, '温泉')
    elif t.get('natural') in ('hot_spring', 'spring') and re.search('温泉|湯|地獄', name):
        g = (['onsen', 'scenic'], False, '地獄（源泉の見学）') if '地獄' in name else (['onsen'], False, '温泉')
    elif leis == 'sauna' and re.search('温泉|の湯', name):
        g = (['onsen'], True, '入浴施設（サウナ）')
    elif tour in ('hotel', 'guest_house', 'hostel', 'motel') and '温泉' in name:
        g = (['onsen'], True, '温泉宿（日帰り入浴は要確認）')
    elif tour == 'attraction' and '温泉' in name:
        g = (['onsen', 'sightseeing'], False, '温泉')
    elif tour in ('museum', 'gallery'):
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
    elif leis == 'escape_game':
        g = (['experience', 'play'], True, '謎解き・脱出ゲーム')
    elif re.search('karting|motor', t.get('sport', '')):
        g = (['experience', 'vehicle'], False, 'カート・サーキット')
    elif 'climbing' in t.get('sport', ''):
        g = (['experience'], leis == 'sports_centre', 'ボルダリング・クライミング')
    elif t.get('craft') in CRAFT:
        g = (['experience'], True, CRAFT[t['craft']])
    elif t.get('landuse') and FARM_WORDS.search(t['name']):
        g = (['experience', 'outdoor'], False, '牧場' if '牧場' in t['name'] else '果物狩り・観光農園')
    elif amen == 'place_of_worship':
        g = (['temple'], False, '寺社')
    elif amen == 'public_bath':
        g = (['onsen'], True, '温泉' if t.get('bath:type') == 'onsen' else '銭湯・入浴施設')
    elif t.get('brand:wikidata') in BIG_STORES and t.get('shop'):
        g = (['shopping'], True, BIG_STORES[t['brand:wikidata']])
    elif t.get('shop') in ('mall', 'department_store'):
        g = (['shopping'], True, 'ショッピング')
    else:
        return None
    if VEHICLE_WORDS.search(t['name']) or t.get('museum') in ('railway', 'transport', 'aviation', 'technology'):
        g = (['vehicle'] + g[0], g[1], g[2])
    return g


# ローマ字（name:ja_rm・name:ja-Latn・name:en）→ ひらがな。読み（name:ja-Hira など）のない施設もひらがなで探せるように
ROMAJI = {}
for _row, _kana in (('', 'あいうえお'), ('k', 'かきくけこ'), ('g', 'がぎぐげご'), ('s', 'さしすせそ'), ('z', 'ざじずぜぞ'), ('t', 'たちつてと'),
                    ('d', 'だぢづでど'), ('n', 'なにぬねの'), ('h', 'はひふへほ'), ('b', 'ばびぶべぼ'), ('p', 'ぱぴぷぺぽ'), ('m', 'まみむめも'),
                    ('r', 'らりるれろ')):
    ROMAJI.update({_row + v: k for v, k in zip('aiueo', _kana)})
ROMAJI.update({'ya': 'や', 'yu': 'ゆ', 'yo': 'よ', 'wa': 'わ', 'wo': 'を', 'shi': 'し', 'chi': 'ち', 'tsu': 'つ', 'fu': 'ふ', 'ji': 'じ',
               'she': 'しぇ', 'je': 'じぇ', 'che': 'ちぇ', 'fa': 'ふぁ', 'fi': 'ふぃ', 'fe': 'ふぇ', 'fo': 'ふぉ'})
for _c, _k in (('ky', 'き'), ('gy', 'ぎ'), ('sh', 'し'), ('sy', 'し'), ('j', 'じ'), ('zy', 'じ'), ('ch', 'ち'), ('ty', 'ち'), ('ny', 'に'),
               ('hy', 'ひ'), ('by', 'び'), ('py', 'ぴ'), ('my', 'み'), ('ry', 'り')):
    ROMAJI.update({_c + v: _k + s for v, s in (('a', 'ゃ'), ('u', 'ゅ'), ('o', 'ょ'))})
LONG_VOWELS = (('ā', 'aa'), ('ī', 'ii'), ('ū', 'uu'), ('ē', 'ei'), ('ō', 'ou'), ('â', 'aa'), ('î', 'ii'), ('û', 'uu'), ('ê', 'ei'), ('ô', 'ou'))


def romaji_to_kana(s):
    """全部が日本語の音として読めたときだけひらがなにする（"Nobeha No Yu" → のべはのゆ。"Beppu Tower" のような英語は None）。"""
    if not s:
        return None
    s = s.lower()
    for a, b in LONG_VOWELS:
        s = s.replace(a, b)
    out = []
    for w in re.split(r"[\s\-'’.,・()]+", s):
        if not w:
            continue
        if not re.fullmatch('[a-z]+', w):
            return None
        i = 0
        while i < len(w):
            c = w[i]
            if c == 'n' and (i + 1 == len(w) or w[i + 1] not in 'aiueoy'):
                out.append('ん')
                i += 1
            elif (c == w[i + 1:i + 2] and c not in 'aiueon') or (c == 't' and w[i + 1:i + 3] == 'ch'):
                out.append('っ')  # 促音（tt・kk・pp・ss・tch）
                i += 1
            else:
                for n in (3, 2, 1):
                    k = ROMAJI.get(w[i:i + n])
                    if k:
                        out.append(k)
                        i += n
                        break
                else:
                    return None
    return ''.join(out) or None


def show_name(name):
    """OpenStreetMap で複数の値を区切る「;」は空白に（「温泉銭湯;夢元さぎり湯」→「温泉銭湯 夢元さぎり湯」）。"""
    return ' '.join(x.strip() for x in name.split(';') if x.strip())


def name_kana(t):
    """名前の読み（ひらがな・カタカナ）。読みのタグがなければローマ字の名前から。"""
    return (t.get('name:ja-Hira') or t.get('name:ja_kana') or t.get('name:ja-Hrkt')
            or romaji_to_kana(t.get('name:ja_rm') or t.get('name:ja-Latn')) or romaji_to_kana(t.get('name:en')))


def parse_osm_spots(text, exclude_names=frozenset(), kind=None, seen=None):
    seen = set() if seen is None else seen
    out = []
    for el in overpass_elements(text):
        t = el.get('tags', {})
        pos = el if 'lat' in el else el.get('center')
        if not t.get('name') or not pos or t['name'] in exclude_names:
            continue
        g = osm_genre(t)
        big = t.get('brand:wikidata') in BIG_STORES
        # 建物と敷地など、近くの同名は 1 件に（IKEA・コストコは店の点と建物が離れていることがあるので約 1km 四方で）
        key = (t['brand:wikidata'], round(pos['lat'], 2), round(pos['lon'], 2)) if big else (t['name'], round(pos['lat'], 3), round(pos['lon'], 3))
        if not g or key in seen:
            continue
        seen.add(key)
        site = t.get('website', '')
        name = show_name(t['name'])
        if big and t.get('branch') and t['branch'] not in name:
            name = f"{name} {t['branch']}"  # 「IKEA」だけの名前に支店名（立川など）を足す
        spot = {'id': f"osm:{el['type']}:{el['id']}", 'name': name, 'lat': round(pos['lat'], 5),
                'lon': round(pos['lon'], 5), 'pref': norm_province(t.get('addr:province')), 'genres': g[0], 'indoor': g[1],
                'url': site if site.startswith(('http://', 'https://')) else wiki_url(t.get('wikipedia')) or '',
                'note': g[2], 'k': kind}
        kana = name_kana(t)
        if kana:  # 読みでの名前検索用（ないものはファイルを小さくするため付けない）
            spot['kana'] = kana
        spot.update(extra_tags(t))
        out.append(spot)
    return out


# ---- ドライブコース（OpenStreetMap）: 名前付きの観光道路（同じ名前の断片をつないで 1 本に）と峠 ----
ROAD_WORDS = 'スカイライン|パークウェイ|ターンパイク|ライン$|有料道路|峠|林道|シーサイド|湖畔|高原|観光道路|周遊|ロード$'
ROAD_QUERIES = [
    ('road', f'way["highway"~"^(trunk|primary|secondary|tertiary|unclassified)$"]["name"~"{ROAD_WORDS}"]'),
    ('pass', 'node["mountain_pass"="yes"]["name"]'),
]
ROAD_MIN_KM = 2


def km_ll(a, b):
    """[lat, lon] どうしの距離（km）。"""
    dy, dx = (a[0] - b[0]) * 111, (a[1] - b[1]) * 111 * math.cos(math.radians(a[0]))
    return math.hypot(dx, dy)


def bearing_ll(a, b):
    y = math.sin(math.radians(b[1] - a[1])) * math.cos(math.radians(b[0]))
    x = math.cos(math.radians(a[0])) * math.sin(math.radians(b[0])) - math.sin(math.radians(a[0])) * math.cos(math.radians(b[0])) * math.cos(math.radians(b[1] - a[1]))
    return math.degrees(math.atan2(y, x)) % 360


def curviness(path):
    """カーブの多さ: 100m おきに間引いて、1km あたりの向きの変化の合計（度）。lib.js の curviness と同じ。"""
    pts = [path[0]]
    for q in path:
        if km_ll(pts[-1], q) >= 0.1:
            pts.append(q)
    turn = km = 0
    for i in range(1, len(pts)):
        km += km_ll(pts[i - 1], pts[i])
        if i >= 2:
            turn += abs((bearing_ll(pts[i - 1], pts[i]) - bearing_ll(pts[i - 2], pts[i - 1]) + 540) % 360 - 180)
    return turn / km if km > 0.5 else 0


def road_note(name):
    for pat, label in (('スカイライン|パークウェイ|ターンパイク|観光道路|ライン$', 'スカイライン・観光道路'), ('林道', '林道（未舗装の区間がないか確認を）'),
                       ('峠', '峠道'), ('有料道路', '有料道路'), ('シーサイド|湖畔', '海沿い・湖畔の道'), ('高原', '高原の道')):
        if re.search(pat, name):
            return label
    return '景色の道'


def parse_road_parts(text, kind):
    """way → {name, coords, toll, wid}、峠の node → そのままコース（目的地として使う）。"""
    out = []
    for el in overpass_elements(text):
        t = el.get('tags', {})
        if not t.get('name'):
            continue
        if kind == 'pass' and 'lat' in el:
            ele = t.get('ele', '').split('.')[0]
            out.append({'id': f"osm:node:{el['id']}", 'name': t['name'], 'points': [[round(el['lat'], 4), round(el['lon'], 4)]],
                        'pass': True, 'note': f"峠{'（標高' + ele + 'm）' if ele.isdigit() else ''}", 'k': 'pass'})
        elif kind == 'road' and el.get('geometry'):
            out.append({'wid': el['id'], 'name': t['name'], 'toll': t.get('toll') == 'yes',
                        'coords': [[g['lat'], g['lon']] for g in el['geometry']]})
    return out


def road_core(name):
    """比べる用の名前: かっこ書きと空白を除く。"""
    return re.sub(r'[（(].*?[)）]|\s', '', name)


def build_roads(parts, curated=(), k=6):
    """同じ名前で端どうしがつながる断片を 1 本にまとめ、走る順に並べて k 点に間引く。短い道・厳選と同じ道は除く。"""
    by_name = {}
    for p in parts:
        by_name.setdefault(p['name'], []).append(p)
    roads = []
    for name, segs in by_name.items():
        # 端が 1km 以内でつながる断片を同じ道に（union-find）
        parent = list(range(len(segs)))

        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i
        ends = [(s['coords'][0], s['coords'][-1]) for s in segs]
        for i in range(len(segs)):
            for j in range(i + 1, len(segs)):
                if min(km_ll(a, b) for a in ends[i] for b in ends[j]) < 1:
                    parent[find(i)] = find(j)
        groups = {}
        for i, s in enumerate(segs):
            groups.setdefault(find(i), []).append(s)
        for g in groups.values():
            # 中心からいちばん遠い端から、近い断片を順につないでいく
            allpts = [c for s in g for c in s['coords']]
            mid = [sum(c[0] for c in allpts) / len(allpts), sum(c[1] for c in allpts) / len(allpts)]
            cur = max((e for s in g for e in (s['coords'][0], s['coords'][-1])), key=lambda e: km_ll(e, mid))
            path, rest = [], list(g)
            while rest:
                s = min(rest, key=lambda s: min(km_ll(cur, s['coords'][0]), km_ll(cur, s['coords'][-1])))
                # 300m 以上離れた断片へは飛ばない（枝道や離れた同名の道に飛ぶと、ルートが行って戻る形になるため）
                if path and min(km_ll(cur, s['coords'][0]), km_ll(cur, s['coords'][-1])) > 0.3:
                    break
                rest.remove(s)
                cs = s['coords'] if km_ll(cur, s['coords'][0]) <= km_ll(cur, s['coords'][-1]) else s['coords'][::-1]
                path += cs
                cur = cs[-1]
            # 上下線が別の道だと「行って戻る」並びになるので、始点からいちばん遠い所で切る
            far = max(range(len(path)), key=lambda i: km_ll(path[0], path[i]))
            if km_ll(path[0], path[-1]) < 0.5 * km_ll(path[0], path[far]):
                path = path[:far + 1]
            cum = [0]
            for a, b in zip(path, path[1:]):
                cum.append(cum[-1] + km_ll(a, b))
            if cum[-1] < ROAD_MIN_KM:
                continue
            pts = []
            for j in range(k):
                target = cum[-1] * j / (k - 1)
                i = next(i for i, d in enumerate(cum) if d >= target - 1e-9)
                pts.append([round(path[i][0], 4), round(path[i][1], 4)])
            core = road_core(name)
            if any((core in road_core(c['name']) or road_core(c['name']) in core)
                   and min(km_ll(p, q) for p in pts for q in c['points']) < 10 for c in curated):
                continue
            roads.append({'id': f"osm:way:{min(s['wid'] for s in g)}", 'name': name, 'points': pts,
                          'toll': any(s['toll'] for s in g), 'note': f'{road_note(name)}（約{round(cum[-1])}km）',
                          'km': round(cum[-1], 1), 'curv': round(curviness(path)), 'k': 'road'})
    return roads


# ---- バイクを止められる場所（週 1 回まとめて集め、アプリはその場で検索しなくても出せるように） ----
MOTO_NAME = 'バイク|二輪|オートバイ|原付|モーターサイクル|ﾊﾞｲｸ|タイムズのB|モトパーク|バイクパーク'
MOTO_QUERIES = [
    ('moto_dedicated', 'nwr["amenity"="motorcycle_parking"]'),
    ('moto_tagged', ['nwr["amenity"~"^(parking|bicycle_parking)$"]["motorcycle"~"^(yes|designated|permissive)$"]',
                     'nwr["amenity"~"^(parking|bicycle_parking)$"]["moped"~"^(yes|designated)$"]',
                     'nwr["amenity"~"^(parking|bicycle_parking)$"]["capacity:motorcycle"]']),
    ('moto_named', f'nwr["amenity"~"^(parking|bicycle_parking|motorcycle_parking)$"]["name"~"{MOTO_NAME}"]'),
    ('rest_area', 'nwr["highway"~"^(services|rest_area)$"]["name"]'),  # 高速の SA・PA（たいてい二輪の区画がある）
]


def parse_moto(text, kind):
    """バイクを止められる場所。私有（access=private/no）は除く。SA・PA は「たいてい止められる」として likely。"""
    out = []
    for el in overpass_elements(text):
        t = el.get('tags', {})
        pos = el if 'lat' in el else el.get('center')
        if not pos or t.get('access') in ('private', 'no') or t.get('motorcycle') == 'no':
            continue
        am = t.get('amenity')
        label = ('SA・PA' if kind == 'rest_area' else 'バイク専用' if am == 'motorcycle_parking'
                 else '駐輪場（二輪可）' if am == 'bicycle_parking' else '駐車場（二輪可）')
        x = {'id': f"osm:{el['type']}:{el['id']}", 'name': t.get('name') or t.get('operator') or '', 'lat': round(pos['lat'], 5),
             'lon': round(pos['lon'], 5), 'type': label, 'k': kind}
        if kind == 'rest_area':
            x['likely'] = True
        if t.get('fee') in ('yes', 'no'):
            x['fee'] = '有料' if t['fee'] == 'yes' else '無料'
        cap = t.get('capacity:motorcycle') or (t.get('capacity') if am == 'motorcycle_parking' else '')
        if str(cap).isdigit():
            x['cap'] = int(cap)
        if t.get('moped') in ('yes', 'designated') and t.get('motorcycle') not in ('yes', 'designated'):
            x['moped'] = True  # 原付だけの可能性
        if t.get('opening_hours'):
            x['oh'] = t['opening_hours'][:80]
        out.append(x)
    return out


PARK_QUERIES = [('parking', 'nwr["amenity"="parking"]["access"!~"^(private|no)$"]')]


def parse_parking(text, kind):
    """駐車場を小さい形に: la/lo 位置、n 名前、f 料金(1 有料/0 無料)、c 台数、cm 二輪台数、m 二輪(1 可/0 不可)、a 利用者用、t 種類、k 種類（収集の区別）。"""
    out = []
    for el in overpass_elements(text):
        t = el.get('tags', {})
        pos = el if 'lat' in el else el.get('center')
        if not pos or t.get('access') in ('private', 'no'):
            continue
        x = {'la': round(pos['lat'], 5), 'lo': round(pos['lon'], 5), 'k': kind}
        name = t.get('name') or t.get('operator')
        if name:
            x['n'] = name[:40]
        if t.get('fee') in ('yes', 'no'):
            x['f'] = 1 if t['fee'] == 'yes' else 0
        for src, dst in (('capacity', 'c'), ('capacity:motorcycle', 'cm')):
            if str(t.get(src, '')).isdigit():
                x[dst] = int(t[src])
        if t.get('motorcycle') in ('yes', 'designated', 'permissive', 'no'):
            x['m'] = 0 if t['motorcycle'] == 'no' else 1
        if t.get('access') == 'customers':
            x['a'] = 1
        if t.get('parking') in ('multi-storey', 'underground'):
            x['t'] = 'ms' if t['parking'] == 'multi-storey' else 'ug'
        out.append(x)
    return out


def load_park(root):
    out = []
    base = os.path.join(root, 'park')
    for name in os.listdir(base) if os.path.isdir(base) else []:
        if name.endswith('.json') and name != 'index.json':
            out += load(os.path.join(base, name), [])
    return out


def save_park(root, items):
    """升目ごとに保存（消えた升目のファイルは残さない）。index.json は {升目: 件数}。"""
    import shutil
    base = os.path.join(root, 'park')
    if os.path.isdir(base):
        shutil.rmtree(base)
    os.makedirs(base)
    by = {}
    for x in items:
        by.setdefault(cell_id(x['la'], x['lo']), []).append(x)
    for cid, xs in by.items():
        save(os.path.join(base, f'{cid}.json'), xs, compact=True)
    save(os.path.join(base, 'index.json'), {cid: len(xs) for cid, xs in by.items()})
    return len(items)


def merge_fsq_parking(root):
    """Foursquare OS Places の駐車場（data/park_fsq.json。Apache-2.0）を駐車場の升目に足す。
    OpenStreetMap の駐車場から 30m 以内のものは重複として足さない。毎回やり直す（k=fsq を入れ替え）。"""
    fsq = load(os.path.join(root, 'park_fsq.json'), [])
    if not fsq:
        return 0
    osm = [p for p in load_park(root) if p.get('k') != 'fsq']
    buckets = {}
    for p in osm:
        buckets.setdefault((round(p['la'] * 100), round(p['lo'] * 100)), []).append(p)

    def dup(x):
        by, bx = round(x['la'] * 100), round(x['lo'] * 100)
        return any(km_ll([x['la'], x['lo']], [p['la'], p['lo']]) < 0.03
                   for dy in (-1, 0, 1) for dx in (-1, 0, 1) for p in buckets.get((by + dy, bx + dx), ()))
    added = [{**x, 'k': 'fsq'} for x in fsq if not dup(x)]
    save_park(root, osm + added)
    return len(added)


def park_core(name):
    """駐車場名と店名を比べる用: 空白・かっこ・「駐車場」「パーキング」「第1」などを除く。"""
    return re.sub(r'[（(].*?[)）]|\s|駐車場|パーキング|第[一二三四五六七八九1-9]+|[pPＰ]$', '', name or '')


def parking_level(item, buckets):
    """お店の専用駐車場が「名前で確かめられる」とき 2、それ以外は 0（推定はしない）。
    150m 以内に、店名を含む名前の駐車場（例: 「ガスト府中店 駐車場」）があるときだけ。店名は 2 文字以上。"""
    lat, lon, name = item['lat'], item['lon'], park_core(item.get('name'))
    if len(name) < 2:
        return 0
    by, bx = round(lat * 100), round(lon * 100)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            for p in buckets.get((by + dy, bx + dx), ()):
                pn = park_core(p.get('n'))
                if len(pn) >= 2 and (name in pn or pn in name) and km_ll([lat, lon], [p['la'], p['lo']]) <= 0.15:
                    return 2
    return 0


def annotate_parking(root):
    """観光スポット（osm_spots.json）とグルメなど（cells）に pk（駐車場の目安）を書き込む。駐車場のデータがなければ何もしない。"""
    park = load_park(root)
    if not park:
        return 0
    buckets = {}
    for p in park:
        buckets.setdefault((round(p['la'] * 100), round(p['lo'] * 100)), []).append(p)

    def mark(xs):
        n = 0
        for x in xs:
            lv = parking_level(x, buckets)
            if lv:
                x['pk'] = lv
                n += 1
            else:
                x.pop('pk', None)
        return n
    total = 0
    for base in (os.path.join(root, 'area', 'spots'), os.path.join(root, 'cells')):
        for d, _, files in os.walk(base):
            for fn in sorted(files):
                if fn.endswith('.json') and fn != 'index.json':
                    xs = load(os.path.join(d, fn), [])
                    total += mark(xs)
                    save(os.path.join(d, fn), xs, compact=True)
    return total


# ---- 約10万件のデータ（飲食・史跡・宿・お土産・遊び）: 0.25 度四方の升目ごとのファイルに分ける ----
CELL = 4  # 1 度あたりの升目の数（lib.js の cellId と同じ）
SPORTS = {'fitness_centre': 'ジム', 'swimming_pool': 'プール', 'stadium': 'スタジアム', 'sports_hall': '体育館',
          'pitch': 'グラウンド・コート', 'track': '陸上トラック', 'dance': 'ダンス'}
AMUSE = {'karaoke_box': 'カラオケ', 'cinema': '映画館', 'theatre': '劇場・ホール', 'arts_centre': 'アートセンター', 'music_venue': 'ライブハウス'}
HOBBY = {'books': '本屋', 'games': 'ゲーム', 'video_games': 'ゲーム', 'toys': 'おもちゃ', 'anime': 'アニメ・漫画', 'music': 'CD・レコード',
         'musical_instrument': '楽器', 'outdoor': 'アウトドア用品', 'sports': 'スポーツ用品', 'bicycle': '自転車', 'motorcycle': 'バイク用品',
         'hobby': 'ホビー・模型', 'model': 'ホビー・模型', 'craft': '手芸・画材', 'art': '画材・アート', 'frame': '画材・アート',
         'camera': 'カメラ', 'second_hand': '古着・リサイクル', 'antiques': '骨董', 'collector': 'コレクション', 'fishing': '釣具'}
RELIGION = {'shinto': '神社', 'buddhist': '寺', 'christian': '教会'}
# (種類, グループ, Overpass の条件, 細かく分けるか: 半径 75km ごとに 1 辺を分ける)。件数の多い種類は分けないと時間切れになる
CELL_QUERIES = [
    ('restaurant', 'food', 'nwr["amenity"="restaurant"]["name"]', True),
    ('cafe', 'food', 'nwr["amenity"="cafe"]["name"]', True),
    ('fastfood', 'food', 'nwr["amenity"="fast_food"]["name"]', True),
    ('sweets', 'food', ['nwr["shop"~"^(bakery|confectionery|pastry)$"]["name"]', 'nwr["amenity"="ice_cream"]["name"]'], True),
    ('pub', 'food', 'nwr["amenity"~"^(pub|biergarten)$"]["name"]', True),
    ('historic', 'heritage', 'nwr["historic"~"^(castle|ruins|archaeological_site|monument|memorial|fort|manor|city_gate|tomb|building)$"]["name"]', True),
    ('lodging', 'heritage', 'nwr["tourism"~"^(hotel|guest_house|hostel|motel)$"]["name"]', False),
    ('souvenir', 'local', 'nwr["shop"~"^(gift|farm|seafood|wine|deli|tea|cheese)$"]["name"]', False),
    ('market', 'local', 'nwr["amenity"="marketplace"]["name"]', False),
    ('activity', 'local', 'nwr["leisure"~"^(sports_centre|fishing|bowling_alley|marina|horse_riding|ice_rink|golf_course)$"]["name"]', False),
    ('camp', 'local', 'nwr["tourism"~"^(camp_site|caravan_site|picnic_site)$"]["name"]', False),
    # 近所の遊び・寺社・趣味のお店（Wikipedia のある公園・寺社は osm_spots 側にあるので除く）
    ('park', 'play', 'nwr["leisure"~"^(park|playground)$"]["name"][!"wikipedia"]', True),
    ('sports', 'play', f'nwr["leisure"~"^({"|".join(SPORTS)})$"]["name"]', True),
    ('amuse', 'play', f'nwr["amenity"~"^({"|".join(AMUSE)})$"]["name"]', False),
    ('worship', 'temple', 'nwr["amenity"="place_of_worship"]["name"][!"wikipedia"]', True),
    ('hobby', 'hobby', f'nwr["shop"~"^({"|".join(HOBBY)})$"]["name"]', True),
]
CUISINE = {'soba': 'そば', 'udon': 'うどん', 'ramen': 'ラーメン', 'sushi': '寿司', 'japanese': '和食', 'italian': 'イタリアン',
           'chinese': '中華', 'french': 'フレンチ', 'indian': 'カレー', 'curry': 'カレー', 'yakiniku': '焼肉', 'barbecue': '焼肉',
           'pizza': 'ピザ', 'steak_house': 'ステーキ', 'seafood': '海鮮', 'tempura': '天ぷら', 'tonkatsu': 'とんかつ',
           'okonomiyaki': 'お好み焼き', 'korean': '韓国料理', 'burger': 'ハンバーガー', 'coffee_shop': 'カフェ',
           'izakaya': '居酒屋', 'yakitori': '焼き鳥', 'noodle': '麺類', 'donburi': '丼', 'teishoku': '定食', 'unagi': 'うなぎ',
           'gyoza': '餃子', 'thai': 'タイ料理', 'vietnamese': 'ベトナム料理', 'spanish': 'スペイン料理', 'mexican': 'メキシコ料理'}
HISTORIC = {'castle': '城跡', 'ruins': '遺跡', 'archaeological_site': '遺跡', 'monument': '記念碑', 'memorial': '記念碑',
            'fort': '砦跡', 'manor': '屋敷', 'city_gate': '門', 'tomb': '古墳・墓所', 'building': '歴史的建造物'}
INDOOR_LEISURE = ('sports_centre', 'bowling_alley', 'ice_rink')


def cell_id(lat, lon):
    return f'{math.floor(lat * CELL)}_{math.floor(lon * CELL)}'


def group_genre(t):
    """タグ → (グループ, genres, 屋内か, 表示名)。対象外は None。"""
    amen, shop, tour, leis = t.get('amenity'), t.get('shop'), t.get('tourism'), t.get('leisure')
    if amen == 'restaurant':
        first = (t.get('cuisine') or '').split(';')[0].strip()
        return 'food', ['food'], True, CUISINE.get(first, '飲食店')
    if amen == 'cafe':
        return 'food', ['food'], True, 'カフェ'
    if amen == 'fast_food':
        return 'food', ['food'], True, 'ファストフード'
    if shop in ('bakery', 'confectionery', 'pastry'):
        return 'food', ['food', 'shopping'], True, 'パン・お菓子'
    if amen == 'ice_cream':
        return 'food', ['food'], True, 'アイス'
    if amen in ('pub', 'biergarten'):
        return 'food', ['food'], True, '居酒屋'
    if t.get('historic') in HISTORIC:
        return 'heritage', ['heritage'], False, HISTORIC[t['historic']]
    if tour in ('hotel', 'guest_house', 'hostel', 'motel'):
        return 'heritage', ['lodging'], True, '宿'
    if shop in ('gift', 'farm', 'seafood', 'wine', 'deli', 'tea', 'cheese'):
        return 'local', ['souvenir'], True, '直売所' if shop == 'farm' else 'お土産・特産品'
    if amen == 'marketplace':
        return 'local', ['souvenir'], False, '市場'
    if leis in ('sports_centre', 'fishing', 'bowling_alley', 'marina', 'horse_riding', 'ice_rink', 'golf_course'):
        return 'local', ['outdoor'], leis in INDOOR_LEISURE, '遊び・スポーツ'
    if tour in ('camp_site', 'caravan_site', 'picnic_site'):
        return 'local', ['outdoor'], False, 'キャンプ・野外'
    if leis in ('park', 'playground'):
        return 'play', ['play'], False, '公園' if leis == 'park' else '遊び場'
    if leis in SPORTS:
        return 'play', ['outdoor', 'play'], leis in ('fitness_centre', 'sports_hall', 'dance'), SPORTS[leis]
    if amen in AMUSE:
        return 'play', ['play'], True, AMUSE[amen]
    if amen == 'place_of_worship':
        return 'temple', ['temple'], False, RELIGION.get(t.get('religion'), '寺社・教会')
    if shop in HOBBY:
        return 'hobby', ['shopping'], True, HOBBY[shop]
    return None


def parse_group_items(text, seen, kind=None):
    out = []
    for el in overpass_elements(text):
        t = el.get('tags', {})
        pos = el if 'lat' in el else el.get('center')
        g = group_genre(t)
        if not g or not t.get('name') or not pos:
            continue
        key = (t['name'], round(pos['lat'], 3), round(pos['lon'], 3))  # 建物と敷地など、近くの同名は 1 件に
        if key in seen:
            continue
        seen.add(key)
        site = t.get('website', '')
        item = {'id': f"osm:{el['type']}:{el['id']}", 'name': show_name(t['name']), 'lat': round(pos['lat'], 5), 'lon': round(pos['lon'], 5),
                'pref': norm_province(t.get('addr:province')), 'genres': g[1], 'indoor': g[2],
                'url': site if site.startswith(('http://', 'https://')) else '', 'note': g[3], 'g': g[0], 'k': kind}
        if t.get('wikipedia') and ':' in t['wikipedia']:
            item['wp'] = t['wikipedia']
        kana = name_kana(t)
        if kana:
            item['kana'] = kana
        if g[0] == 'food' and (t.get('brand') or t.get('brand:wikidata')):  # チェーンの飲食店（画面では既定で隠す）
            item['chain'] = True
        item.update(extra_tags(t))
        out.append(item)
    return out


def save_cells(root, cells):
    import shutil
    base = os.path.join(root, 'cells')
    if os.path.isdir(base):
        shutil.rmtree(base)  # 消えた升目のファイルを残さない
    index = {}
    for group, by_cell in cells.items():
        os.makedirs(os.path.join(base, group), exist_ok=True)
        for cid, xs in by_cell.items():
            save(os.path.join(base, group, f'{cid}.json'), xs, compact=True)
            index.setdefault(group, {})[cid] = len(xs)
    save(os.path.join(base, 'index.json'), index)
    return sum(sum(v.values()) for v in index.values())


# ---- 全国の OpenStreetMap データ（Geofabrik の日本全体の .osm.pbf）から、上の全種類を週 1 回まとめて作る ----
OSM_PBF_URL = 'https://download.geofabrik.de/asia/japan-latest.osm.pbf'
OSM_VER = 3  # 作り方を変えたら上げる（1 週間以内でも作り直す）。2: 温泉の印・源泉・温泉宿なども温泉に、ローマ字の名前から読み。3: IKEA・コストコ
OSM_PARTS = ('pois', 'spots', 'cells', 'roads', 'moto')  # アプリの COLLECT_PARTS（取れなかった部分の表示）と同じ
PREF_STMT = 'rel["boundary"="administrative"]["admin_level"="4"]'
# 高速道路の分岐（JCT）の名前: ルートの分岐の案内に付ける
JCT_STMT = 'node["highway"="motorway_junction"]["name"~"JCT|ジャンクション"]'
# 要素に残すタグ（全国分を持つので、使うものだけ）
KEEP_TAGS = {'name', 'amenity', 'shop', 'tourism', 'leisure', 'historic', 'natural', 'waterway', 'water', 'landuse', 'craft', 'sport',
             'highway', 'public_transport', 'bath:type', 'religion', 'cuisine', 'brand', 'brand:wikidata', 'operator', 'website',
             'wikipedia', 'opening_hours', 'phone', 'contact:phone', 'wheelchair', 'addr:province', 'name:ja-Hira', 'name:ja_kana',
             'name:ja-Hrkt', 'self_service', 'access', 'fee', 'capacity', 'capacity:motorcycle', 'motorcycle', 'moped', 'parking',
             'toll', 'ele', 'mountain_pass', 'museum', 'name:en', 'name:ja_rm', 'name:ja-Latn', 'branch'}


def osm_queries():
    """[(データ:種類, 条件)]。osm_pbf.Kinds に渡す。"""
    return ([(f'pois:{k}', q) for k, q in POI_QUERIES] + [(f'spots:{k}', q) for k, q in SPOT_QUERIES]
            + [(f'roads:{k}', q) for k, q in ROAD_QUERIES] + [(f'moto:{k}', q) for k, q in MOTO_QUERIES]
            + [(f'park:{k}', q) for k, q in PARK_QUERIES] + [(f'cells:{k}', q) for k, _, q, _ in CELL_QUERIES]
            + [('pref', PREF_STMT), ('jct', JCT_STMT)])


def area_id(lat, lon):
    """地方ごとのファイルの升目（1 度四方）。lib.js の cellsInRadius(o, km, 1) と同じ。"""
    return f'{math.floor(lat)}_{math.floor(lon)}'


def near_curated(curated):
    """厳選スポットと同じ名前で 2km 以内のものか（全国では同じ名前の別の場所が多いので、名前だけでは除かない）。"""
    # 厳選は「夢元さぎり湯（登別温泉）」のように温泉地などを括弧で足していることがあるので、括弧と空白を除いて比べる
    key = lambda n: re.sub(r'[（(][^）)]*[）)]|\s', '', n)
    by = {}
    for c in curated:
        if c.get('name') and c.get('lat') is not None:
            by.setdefault(key(c['name']), []).append([c['lat'], c['lon']])
    return lambda s: any(km_ll([s['lat'], s['lon']], q) < 2 for q in by.get(key(s['name']), ()))


def build_osm(els, curated_spots=(), curated_roads=()):
    """{データ:種類: [要素]} → 各データ。読み書き・通信はしない（試験しやすいように）。
    pois / spots / roads / moto は項目のリスト、park は駐車場のリスト、cells は {グループ: {升目: [項目]}}。"""
    from osm_pbf import PrefIndex
    get = lambda name: els.get(name, [])  # noqa: E731
    prefs = PrefIndex([{'name': norm_province(e['tags'].get('name')), 'rings': e['rings']}
                       for e in get('pref') if e.get('rings') and norm_province(e['tags'].get('name'))])

    def with_pref(xs):
        for x in xs:
            x['pref'] = prefs.get(x['lat'], x['lon']) or x.get('pref') or 'その他'
        return xs
    pois = [dict(p, k=k) for k, _ in POI_QUERIES for p in parse_overpass(get(f'pois:{k}'))]
    seen, is_curated = set(), near_curated(curated_spots)
    spots = with_pref([s for k, _ in SPOT_QUERIES for s in parse_osm_spots(get(f'spots:{k}'), kind=k, seen=seen) if not is_curated(s)])
    roads = build_roads(parse_road_parts(get('roads:road'), 'road'), curated_roads) + parse_road_parts(get('roads:pass'), 'pass')
    moto, ids = [], set()
    for k, _ in MOTO_QUERIES:
        for x in parse_moto(get(f'moto:{k}'), k):
            if x['id'] not in ids:
                ids.add(x['id'])
                moto.append(x)
    park = [x for k, _ in PARK_QUERIES for x in parse_parking(get(f'park:{k}'), k)]
    jct, names = [], set()
    for e in get('jct'):
        name = e['tags']['name'].replace('ジャンクション', 'JCT')
        key = (name, round(e['lat'], 2), round(e['lon'], 2))  # 上下線の分岐は 1 件に
        if key not in names:
            names.add(key)
            jct.append({'name': name, 'lat': round(e['lat'], 5), 'lon': round(e['lon'], 5)})
    seen, cells = set(), {}
    for k, _, _, _ in CELL_QUERIES:
        for x in with_pref(parse_group_items(get(f'cells:{k}'), seen, k)):
            cells.setdefault(x['g'], {}).setdefault(cell_id(x['lat'], x['lon']), []).append(x)
    return {'pois': pois, 'spots': spots, 'roads': roads, 'moto': moto, 'park': park, 'cells': cells, 'jct': jct,
            'prefs': [n for n in prefs.names if n]}


def save_area(root, items):
    """{種類: [項目]} → data/area/<種類>/<1 度の升目>.json と data/area/index.json（{種類: {升目: 件数}}）。
    ドライブコースは始点の升目。アプリは起点から poiRadiusKm 以内の升目だけ読む。"""
    import shutil
    base = os.path.join(root, 'area')
    if os.path.isdir(base):
        shutil.rmtree(base)  # 消えた升目のファイルを残さない
    index = {}
    for kind, xs in items.items():
        by = {}
        for x in xs:
            lat, lon = (x['lat'], x['lon']) if 'lat' in x else x['points'][0]
            by.setdefault(area_id(lat, lon), []).append(x)
        os.makedirs(os.path.join(base, kind))
        for cid, part in by.items():
            save(os.path.join(base, kind, f'{cid}.json'), part, compact=True)
        index[kind] = {cid: len(part) for cid, part in by.items()}
    save(os.path.join(base, 'index.json'), index)
    return {kind: len(xs) for kind, xs in items.items()}


def load_area(root, kind):
    out = []
    base = os.path.join(root, 'area', kind)
    for name in sorted(os.listdir(base)) if os.path.isdir(base) else []:
        if name.endswith('.json'):
            out += load(os.path.join(base, name), [])
    return out


def download(url, path):
    """大きいファイルを少しずつ保存する（2.5GB を一度に読み込まない）。途中で切れたら例外。"""
    import shutil
    req = urllib.request.Request(url, headers={'User-Agent': 'MyMap-collector'})
    with urllib.request.urlopen(req, timeout=120) as r, open(path + '.part', 'wb') as f:
        size = int(r.headers.get('Content-Length') or 0)
        shutil.copyfileobj(r, f, 16 * 2 ** 20)
    if size and os.path.getsize(path + '.part') != size:
        raise OSError(f'ダウンロードが途中で切れました（{os.path.getsize(path + ".part")}/{size}）')
    os.replace(path + '.part', path)
    return path


def check_counts(old, new, ratio=0.5, floor=1000):
    """前回より極端に少ない種類があれば例外（元データやライブラリの異常で、公開中のデータを空に近いもので上書きしないため）。"""
    low = [f'{k}: {new.get(k, 0)}件（前回 {v}件）' for k, v in (old or {}).items()
           if isinstance(v, int) and v >= floor and new.get(k, 0) < v * ratio]
    if low:
        raise RuntimeError('前回の半分未満になったので書き込まない: ' + ' / '.join(low))


def osm_due(status, now):
    at = status.get('osm_at')
    return status.get('osm_ver') != OSM_VER or not at or now - dt.datetime.fromisoformat(at) >= dt.timedelta(days=7)


def collect_osm(status, now, curated_spots, curated_roads, root=DATA, pbf=None):
    """週 1 回（作り方を変えたときはすぐ）、全国の .osm.pbf をダウンロードして全データを作り直す。作ったら True。"""
    import tempfile
    import osm_pbf
    if not osm_due(status, now):
        return False
    tmp = os.environ.get('RUNNER_TEMP') or tempfile.gettempdir()
    pbf = pbf or os.environ.get('MYMAP_PBF') or download(OSM_PBF_URL, os.path.join(tmp, 'japan-latest.osm.pbf'))
    sel = os.path.join(tmp, 'mymap-selected.osm.pbf')
    kinds = osm_pbf.Kinds(osm_queries())
    t0 = time.time()
    n = osm_pbf.select(pbf, sel, kinds)
    print(f'osm: {n} elements selected in {round(time.time() - t0)}s')
    els = osm_pbf.elements(sel, kinds, KEEP_TAGS, geometry=('roads:road',), rings=('pref',))
    print(f'osm: elements read in {round(time.time() - t0)}s')
    out = build_osm(els, curated_spots, curated_roads)
    del els
    counts = {k: len(out[k]) for k in ('pois', 'spots', 'roads', 'moto', 'jct', 'park')}
    counts['cells'] = sum(len(xs) for by in out['cells'].values() for xs in by.values())
    # 作り方を変えた（OSM_VER を上げた）ときは、件数が大きく変わってもよいので比べない
    check_counts(status.get('osm_counts') if status.get('osm_ver') == OSM_VER else None, counts)
    # 新しいデータは別の場所に全部作ってから入れ替える（途中で止まっても、公開中のデータを中途半端にしない）
    import shutil
    stage = os.path.join(root, '.osm_new')
    if os.path.isdir(stage):
        shutil.rmtree(stage)
    os.makedirs(stage)
    save_area(stage, {k: out[k] for k in ('pois', 'spots', 'roads', 'moto', 'jct')})
    save_park(stage, out['park'])
    save_cells(stage, out['cells'])
    for d in ('area', 'park', 'cells'):
        if os.path.isdir(os.path.join(root, d)):
            shutil.rmtree(os.path.join(root, d))
        os.replace(os.path.join(stage, d), os.path.join(root, d))
    shutil.rmtree(stage)
    for old in ('pois.json', 'osm_spots.json', 'roads_osm.json', 'moto.json'):  # 関東だけの頃の 1 ファイルの形（アプリは area を優先）
        if os.path.exists(os.path.join(root, old)):
            os.remove(os.path.join(root, old))
    # 境界の形が壊れていて組み立てられなかった都道府県は、addr:province か「その他」になる（記録して気づけるように）
    missing = [p for p in PREFS if p not in out['prefs']]
    if missing:
        print(f'[osm] 境界を組み立てられなかった都道府県: {missing}', file=sys.stderr)
    status.update({'osm_at': now.isoformat(timespec='seconds'), 'osm_ver': OSM_VER, 'osm_counts': counts, 'osm_error': None,
                   'osm_pref_missing': missing or None})
    for part in OSM_PARTS:
        status[f'{part}_error'] = None
    print(f'osm: {counts} in {round(time.time() - t0)}s')
    return True


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


def guess_indoor(place, title=''):
    # 場所で決まればそれを使い、決まらないときだけ題名を見る（公園での「移動児童館」を屋内にしない）
    for text in (place or '', title or ''):
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
            e['indoor'] = guess_indoor(e['place'], e['title'])
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
    # OpenStreetMap（全国）は週 1 回。失敗してもイベントは保存し、アプリに「取れなかった部分」として出す（次の依頼で取り直す）
    try:
        if collect_osm(status, dt.datetime.now(JST), load(os.path.join(DATA, 'spots.json'), []), load(os.path.join(DATA, 'scenic_roads.json'), [])):
            print(f'foursquare parking added: {merge_fsq_parking(DATA)}')
            print(f'parking marks: {annotate_parking(DATA)}')
    except Exception as err:  # noqa: BLE001
        msg = f'{type(err).__name__}: {err}'[:200]
        status['osm_error'] = msg
        for part in OSM_PARTS:
            status[f'{part}_error'] = msg
        print(f'[osm] {msg}', file=sys.stderr)
    status['updated_at'] = now_iso()
    save(os.path.join(DATA, 'status.json'), status)
    print(f'events: {len(events)}')


if __name__ == '__main__':
    main()
