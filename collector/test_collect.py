"""collect.py のテスト。python -m unittest discover -s collector -v"""
import datetime as dt
import os
import re
import sys
import urllib.parse
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import collect  # noqa: E402

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
TODAY = '2026-10-08'


def fx(name):
    with open(os.path.join(FIX, name), encoding='utf-8') as f:
        return f.read()


def src(**kw):
    return {'id': 't', 'pref': '東京', 'lat': 35.65, 'lon': 139.54, **kw}


class ParserTest(unittest.TestCase):
    def test_eventjs_parses_and_filters(self):
        # fixture: 5/17(過去), 10/9 講座(除外), 10/18 キッズ(残る), 2024 年の 197 日開催(過去)
        evs = collect.parse_eventjs(fx('eventjs_musashino.js'), src(id='musashino'), TODAY)
        self.assertEqual(len(evs), 1)
        e = evs[0]
        self.assertEqual((e['start'], e['end']), ('2026-10-18', '2026-10-18'))
        self.assertTrue(e['url'].startswith('https://'))
        self.assertIn('武蔵野', e['place'])
        self.assertEqual((e['lat'], e['lon'], e['pref'], e['source']), (35.65, 139.54, '東京', 'musashino'))

    def test_exclude_pattern(self):
        text = ('var event_data = {\nevents: ['
                '{"eventtitle":"祭り","url":"https://a/1","category":["10"],"opendays":["2026/10/10"],"place2":"公園"},'
                '{"eventtitle":"相談会","url":"https://a/2","category":["20"],"opendays":["2026/10/10"]},'
                '{"eventtitle":"両方","url":"https://a/3","category":["10","20"],"opendays":["2026/10/11","2026/10/12"]}],\n'
                'categories: {"10":"祭り・催し","20":"相談"}\n};')
        evs = collect.parse_eventjs(text, src(), TODAY)
        self.assertEqual([e['title'] for e in evs], ['祭り', '両方'])
        self.assertEqual((evs[1]['start'], evs[1]['end']), ('2026-10-11', '2026-10-12'))

    def test_daylist_chofu(self):
        page = 'https://www.city.chofu.lg.jp/cgi-bin/event_cal_multi/calendar.cgi?type=2&year=2026&month=10'
        evs = collect.parse_daylist(fx('chofu_cal.html'), src(id='chofu'), TODAY, 2026, 10, page)
        by_url = {e['url']: e for e in evs}
        e = by_url['https://www.city.chofu.lg.jp/040010/p021008.html']
        self.assertEqual(e['title'], '調布市パラアート展2026')
        self.assertEqual(e['start'], '2026-10-02')
        self.assertTrue(all('calendar.cgi' not in u for u in by_url))
        self.assertTrue(all(e['end'] >= TODAY for e in evs))

    def test_daylist_fuchu(self):
        page = 'http://www.city.fuchu.tokyo.jp/event/calendar/list_calendar202610.html'
        evs = collect.parse_daylist(fx('fuchu_cal.html'), src(id='fuchu'), TODAY, 2026, 10, page)
        e = {x['url']: x for x in evs}['http://www.city.fuchu.tokyo.jp/kanko/event/tour-de-fuchu.html']
        self.assertEqual(e['start'], '2026-10-01')
        self.assertGreaterEqual(e['end'], TODAY)

    def test_doorkeeper(self):
        evs = collect.parse_doorkeeper(fx('doorkeeper.json'), src(id='dk'), TODAY)
        self.assertEqual(len(evs), 1)
        e = evs[0]
        self.assertIn('CoderDojo', e['title'])
        self.assertEqual(e['start'], '2026-10-25')  # UTC 00:30 → JST 09:30
        self.assertAlmostEqual(e['lat'], 35.6507, places=3)
        self.assertTrue(e['url'].startswith('https://coderdojo-chofu.doorkeeper.jp/'))

    def test_nextdata(self):
        s = src(id='tz', url='https://www.chofu-culture-community.org/events?page={page}', indoor=True, place='たづくり')
        evs = collect.parse_nextdata(fx('nextdata_tazukuri.html'), s, TODAY)
        self.assertGreater(len(evs), 0)
        e = {x['id']: x for x in evs}['tz:42869']
        self.assertEqual((e['start'], e['url']), ('2027-03-27', 'https://www.chofu-culture-community.org/events/archives/42869'))
        self.assertIs(e['indoor'], True)
        self.assertEqual(e['place'], 'たづくり')


class FlowTest(unittest.TestCase):
    def test_source_pages_daylist_spans_months(self):
        s = src(type='daylist', url='http://x/list{YM}.html?y={Y}&m={M}')
        pages = collect.source_pages(s, dt.date(2026, 11, 20), 3)
        self.assertEqual([p[0] for p in pages], ['http://x/list202611.html?y=2026&m=11',
                                                 'http://x/list202612.html?y=2026&m=12',
                                                 'http://x/list202701.html?y=2027&m=1'])
        self.assertEqual(pages[2][1], {'year': 2027, 'month': 1, 'page_url': 'http://x/list202701.html?y=2027&m=1'})
        first = collect.source_pages({**s, 'firstUrl': 'http://x/list.html'}, dt.date(2026, 11, 20), 2)
        self.assertEqual([p[0] for p in first], ['http://x/list.html', 'http://x/list202612.html?y=2026&m=12'])
        self.assertEqual(first[0][1]['month'], 11)

    def test_finalize_dedup_window_indoor(self):
        e = lambda **kw: {'id': 'x', 'title': 'A', 'start': '2026-10-10', 'end': '2026-10-10', 'place': None,
                          'lat': None, 'lon': None, 'pref': '東京', 'indoor': None, 'url': 'https://u', 'source': 's', **kw}
        out = collect.finalize([
            e(), e(source='s2'),                                   # 同名同日 → 1 件
            e(title='過去', start='2026-10-01', end='2026-10-07'),  # 終了済み → 除外
            e(title='遠い', start='2027-03-01', end='2027-03-01'),  # 3 か月より先 → 除外
            e(title='体育館の催し', place='市民体育館'),            # 屋内
            e(title='公園まつり', place='中央公園'),                # 屋外
        ], dt.date(2026, 10, 8), 3)
        self.assertEqual([x['title'] for x in out], ['A', '体育館の催し', '公園まつり'])  # 同日はタイトルの文字コード順
        self.assertEqual({x['title']: x['indoor'] for x in out}, {'A': None, '公園まつり': False, '体育館の催し': True})

    def test_failed_source_keeps_previous_events(self):
        cfg = {'eventMonthsAhead': 3, 'sources': [
            src(id='ok', type='doorkeeper', query='調布'), src(id='ng', type='eventjs', url='https://ng/event.js')]}
        old = [{'id': 'ng:1', 'title': '前回', 'start': '2026-10-20', 'end': '2026-10-20', 'place': None, 'lat': None,
                'lon': None, 'pref': '東京', 'indoor': None, 'url': 'https://u', 'source': 'ng'}]
        status = {'sources': {}}

        def fake_fetch(url):
            if url.startswith('https://ng/'):
                raise OSError('boom')
            return fx('doorkeeper.json')

        evs = collect.collect_events(cfg, dt.date(2026, 10, 8), old, status, fake_fetch)
        self.assertEqual(sorted(e['source'] for e in evs), ['ng', 'ok'])
        self.assertIn('boom', status['sources']['ng']['error'])
        self.assertIsNone(status['sources']['ok']['error'])
        self.assertEqual(status['sources']['ok']['count'], 1)


class PoiTest(unittest.TestCase):
    def test_parse_overpass(self):
        pois = collect.parse_overpass(fx('overpass.json'))
        got = {(p['kind'], p['name']) for p in pois}
        self.assertEqual(got, {('michinoeki', '道の駅どうし'), ('onsen', '瀬音の湯'), ('waterfall', '払沢の滝'),
                               ('lake', '奥多摩湖'), ('peak', '高尾山'), ('coast', '城ヶ島'), ('gorge', '中津渓谷'),
                               ('viewpoint', '大観山展望台')})
        lake = next(p for p in pois if p['kind'] == 'lake')
        self.assertEqual((lake['lat'], lake['lon']), (35.78, 139.02))
        self.assertEqual(lake['wikipedia'], 'https://ja.wikipedia.org/wiki/' + urllib.parse.quote('奥多摩湖'))
        self.assertIsNone(next(p for p in pois if p['kind'] == 'onsen')['wikipedia'])

    def test_poi_queries_are_split_by_kind(self):
        self.assertEqual([k for k, _ in collect.POI_QUERIES], ['michinoeki', 'onsen', 'viewpoint', 'scenic'])
        q = collect.overpass_body(collect.POI_QUERIES[3][1], '(34.299,137.877,37.001,141.203)').decode()
        self.assertIn(urllib.parse.quote('(34.299,137.877,37.001,141.203)'), q)
        for word in ('waterfall', 'peak', 'lake', 'beach'):
            self.assertIn(word, q)
        self.assertEqual(collect.bbox({'lat': 35.65, 'lon': 139.54}, 150), '(34.299,137.877,37.001,141.203)')

    def test_refresh_pois_skips_when_fresh(self):
        status = {'pois_radius': 150, 'pois_done': {k: '2026-10-05T00:00:00+09:00' for k, _ in collect.POI_QUERIES}}
        calls = []
        collect.refresh_pois({'origin': {'lat': 35.65, 'lon': 139.54}, 'poiRadiusKm': 150}, status,
                             lambda *a, **k: calls.append(a), dt.datetime(2026, 10, 8, tzinfo=collect.JST))
        self.assertEqual(calls, [])


class ReviewFixTest(unittest.TestCase):
    def test_unnamed_onsen_is_skipped(self):
        text = '{"elements": [{"type": "node", "id": 1, "lat": 35.7, "lon": 139.2, "tags": {"amenity": "public_bath", "bath:type": "onsen"}}]}'
        self.assertEqual(collect.parse_overpass(text), [])
        self.assertIn('nwr["amenity"="public_bath"]["bath:type"="onsen"]["name"]', dict(collect.POI_QUERIES)['onsen'])

    def test_zero_events_with_previous_future_events_is_error(self):
        cfg = {'eventMonthsAhead': 3, 'sources': [src(id='d', type='daylist', url='https://d/{YM}')]}
        old = [{'id': 'd:1', 'title': '前回', 'start': '2026-10-20', 'end': '2026-10-20', 'place': None, 'lat': None,
                'lon': None, 'pref': '東京', 'indoor': None, 'url': 'https://d/1', 'source': 'd'}]
        status = {'sources': {}}
        evs = collect.collect_events(cfg, dt.date(2026, 10, 8), old, status, lambda url: '<html>redesigned</html>')
        self.assertEqual([e['title'] for e in evs], ['前回'])
        self.assertIn('0件', status['sources']['d']['error'])

    def test_daylist_event_spanning_months_is_one_entry(self):
        pages = {'https://d/202610': '<table><tr><td>31日</td><td><a href="/ex">展示</a></td></tr></table>',
                 'https://d/202611': '<table><tr><td>1日</td><td><a href="/ex">展示</a></td></tr></table>',
                 'https://d/202612': '<table></table>'}
        cfg = {'eventMonthsAhead': 3, 'sources': [src(id='d', type='daylist', url='https://d/{YM}')]}
        evs = collect.collect_events(cfg, dt.date(2026, 10, 8), [], {'sources': {}}, lambda url: pages[url])
        self.assertEqual([(e['title'], e['start'], e['end']) for e in evs], [('展示', '2026-10-31', '2026-11-01')])

    def test_keep_pattern_beats_exclude(self):
        text = ('var event_data = {\nevents: ['
                '{"eventtitle":"市民マラソン","url":"https://a/1","category":["10"],"opendays":["2026/10/10"]},'
                '{"eventtitle":"健診","url":"https://a/2","category":["20"],"opendays":["2026/10/10"]}],\n'
                'categories: {"10":"スポーツ・健康","20":"健康"}\n};')
        self.assertEqual([e['title'] for e in collect.parse_eventjs(text, src(url='https://a/event.js'), TODAY)], ['市民マラソン'])

    def test_urls_resolved_and_non_http_dropped(self):
        text = ('var event_data = {\nevents: ['
                '{"eventtitle":"相対","url":"/event/1.html","category":[],"opendays":["2026/10/10"]}],\ncategories: {}\n};')
        evs = collect.parse_eventjs(text, src(url='https://www.city.x.lg.jp/event.js'), TODAY)
        self.assertEqual(evs[0]['url'], 'https://www.city.x.lg.jp/event/1.html')
        page = '<table><tr><td>10日</td><td><a href="javascript:alert(1)">悪い</a><a href="/ok">良い</a></td></tr></table>'
        evs = collect.parse_daylist(page, src(id='d'), TODAY, 2026, 10, 'https://d/')
        self.assertEqual([e['title'] for e in evs], ['良い'])


class OsmSpotTest(unittest.TestCase):
    def test_experience_genre(self):
        g = lambda **t: collect.osm_genre({'name': 'x', **t})
        self.assertEqual(g(leisure='escape_game')[:2], (['experience', 'play'], True))
        self.assertEqual(g(leisure='track', sport='karting')[:2], (['experience', 'vehicle'], False))
        self.assertEqual(g(leisure='sports_centre', sport='climbing')[:2], (['experience'], True))
        self.assertEqual(g(craft='pottery'), (['experience'], True, '陶芸体験'))
        self.assertEqual(collect.osm_genre({'name': '某いちご狩り園', 'landuse': 'farmland'})[0], ['experience', 'outdoor'])
        self.assertIsNone(collect.osm_genre({'name': '田んぼ', 'landuse': 'farmland'}))

    def test_parse_osm_spots(self):
        spots = collect.parse_osm_spots(fx('overpass_spots.json'), exclude_names={'深大寺'})
        by = {s['name']: s for s in spots}
        # 名前なし・厳選リストと同名・近接同名は除外
        self.assertNotIn('深大寺', by)
        self.assertEqual(sum(1 for s in spots if s['name'] == '青梅鉄道公園'), 1)
        self.assertEqual(len(spots), 10)
        rail = by['青梅鉄道公園']
        self.assertEqual(rail['genres'], ['vehicle', 'museum'])
        self.assertIs(rail['indoor'], True)
        self.assertEqual((rail['pref'], rail['url']), ('東京', 'https://www.ome-tetsudou-park.com/'))
        self.assertEqual(rail['id'], 'osm:node:1')
        self.assertEqual(by['東京国立博物館']['url'], 'https://ja.wikipedia.org/wiki/' + urllib.parse.quote('東京国立博物館'))
        self.assertEqual((by['某寺']['genres'], by['某寺']['indoor'], by['某寺']['pref']), (['temple'], False, '神奈川'))
        self.assertEqual((by['〇〇の湯']['genres'], by['〇〇の湯']['indoor']), (['onsen'], True))
        self.assertEqual((by['某水族館']['genres'], by['某水族館']['indoor']), (['play'], True))
        self.assertEqual((by['某動物園']['genres'], by['某動物園']['indoor']), (['play'], False))
        self.assertEqual((by['某モール']['genres'], by['某モール']['indoor']), (['shopping'], True))
        self.assertEqual((by['某展望台']['genres'], by['某展望台']['indoor']), (['scenic'], False))
        self.assertEqual(by['航空公園']['genres'], ['vehicle', 'play'])
        self.assertEqual((by['某プラネタリウム']['genres'], by['某プラネタリウム']['url']), (['museum'], ''))
        self.assertTrue(all(s['note'] for s in spots))
        # 読み仮名タグがあれば検索用に残す（ないものはキー自体を付けない）
        self.assertEqual(by['東京国立博物館']['kana'], 'とうきょうこくりつはくぶつかん')
        self.assertEqual(by['某寺']['kana'], 'ボウジ')
        self.assertNotIn('kana', by['某水族館'])

    def test_refresh_spots_keeps_old_entries_of_failed_queries(self):
        old = [{'id': 'osm:node:99', 'name': '旧', 'lat': 35.0, 'lon': 139.0, 'k': 'bath'}]
        calls = []

        urls = []

        def fake_fetch(url, data=None, timeout=60):
            calls.append(data)
            urls.append(url)
            if b'ISO3166' in data:  # 都県 area の問い合わせ（全種類の文を含むので先に返す）
                return '{"elements": []}'
            if b'public_bath' in data:
                raise OSError('504')
            return fx('overpass_spots.json')

        status = {}
        spots = collect.refresh_spots({'origin': {'lat': 35.65, 'lon': 139.54}, 'poiRadiusKm': 150}, status, fake_fetch,
                                      dt.datetime(2026, 10, 8, tzinfo=collect.JST), old, set(), sleep=lambda s: None)
        # 失敗した種類は別サーバーで再試行し、最後にもう一度だけ試す。失敗した種類は取得済みにしない（次の実行で取り直す）
        self.assertEqual(len(calls), len(collect.SPOT_QUERIES) + 2 * len(collect.OVERPASS_URLS) - 1)
        self.assertNotIn('bath', status['spots_done'])
        self.assertIn('museum', status['spots_done'])
        self.assertEqual(len({u for u in urls if u}), len(collect.OVERPASS_URLS))
        self.assertIn('旧', [s['name'] for s in spots])
        self.assertIn('bath', status['spots_error'])
        self.assertIsNotNone(status['spots_at'])

    def test_done_kinds_from_old_status(self):
        st = {'cells_at': '2026-10-09T12:00:00+09:00', 'cells_sig': [300, 'cafe', 'park', 'bigpark'],
              'cells_error': 'cafe: HTTPError: 504 / bigpark: HTTPError: 504'}
        self.assertEqual(collect.done_kinds(st, 'cells', 300), {'park': '2026-10-09T12:00:00+09:00'})
        self.assertEqual(collect.done_kinds(st, 'cells', 150), {})

    def test_refresh_spots_skips_when_fresh(self):
        status = {'spots_radius': 150, 'spots_done': {k: '2026-10-05T00:00:00+09:00' for k, _ in collect.SPOT_QUERIES}}
        got = collect.refresh_spots({'origin': {'lat': 35.65, 'lon': 139.54}, 'poiRadiusKm': 150}, status,
                                    lambda *a, **k: 1 / 0, dt.datetime(2026, 10, 8, tzinfo=collect.JST), [], set())
        self.assertIsNone(got)
        # 種類や範囲を変えた直後は、1 週間たっていなくても取り直す
        status['spots_radius'] = 300
        self.assertIsNotNone(collect.refresh_spots({'origin': {'lat': 35.65, 'lon': 139.54}, 'poiRadiusKm': 150}, status,
                                                   lambda *a, **k: 1 / 0, dt.datetime(2026, 10, 8, tzinfo=collect.JST), [], set(), sleep=lambda s: None))


class OverpassRemarkTest(unittest.TestCase):
    TIMEOUT = '{"elements": [], "remark": "runtime error: Query timed out in \\"query\\" at line 1 after 181 seconds."}'

    def test_parsers_raise_on_runtime_error(self):
        with self.assertRaises(RuntimeError):
            collect.parse_overpass(self.TIMEOUT)
        with self.assertRaises(RuntimeError):
            collect.parse_osm_spots(self.TIMEOUT)

    def test_refresh_pois_keeps_old_kind_on_runtime_error(self):
        old = [{'name': '旧道の駅', 'lat': 35.5, 'lon': 139.0, 'kind': 'michinoeki', 'wikipedia': None, 'k': 'michinoeki'}]
        status = {}
        pois = collect.refresh_pois({'origin': {'lat': 35.65, 'lon': 139.54}, 'poiRadiusKm': 150}, status,
                                    lambda *a, **k: self.TIMEOUT, dt.datetime(2026, 10, 8, tzinfo=collect.JST),
                                    old, sleep=lambda s: None)
        self.assertEqual([p['name'] for p in pois], ['旧道の駅'])
        self.assertIn('timed out', status['pois_error'])

    def test_refresh_pois_tags_kind_group(self):
        pois = collect.refresh_pois({'origin': {'lat': 35.65, 'lon': 139.54}, 'poiRadiusKm': 150}, {},
                                    lambda *a, **k: fx('overpass.json'), dt.datetime(2026, 10, 8, tzinfo=collect.JST),
                                    [], sleep=lambda s: None)
        self.assertIn(('michinoeki', '道の駅どうし'), {(p['kind'], p['name']) for p in pois})
        self.assertTrue(all(p['k'] for p in pois))

    def test_refresh_spots_keeps_old_kind_on_runtime_error(self):
        old = [{'id': 'osm:node:1', 'name': '旧博物館', 'lat': 35.0, 'lon': 139.0, 'k': 'museum'}]
        status = {}
        spots = collect.refresh_spots({'origin': {'lat': 35.65, 'lon': 139.54}, 'poiRadiusKm': 150}, status,
                                      lambda *a, **k: self.TIMEOUT, dt.datetime(2026, 10, 8, tzinfo=collect.JST),
                                      old, set(), sleep=lambda s: None)
        self.assertEqual([s['name'] for s in spots], ['旧博物館'])
        self.assertIn('museum', status['spots_error'])


CFG = {'origin': {'lat': 35.65, 'lon': 139.54}, 'poiRadiusKm': 150}
NOW = dt.datetime(2026, 10, 8, tzinfo=collect.JST)


# 都県の境界（テスト用の四角）: 東京 = 経度139.45〜139.8・緯度35.6〜35.8、神奈川 = その南
SQUARES = [{'name': '東京', 'rings': [[[139.45, 35.6], [139.8, 35.6], [139.8, 35.8], [139.45, 35.8], [139.45, 35.6]]]},
           {'name': '神奈川', 'rings': [[[139.45, 35.3], [139.8, 35.3], [139.8, 35.6], [139.45, 35.6], [139.45, 35.3]]]}]


class PrefTest(unittest.TestCase):
    def test_norm_province(self):
        for raw, want in [
            ('東京都', '東京'), (' 神奈川県 ', '神奈川'), ('埼玉', '埼玉'), ('千葉県', '千葉'), ('山梨県', '山梨'),
            ('群馬県', '群馬'), ('栃木県', '栃木'), ('茨城県', '茨城'), ('静岡県', '静岡'), ('長野県', '長野'),
            ('Tokyo', '東京'), ('KANAGAWA', '神奈川'), ('saitama', '埼玉'), (' Chiba ', '千葉'), ('Yamanashi', '山梨'),
            ('长野县', None), ('1231', None), ('京都府', None), ('Tokyo-to', None), ('', None), (None, None),
        ]:
            with self.subTest(raw=raw):
                self.assertEqual(collect.norm_province(raw), want)

    def test_pref_of_point_in_polygon(self):
        prefs = collect.prep_prefectures(SQUARES)
        self.assertEqual(collect.pref_of(35.7, 139.6, prefs), '東京')
        self.assertEqual(collect.pref_of(35.4, 139.6, prefs), '神奈川')
        self.assertIsNone(collect.pref_of(36.5, 139.6, prefs))
        self.assertIsNone(collect.pref_of(35.7, 139.6, []))

    def test_refresh_spots_assigns_pref_without_network(self):
        calls = []

        def fetch(url, data=None, timeout=60):
            calls.append(url)
            return fx('overpass_spots.json')

        status = {}
        spots = collect.refresh_spots(CFG, status, fetch, NOW, [], set(), sleep=lambda s: None, prefectures=SQUARES)
        by = {s['name']: s['pref'] for s in spots}
        self.assertEqual(by['東京国立博物館'], '東京')   # 境界の内側
        self.assertEqual(by['某寺'], '東京')             # addr:province（神奈川）より境界の判定を優先
        self.assertEqual(by['某水族館'], '東京')
        self.assertEqual(by['某展望台'], 'その他')           # 境界の外で addr:province もない → その他
        self.assertEqual(len(calls), len(collect.SPOT_QUERIES))  # 都県のための問い合わせはしない
        self.assertIsNone(status['spots_error'])


class IndoorTest(unittest.TestCase):
    def test_guess_indoor(self):
        # 場所の語で決まればそれを使い、場所で決まらないときだけ題名を見る。
        # 語は上から順に最初に当たったもの（屋内の具体的な語 → 屋外の語）。
        for place, title, want in [
            ('市立児童館', '', True), ('児童センター', '', True), ('郷土歴史館', '', True), ('郷土資料館', '', True),
            ('行政資料室', '', True), ('〇〇ミュージアム', '', True), ('XX MUSEUM', '', True), ('ガスショールーム', '', True),
            ('第1会議室', '', True), ('生涯学習館', '', True), ('地区集会所', '', True), ('市民温水プール', '', True),
            ('メインアリーナ', '', True), ('保健センター', '', True),
            ('市営テニスコート', '', False), ('市民農園', '', False), ('キャンプ場', '', False), ('こどもの森', '', False),
            ('武蔵野の森総合スポーツプラザ メインアリーナ', '', True),
            ('森の資料館', '', True),
            ('こどもの森 自然観察センター', '', False),
            # 場所が屋外なら、題名に屋内の語があっても屋外（公園での「移動児童館」など）
            ('中央公園', '移動児童館', False),
            ('中央図書館', '森のおはなし会', True),
            (None, '体育館で卓球', True),       # 場所がなければ題名で決める
            # 広い「センター」だけでは決めない（地名「多摩センター」や屋外の観察センターを屋内にしない）
            ('地域センター', '', None),
            ('多摩センター駅前広場', '', False),
            ('どこか', '', None),
        ]:
            with self.subTest(place=place, title=title):
                self.assertIs(collect.guess_indoor(place, title), want)
        self.assertNotIn(('センター', True), collect.INDOOR_WORDS)


class CellTest(unittest.TestCase):
    def test_cell_id_matches_lib(self):
        self.assertEqual(collect.cell_id(35.6518, 139.544), '142_558')
        self.assertEqual(collect.cell_id(-0.1, -0.1), '-1_-1')

    def test_parse_group_items(self):
        seen = set()
        items = collect.parse_group_items(fx('overpass_cells.json'), seen)
        by = {s['name']: s for s in items}
        self.assertEqual(len(items), 8)                  # 名前なし 1 件・近くの同名 1 件を除く
        self.assertEqual((by['深大寺そば 玉乃屋']['genres'], by['深大寺そば 玉乃屋']['note']), (['food'], 'そば'))
        self.assertIs(by['マクドナルド 調布店']['chain'], True)
        self.assertNotIn('chain', by['森のカフェ'])
        self.assertEqual((by['森のカフェ']['note'], by['森のカフェ']['indoor'], by['森のカフェ']['url']), ('カフェ', True, 'https://cafe.example.jp/'))
        self.assertEqual((by['八王子城跡']['genres'], by['八王子城跡']['note'], by['八王子城跡']['wp']), (['heritage'], '城跡', 'ja:八王子城'))
        self.assertEqual(by['道志の湯宿']['genres'], ['lodging'])
        self.assertEqual((by['朝採り直売所']['genres'], by['朝採り直売所']['indoor']), (['souvenir'], True))
        self.assertEqual((by['相模湖ボウル']['genres'], by['相模湖ボウル']['indoor']), (['outdoor'], True))
        self.assertEqual((by['湖畔キャンプ場']['genres'], by['湖畔キャンプ場']['indoor']), (['outdoor'], False))
        self.assertEqual({s['g'] for s in items}, {'food', 'heritage', 'local'})

    def test_split_bbox_into_grid(self):
        q = collect.grid('(34.0,138.0,36.0,140.0)', 2)
        self.assertEqual(q, ['(34.000,138.000,35.000,139.000)', '(34.000,139.000,35.000,140.000)',
                             '(35.000,138.000,36.000,139.000)', '(35.000,139.000,36.000,140.000)'])
        self.assertEqual(len(collect.grid('(34.0,138.0,36.0,140.0)', 4)), 16)
        self.assertEqual([collect.splits({'poiRadiusKm': r}) for r in (150, 300)], [1, 2])
        self.assertEqual(collect.splits({'poiRadiusKm': 300}, 75), 4)

    def test_refresh_cells_groups_and_keeps_old_on_failure(self):
        old = [{'id': 'osm:node:900', 'name': '旧カフェ', 'lat': 35.6, 'lon': 139.5, 'genres': ['food'], 'g': 'food', 'k': 'cafe'}]
        calls = []

        def fetch(url, data=None, timeout=60):
            body = urllib.parse.unquote_plus(data.decode())
            calls.append(body)
            if '"cafe"' in body:
                raise OSError('504')
            return fx('overpass_cells.json')

        status = {}
        cells = collect.refresh_cells(CFG, status, fetch, NOW, old, sleep=lambda s: None)
        self.assertIn('旧カフェ', [x['name'] for x in cells['food'][collect.cell_id(35.6, 139.5)]])
        self.assertIn('cafe', status['cells_error'])
        self.assertIsNotNone(status['cells_at'])
        # 同じ要素が複数の問い合わせに出ても 1 件
        food_names = [x['name'] for v in cells['food'].values() for x in v]
        self.assertEqual(food_names.count('深大寺そば 玉乃屋'), 1)
        self.assertIsNone(collect.refresh_cells(CFG, {'cells_radius': 150, 'cells_done': {q[0]: '2026-10-05T00:00:00+09:00' for q in collect.CELL_QUERIES}}, fetch, NOW, [], sleep=lambda s: None))


if __name__ == '__main__':
    unittest.main()
