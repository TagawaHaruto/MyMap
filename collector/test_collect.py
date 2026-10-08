"""collect.py のテスト。python -m unittest discover -s collector -v"""
import datetime as dt
import os
import sys
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
                          'lat': None, 'lon': None, 'pref': '東京', 'indoor': None, 'url': 'u', 'source': 's', **kw}
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
                'lon': None, 'pref': '東京', 'indoor': None, 'url': 'u', 'source': 'ng'}]
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


if __name__ == '__main__':
    unittest.main()
