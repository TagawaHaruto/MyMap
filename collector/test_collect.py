"""collect.py のテスト。python -m unittest discover -s collector -v"""
import datetime as dt
import os
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

    def test_overpass_query_has_bbox_and_all_kinds(self):
        q = collect.overpass_query({'lat': 35.65, 'lon': 139.54}, 150)
        self.assertIn('[out:json]', q)
        self.assertIn('(34.299,137.877,37.001,141.203)', q)
        for word in ('道の駅', 'public_bath', 'viewpoint', 'waterfall', 'peak', 'water', 'beach'):
            self.assertIn(word, q)

    def test_refresh_pois_skips_when_fresh(self):
        status = {'pois_at': '2026-10-05T00:00:00+09:00'}
        calls = []
        collect.refresh_pois({'origin': {'lat': 35.65, 'lon': 139.54}, 'poiRadiusKm': 150}, status,
                             lambda *a, **k: calls.append(a), dt.datetime(2026, 10, 8, tzinfo=collect.JST))
        self.assertEqual(calls, [])


class ReviewFixTest(unittest.TestCase):
    def test_unnamed_onsen_is_skipped(self):
        text = '{"elements": [{"type": "node", "id": 1, "lat": 35.7, "lon": 139.2, "tags": {"amenity": "public_bath", "bath:type": "onsen"}}]}'
        self.assertEqual(collect.parse_overpass(text), [])
        self.assertIn('nwr["amenity"="public_bath"]["bath:type"="onsen"]["name"]', collect.overpass_query({'lat': 35.65, 'lon': 139.54}, 150))

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


if __name__ == '__main__':
    unittest.main()
