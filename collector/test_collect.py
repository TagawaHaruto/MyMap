"""collect.py のテスト。python -m unittest discover -s collector -v"""
import datetime as dt
import json
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
    def test_parse_fuel24(self):
        text = json.dumps({'elements': [
            {'type': 'node', 'id': 1, 'lat': 35.6, 'lon': 139.5, 'tags': {'amenity': 'fuel', 'brand': 'ENEOS', 'opening_hours': '24/7', 'self_service': 'yes'}},
            {'type': 'node', 'id': 2, 'lat': 35.7, 'lon': 139.5, 'tags': {'amenity': 'fuel', 'name': 'ENEOS', 'opening_hours': '24/7'}},
            {'type': 'way', 'id': 3, 'center': {'lat': 35.70001, 'lon': 139.5}, 'tags': {'amenity': 'fuel', 'name': 'ENEOS', 'opening_hours': '24/7'}},
            {'type': 'node', 'id': 4, 'lat': 35.8, 'lon': 139.5, 'tags': {'amenity': 'fuel', 'name': '出光 X店', 'brand': '出光', 'opening_hours': '24/7'}},
        ]})
        xs = collect.parse_overpass(text)
        self.assertEqual([(x['name'], x['lat'], x.get('self')) for x in xs], [('ENEOS', 35.6, 1), ('ENEOS', 35.7, None), ('出光 X店', 35.8, None)])
        self.assertTrue(all(x['kind'] == 'fuel24' and x['oh'] == '24/7' for x in xs))
        self.assertNotIn('brand', xs[2])

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

    def test_onsen_genre(self):
        # 入浴施設の印がない温泉も拾う。温泉の入らない宿・サウナは対象外
        g = lambda name, **t: collect.osm_genre({'name': name, **t})
        self.assertEqual(g('ことぶき温泉', leisure='hot_spring')[0], ['onsen'])
        self.assertEqual(g('海地獄', natural='hot_spring')[:1], (['onsen', 'scenic'],))
        self.assertEqual(g('鉄輪むし湯', natural='spring')[0], ['onsen'])
        self.assertEqual(g('鶴の湯温泉', tourism='hotel')[2], '温泉宿（日帰り入浴は要確認）')
        self.assertEqual(g('明礬温泉', tourism='attraction')[0], ['onsen', 'sightseeing'])
        self.assertEqual(g('駒の湯温泉', leisure='sauna')[0], ['onsen'])
        self.assertIsNone(g('駅前ホテル', tourism='hotel'))
        self.assertIsNone(g('サウナ北欧', leisure='sauna'))
        self.assertEqual(g('東京タワー', tourism='attraction')[0], ['sightseeing'])

    def test_romaji_kana(self):
        r = collect.romaji_to_kana
        self.assertEqual(r('Nobeha No Yu Tsuruhashi'), 'のべはのゆつるはし')
        self.assertEqual(r('Dōgo Onsen Honkan'), 'どうごおんせんほんかん')
        self.assertEqual(r('Kinosaki Onsen'), 'きのさきおんせん')
        self.assertEqual(r('Shin-Yokohama'), 'しんよこはま')  # ō は「おう」にする（大久保の「おお」とは区別できない）
        self.assertEqual(r('Hakkōda'), 'はっこうだ')
        self.assertEqual(r('Ryokan Chōjūkan'), 'りょかんちょうじゅうかん')
        self.assertIsNone(r('Beppu Tower'))   # 英語の名前は読みにしない
        self.assertIsNone(r('Starbucks'))
        self.assertIsNone(r(None))
        self.assertEqual(collect.name_kana({'name:ja-Hira': 'あさまおんせん', 'name:en': 'Asama Onsen'}), 'あさまおんせん')
        self.assertEqual(collect.name_kana({'name:en': 'Nobeha No Yu'}), 'のべはのゆ')
        self.assertEqual(collect.show_name('温泉銭湯;夢元さぎり湯'), '温泉銭湯 夢元さぎり湯')

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


    def test_build_roads_joins_parts_in_order(self):
        # 同じ名前の 3 断片（1 つは逆向き）→ 1 本。短い道・厳選と同じ道は除く
        parts = [
            {'wid': 3, 'name': 'Aスカイライン', 'toll': False, 'coords': [[35.00, 139.02], [35.00, 139.04]]},
            {'wid': 1, 'name': 'Aスカイライン', 'toll': True, 'coords': [[35.00, 139.00], [35.00, 139.02]]},
            {'wid': 2, 'name': 'Aスカイライン', 'toll': False, 'coords': [[35.00, 139.06], [35.00, 139.04]]},
            {'wid': 9, 'name': 'B峠', 'toll': False, 'coords': [[36.0, 139.0], [36.01, 139.0]]},
            {'wid': 7, 'name': 'Cライン', 'toll': False, 'coords': [[34.5, 139.0], [34.6, 139.0]]},
            # 上下線が別の道（行って戻る並び）→ 片道分だけ
            {'wid': 20, 'name': 'D峠線', 'toll': False, 'coords': [[34.0, 139.0], [34.05, 139.0]]},
            {'wid': 21, 'name': 'D峠線', 'toll': False, 'coords': [[34.05, 139.0005], [34.0, 139.0005]]},
        ]
        parts.append({'wid': 30, 'name': 'E ターンパイク', 'toll': True, 'coords': [[33.0, 139.0], [33.05, 139.0]]})
        roads = collect.build_roads(parts, curated=[{'name': 'Cライン（県道）', 'points': [[34.55, 139.0]]},
                                                    {'name': 'Eターンパイク（本線）', 'points': [[33.02, 139.0]]}])
        self.assertEqual([r['name'] for r in roads], ['Aスカイライン', 'D峠線'])
        d = roads[1]
        self.assertAlmostEqual(d['km'], 5.55, delta=0.3)
        self.assertGreater(abs(d['points'][0][0] - d['points'][-1][0]), 0.04)
        r = roads[0]
        self.assertEqual((r['id'], r['toll'], len(r['points'])), ('osm:way:1', True, 6))
        lons = [p[1] for p in r['points']]
        self.assertTrue(lons == sorted(lons) or lons == sorted(lons, reverse=True), lons)
        self.assertAlmostEqual(r['km'], 5.5, delta=0.3)
        self.assertIn('スカイライン', r['note'])
        self.assertLess(r['curv'], 5)  # まっすぐな道
        zig = [[35 + (i % 2) * 0.0015, 139 + i * 0.002] for i in range(50)]
        self.assertGreater(collect.curviness(zig), 150)

    def test_parse_pass(self):
        text = '{"elements": [{"type": "node", "id": 5, "lat": 35.5, "lon": 138.9, "tags": {"name": "雁坂峠", "mountain_pass": "yes", "ele": "2082"}}]}'
        p = collect.parse_road_parts(text, 'pass')[0]
        self.assertEqual((p['name'], p['points'], p['pass'], p['note']), ('雁坂峠', [[35.5, 138.9]], True, '峠（標高2082m）'))

    def test_extra_tags_and_version(self):
        self.assertEqual(collect.extra_tags({'opening_hours': 'Mo-Fr 09:00-17:00', 'contact:phone': '+81 42-000-0000;03-1', 'wheelchair': 'yes'}),
                         {'oh': 'Mo-Fr 09:00-17:00', 'tel': '+81 42-000-0000', 'wc': 'yes'})
        self.assertEqual(collect.extra_tags({'wheelchair': 'designated'}), {})
        # OpenStreetMap は週 1 回。作り方を変えた（版が違う）ときは、1 週間以内でも作り直す
        now = dt.datetime(2026, 10, 8, tzinfo=collect.JST)
        st = {'osm_at': '2026-10-05T00:00:00+09:00', 'osm_ver': collect.OSM_VER}
        self.assertFalse(collect.osm_due(st, now))
        self.assertTrue(collect.osm_due({**st, 'osm_at': '2026-09-30T00:00:00+09:00'}, now))
        self.assertTrue(collect.osm_due({**st, 'osm_ver': collect.OSM_VER - 1}, now))
        self.assertTrue(collect.osm_due({}, now))

    def test_parse_moto(self):
        text = json.dumps({'elements': [
            {'type': 'node', 'id': 1, 'lat': 35.6, 'lon': 139.5, 'tags': {'amenity': 'motorcycle_parking', 'capacity': '12', 'fee': 'yes'}},
            {'type': 'way', 'id': 2, 'center': {'lat': 35.61, 'lon': 139.51}, 'tags': {'amenity': 'bicycle_parking', 'moped': 'yes', 'name': '駅前駐輪場'}},
            {'type': 'node', 'id': 3, 'lat': 35.62, 'lon': 139.52, 'tags': {'amenity': 'parking', 'access': 'private', 'motorcycle': 'yes'}},
            {'type': 'node', 'id': 4, 'lat': 35.63, 'lon': 139.53, 'tags': {'amenity': 'parking', 'motorcycle': 'no', 'name': 'バイク不可'}},
        ]})
        xs = collect.parse_moto(text, 'moto_tagged')
        self.assertEqual([x['id'] for x in xs], ['osm:node:1', 'osm:way:2'])
        self.assertEqual((xs[0]['type'], xs[0]['cap'], xs[0]['fee']), ('バイク専用', 12, '有料'))
        self.assertEqual((xs[1]['type'], xs[1].get('moped')), ('駐輪場（二輪可）', True))
        sa = collect.parse_moto(json.dumps({'elements': [{'type': 'way', 'id': 9, 'center': {'lat': 35.5, 'lon': 139.0},
                                                         'tags': {'highway': 'services', 'name': '海老名SA'}}]}), 'rest_area')
        self.assertEqual((sa[0]['type'], sa[0]['likely']), ('SA・PA', True))

    def test_parse_and_save_parking(self):
        import tempfile
        text = json.dumps({'elements': [
            {'type': 'way', 'id': 1, 'center': {'lat': 35.65, 'lon': 139.54}, 'tags': {'amenity': 'parking', 'name': '深大寺駐車場', 'fee': 'yes', 'capacity': '40', 'motorcycle': 'yes'}},
            {'type': 'node', 'id': 2, 'lat': 35.66, 'lon': 139.55, 'tags': {'amenity': 'parking', 'access': 'customers', 'parking': 'multi-storey'}},
            {'type': 'node', 'id': 3, 'lat': 35.67, 'lon': 139.56, 'tags': {'amenity': 'parking', 'access': 'private'}},
        ]})
        xs = collect.parse_parking(text, 'parking')
        self.assertEqual(xs[0], {'la': 35.65, 'lo': 139.54, 'k': 'parking', 'n': '深大寺駐車場', 'f': 1, 'c': 40, 'm': 1})
        self.assertEqual((xs[1]['a'], xs[1]['t']), (1, 'ms'))
        self.assertEqual(len(xs), 2)
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(collect.save_park(d, xs), 2)
            self.assertEqual(len(collect.load_park(d)), 2)
            with open(os.path.join(d, 'park', 'index.json'), encoding='utf-8') as f:
                self.assertEqual(sum(json.load(f).values()), 2)

    def test_merge_fsq_parking(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            collect.save_park(d, [{'la': 35.65, 'lo': 139.54, 'k': 'park_0'}, {'la': 35.9, 'lo': 139.5, 'k': 'fsq', 'n': '古い'}])
            collect.save(os.path.join(d, 'park_fsq.json'), [{'la': 35.6501, 'lo': 139.54, 'n': '重複'}, {'la': 35.7, 'lo': 139.6, 'n': 'タイムズX'}], compact=True)
            self.assertEqual(collect.merge_fsq_parking(d), 1)
            names = sorted(p.get('n', '') for p in collect.load_park(d))
            self.assertEqual(names, ['', 'タイムズX'])  # 古い fsq は入れ替え、OSM と重なる分は足さない

    def test_annotate_parking(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            collect.save_park(d, [{'la': 35.6500, 'lo': 139.5400, 'a': 1},              # 利用者用（店のすぐ隣）
                                  {'la': 35.7004, 'lo': 139.5000, 'n': 'ガスト府中店 駐車場'},  # 店名つき
                                  {'la': 35.7509, 'lo': 139.5000}])                          # 名前なし（90m）
            os.makedirs(os.path.join(d, 'area', 'spots'))
            collect.save(os.path.join(d, 'area', 'spots', '35_139.json'), [
                {'name': 'A食堂', 'lat': 35.6503, 'lon': 139.5400},
                {'name': 'ガスト府中店', 'lat': 35.7000, 'lon': 139.5000},
                {'name': 'C商店', 'lat': 35.7501, 'lon': 139.5000},
                {'name': 'D', 'lat': 35.8, 'lon': 139.5, 'pk': 2}], compact=True)
            os.makedirs(os.path.join(d, 'cells', 'food'))
            collect.save(os.path.join(d, 'cells', 'food', '142_558.json'), [{'name': 'E', 'lat': 35.65, 'lon': 139.5401}], compact=True)
            # 名前で確かめられたガスト府中店だけ（すぐ隣の利用者用・名前なしの駐車場からは推定しない）
            self.assertEqual(collect.annotate_parking(d), 1)
            xs = collect.load(os.path.join(d, 'area', 'spots', '35_139.json'), [])
            self.assertEqual([x.get('pk') for x in xs], [None, 2, None, None])
            self.assertNotIn('pk', collect.load(os.path.join(d, 'cells', 'food', '142_558.json'), [])[0])


class OverpassRemarkTest(unittest.TestCase):
    TIMEOUT = '{"elements": [], "remark": "runtime error: Query timed out in \\"query\\" at line 1 after 181 seconds."}'

    def test_parsers_raise_on_runtime_error(self):
        with self.assertRaises(RuntimeError):
            collect.parse_overpass(self.TIMEOUT)
        with self.assertRaises(RuntimeError):
            collect.parse_osm_spots(self.TIMEOUT)


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
            ('京都府', '京都'), ('北海道', '北海道'), ('大阪府', '大阪'), ('沖縄県', '沖縄'), ('鹿児島', '鹿児島'),
            ('长野县', None), ('1231', None), ('Tokyo-to', None), ('東京市', None), ('', None), (None, None),
        ]:
            with self.subTest(raw=raw):
                self.assertEqual(collect.norm_province(raw), want)


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
        self.assertEqual(len(items), 15)                 # 名前なし 1 件・近くの同名 1 件を除く
        self.assertEqual((by['深大寺そば 玉乃屋']['genres'], by['深大寺そば 玉乃屋']['note']), (['food'], 'そば'))
        self.assertIs(by['マクドナルド 調布店']['chain'], True)
        self.assertNotIn('chain', by['森のカフェ'])
        self.assertEqual((by['森のカフェ']['note'], by['森のカフェ']['indoor'], by['森のカフェ']['url']), ('カフェ', True, 'https://cafe.example.jp/'))
        self.assertEqual((by['八王子城跡']['genres'], by['八王子城跡']['note'], by['八王子城跡']['wp']), (['heritage'], '城跡', 'ja:八王子城'))
        self.assertEqual(by['道志の湯宿']['genres'], ['lodging'])
        self.assertEqual((by['朝採り直売所']['genres'], by['朝採り直売所']['indoor']), (['souvenir'], True))
        self.assertEqual((by['相模湖ボウル']['genres'], by['相模湖ボウル']['indoor']), (['outdoor'], True))
        self.assertEqual((by['湖畔キャンプ場']['genres'], by['湖畔キャンプ場']['indoor']), (['outdoor'], False))
        self.assertEqual((by['炉端 ゆう']['g'], by['炉端 ゆう']['note']), ('food', '居酒屋'))
        self.assertEqual((by['ジェラート工房']['g'], by['ジェラート工房']['note']), ('food', 'アイス'))
        self.assertEqual((by['多摩川児童公園']['g'], by['多摩川児童公園']['genres'], by['多摩川児童公園']['note']), ('play', ['play'], '公園'))
        self.assertEqual((by['カラオケ館 調布店']['g'], by['カラオケ館 調布店']['note'], by['カラオケ館 調布店']['indoor']), ('play', 'カラオケ', True))
        self.assertNotIn('chain', by['カラオケ館 調布店'])  # 隠すチェーン店は飲食だけ（カラオケや映画館はチェーンが普通）
        self.assertEqual((by['調布市民プール']['g'], by['調布市民プール']['genres']), ('play', ['outdoor', 'play']))
        self.assertEqual((by['布多天神社']['g'], by['布多天神社']['genres'], by['布多天神社']['note']), ('temple', ['temple'], '神社'))
        self.assertEqual((by['調布古書店']['g'], by['調布古書店']['genres'], by['調布古書店']['note']), ('hobby', ['shopping'], '本屋'))
        self.assertEqual({s['g'] for s in items}, {'food', 'heritage', 'local', 'play', 'temple', 'hobby'})


def els_of(text):
    return json.loads(text)['elements']


class BuildOsmTest(unittest.TestCase):
    """全国の .osm.pbf から取り出した要素（Overpass と同じ形）→ 各データ。"""

    def test_build_and_save(self):
        import tempfile
        cafe = {'type': 'node', 'id': 900, 'lat': 35.6, 'lon': 139.5, 'tags': {'amenity': 'cafe', 'name': 'カフェ'}}
        els = {
            'pois:michinoeki': [{'type': 'node', 'id': 1, 'lat': 35.5, 'lon': 139.0, 'tags': {'name': '道の駅どうし'}}],
            # 同じ名前の展望台でも、離れていれば別の場所（全国では「展望台」が多い）
            'pois:viewpoint': [{'type': 'node', 'id': 2, 'lat': 35.5, 'lon': 139.1, 'tags': {'tourism': 'viewpoint', 'name': '展望台'}},
                               {'type': 'node', 'id': 3, 'lat': 43.0, 'lon': 141.3, 'tags': {'tourism': 'viewpoint', 'name': '展望台'}}],
            'spots:museum': els_of(fx('overpass_spots.json')),
            'spots:temple': [{'type': 'node', 'id': 77, 'lat': 34.0, 'lon': 135.0, 'tags': {'amenity': 'place_of_worship', 'name': '深大寺', 'wikipedia': 'ja:x'}}],
            'roads:pass': [{'type': 'node', 'id': 5, 'lat': 35.5, 'lon': 138.9, 'tags': {'name': '雁坂峠', 'mountain_pass': 'yes'}}],
            'moto:moto_dedicated': [{'type': 'node', 'id': 6, 'lat': 35.6, 'lon': 139.5, 'tags': {'amenity': 'motorcycle_parking'}}],
            'moto:moto_named': [{'type': 'node', 'id': 6, 'lat': 35.6, 'lon': 139.5, 'tags': {'amenity': 'motorcycle_parking', 'name': 'バイク'}}],
            'park:parking': [{'type': 'node', 'id': 7, 'lat': 35.6, 'lon': 139.5, 'tags': {'amenity': 'parking'}}],
            'jct': [{'type': 'node', 'id': 10, 'lat': 35.63357, 'lon': 139.78156, 'tags': {'name': '有明ジャンクション'}},
                    {'type': 'node', 'id': 11, 'lat': 35.63401, 'lon': 139.78201, 'tags': {'name': '有明ジャンクション'}}],  # 上下線
            'cells:restaurant': els_of(fx('overpass_cells.json')),
            'cells:cafe': els_of(fx('overpass_cells.json')) + [cafe],  # 同じ要素が複数の種類に出ても 1 件
            'pref': [{'type': 'relation', 'id': 8, 'tags': {'name': name}, 'rings': sq[0]['rings']}
                     for name, sq in (('東京都', SQUARES[:1]), ('神奈川県', SQUARES[1:]))],
        }
        curated = [{'name': '深大寺', 'lat': 35.67, 'lon': 139.55}]  # 厳選と同じ名前でも、遠くの別の場所は残す
        out = collect.build_osm(els, curated, [])
        self.assertEqual(sorted((p['k'], p['lat']) for p in out['pois'] if p['k'] == 'viewpoint'), [('viewpoint', 35.5), ('viewpoint', 43.0)])
        self.assertEqual({p['k'] for p in out['pois']}, {'michinoeki', 'viewpoint'})
        by = {s['name']: s for s in out['spots']}
        self.assertEqual(by['東京国立博物館']['pref'], '東京')   # 境界の内側
        self.assertEqual(by['某寺']['pref'], '東京')             # addr:province（神奈川）より境界の判定を優先
        self.assertEqual(by['某展望台']['pref'], 'その他')       # 境界の外で addr:province もない
        self.assertIn('深大寺', by)
        self.assertEqual(by['東京国立博物館']['k'], 'museum')
        self.assertEqual([r['name'] for r in out['roads']], ['雁坂峠'])
        self.assertEqual([x['id'] for x in out['moto']], ['osm:node:6'])
        self.assertEqual(len(out['park']), 1)
        self.assertEqual(out['jct'], [{'name': '有明JCT', 'lat': 35.63357, 'lon': 139.78156}])
        food = [x['name'] for v in out['cells']['food'].values() for x in v]
        self.assertEqual(food.count('深大寺そば 玉乃屋'), 1)
        self.assertIn('カフェ', food)
        self.assertEqual(out['cells']['food'][collect.cell_id(35.66, 139.55)][0]['pref'], '東京')
        with tempfile.TemporaryDirectory() as d:
            counts = collect.save_area(d, {k: out[k] for k in ('pois', 'spots', 'roads', 'moto')})
            self.assertEqual(counts['pois'], len(out['pois']))
            index = collect.load(os.path.join(d, 'area', 'index.json'), {})
            self.assertEqual(index['pois'], {'35_139': 2, '43_141': 1})
            self.assertEqual(index['roads'], {'35_138': 1})  # ドライブコースは始点の升目
            self.assertEqual(len(collect.load_area(d, 'pois')), 3)
            collect.save_area(d, {'pois': out['pois'][:1]})  # 作り直すと前の升目は残さない
            self.assertEqual(collect.load(os.path.join(d, 'area', 'index.json'), {}), {'pois': {'35_139': 1}})

    def test_collect_osm_failure_marks_parts(self):
        import tempfile
        status = {}
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(Exception):
                collect.collect_osm(status, NOW, [], [], root=d, pbf=os.path.join(d, 'missing.osm.pbf'))
        self.assertIsNone(status.get('osm_at'))

    def test_check_counts(self):
        collect.check_counts(None, {'cells': 10})                           # 初回は比べない
        collect.check_counts({'cells': 400000, 'pois': 500}, {'cells': 380000, 'pois': 10})  # 少ない種類（1000 未満）は見ない
        with self.assertRaises(RuntimeError):
            collect.check_counts({'cells': 400000, 'spots': 38000}, {'cells': 150000, 'spots': 38000})

    def test_collect_osm_skips_when_fresh(self):
        status = {'osm_at': '2026-10-05T00:00:00+09:00', 'osm_ver': collect.OSM_VER}
        self.assertFalse(collect.collect_osm(status, NOW, [], [], root='/nonexistent', pbf='/nonexistent.pbf'))


if __name__ == '__main__':
    unittest.main()
