"""手作業データ（spots / touring / config）の形式チェック。python -m unittest discover -s collector"""
import json
import os
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GENRES = {'play', 'sightseeing', 'shopping', 'vehicle', 'museum', 'garden', 'temple', 'onsen', 'scenic', 'simulator', 'factory', 'food', 'heritage', 'lodging', 'souvenir', 'outdoor', 'experience', 'viewpoint', 'nightview'}
PREFS = set('北海道 青森 岩手 宮城 秋田 山形 福島 茨城 栃木 群馬 埼玉 千葉 東京 神奈川 新潟 富山 石川 福井 山梨 長野 岐阜 静岡 愛知 三重 '
            '滋賀 京都 大阪 兵庫 奈良 和歌山 鳥取 島根 岡山 広島 山口 徳島 香川 愛媛 高知 福岡 佐賀 長崎 熊本 大分 宮崎 鹿児島 沖縄'.split())
TYPES = {'eventjs', 'daylist', 'doorkeeper', 'nextdata'}


def load(name):
    with open(os.path.join(ROOT, name), encoding='utf-8') as f:
        return json.load(f)


def in_area(lat, lon):  # 日本の範囲（データは全国。手作業のデータも全国に置ける）
    return 20.0 <= lat <= 46.0 and 122.0 <= lon <= 154.0


class DataTest(unittest.TestCase):
    def test_spots(self):
        spots = load('data/spots.json')
        self.assertGreaterEqual(len(spots), 150)
        self.assertEqual(len({s['id'] for s in spots}), len(spots), 'id が重複')
        for s in spots:
            with self.subTest(s.get('id')):
                for k in ('id', 'name', 'lat', 'lon', 'pref', 'genres', 'indoor', 'fee', 'parking', 'tags', 'url', 'note'):
                    self.assertIn(k, s)
                self.assertTrue(in_area(s['lat'], s['lon']))
                self.assertIn(s['pref'], PREFS)
                self.assertTrue(s['genres'] and set(s['genres']) <= GENRES, s['genres'])
                self.assertIsInstance(s['indoor'], bool)
                # 駐車場が確かでないものは null（推定で書かない）。URL は分からなければ空
                self.assertTrue(s['parking'] is None or set(s['parking']) == {'car', 'bike'})
                self.assertTrue(s['url'] == '' or s['url'].startswith('https://'))

    def test_simulator_spots(self):
        sims = [s for s in load('data/spots.json') if 'simulator' in s['genres']]
        self.assertGreaterEqual(len(sims), 20)
        self.assertTrue(all('vehicle' in s['genres'] for s in sims))

    def test_prefecture_boundaries_match_curated(self):
        # 都道府県の境界を約 1km の升目に塗り分けて引く方法（全国の収集で使う）で、手で確かめた厳選スポットの都県と一致すること
        # （data/prefectures.json は関東周辺 10 都県の境界。この確認のためだけに置いている）
        import sys
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import osm_pbf
        index = osm_pbf.PrefIndex(load('data/prefectures.json')['prefectures'])
        spots = load('data/spots.json')
        agree = sum(1 for s in spots if index.get(s['lat'], s['lon']) == s['pref'])
        self.assertGreaterEqual(agree / len(spots), 0.98, f'{agree}/{len(spots)}')

    def test_scenic_roads(self):
        roads = load('data/scenic_roads.json')
        self.assertGreaterEqual(len(roads), 25)
        self.assertEqual(len({r['id'] for r in roads}), len(roads), 'id が重複')
        for r in roads:
            with self.subTest(r.get('id')):
                for k in ('id', 'name', 'kana', 'points', 'toll', 'fee', 'closed', 'closedMonths', 'note', 'tags', 'url'):
                    self.assertIn(k, r)
                self.assertTrue(3 <= len(r['points']) <= 6, len(r['points']))
                for lat, lon in r['points']:
                    self.assertTrue(in_area(lat, lon))
                self.assertIsInstance(r['toll'], bool)
                self.assertTrue(all(1 <= m <= 12 for m in r['closedMonths']))
                self.assertTrue(r['url'] == '' or r['url'].startswith('https://'))

    def test_factory_tours(self):
        tours = [s for s in load('data/spots.json') if 'factory' in s['genres']]
        self.assertGreaterEqual(len(tours), 50)
        for s in tours:
            with self.subTest(s['id']):
                self.assertIsInstance(s.get('walkin'), bool)   # 当日参加OK の絞り込みに使う
                self.assertTrue(s.get('booking'))

    def test_experiences(self):
        xs = [s for s in load('data/spots.json') if 'experience' in s['genres']]
        self.assertGreaterEqual(len(xs), 60)
        for s in xs:
            self.assertIsInstance(s.get('walkin'), bool, s['id'])

    def test_touring(self):
        tours = load('data/touring.json')
        self.assertGreaterEqual(len(tours), 8)
        for t in tours:
            with self.subTest(t.get('id')):
                self.assertTrue(in_area(t['lat'], t['lon']))
                self.assertLessEqual(len(t['waypoints']), 5)
                for lat, lon in t['waypoints']:
                    self.assertTrue(in_area(lat, lon))

    def test_config(self):
        cfg = load('config.json')
        self.assertTrue(in_area(cfg['origin']['lat'], cfg['origin']['lon']))
        self.assertEqual(set(cfg['speedsKmh']), {'train', 'car', 'bike', 'bicycle'})
        self.assertEqual(len({s['id'] for s in cfg['sources']}), len(cfg['sources']))
        for s in cfg['sources']:
            self.assertIn(s['type'], TYPES)
            self.assertTrue(in_area(s['lat'], s['lon']))


if __name__ == '__main__':
    unittest.main()
