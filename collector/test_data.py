"""手作業データ（spots / touring / config）の形式チェック。python -m unittest discover -s collector"""
import json
import os
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GENRES = {'play', 'sightseeing', 'shopping', 'vehicle', 'museum', 'garden', 'temple', 'onsen', 'scenic', 'simulator', 'factory', 'food', 'heritage', 'lodging', 'souvenir', 'outdoor'}
PREFS = {'東京', '神奈川', '埼玉', '千葉', '山梨', '群馬', '栃木', '茨城', '静岡', '長野'}
TYPES = {'eventjs', 'daylist', 'doorkeeper', 'nextdata'}


def load(name):
    with open(os.path.join(ROOT, name), encoding='utf-8') as f:
        return json.load(f)


def in_area(lat, lon):  # 関東＋隣接県のおおまかな範囲
    return 34.5 <= lat <= 37.2 and 137.8 <= lon <= 141.0


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
                self.assertEqual(set(s['parking']), {'car', 'bike'})
                self.assertTrue(s['url'].startswith('https://'))

    def test_simulator_spots(self):
        sims = [s for s in load('data/spots.json') if 'simulator' in s['genres']]
        self.assertGreaterEqual(len(sims), 20)
        self.assertTrue(all('vehicle' in s['genres'] for s in sims))

    def test_prefecture_boundaries_match_curated(self):
        # 同梱の都県境界で判定した都県が、手で確かめた厳選スポットの都県と一致すること
        import sys
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import collect
        prepared = collect.prep_prefectures(load('data/prefectures.json')['prefectures'])
        spots = load('data/spots.json')
        agree = sum(1 for s in spots if collect.pref_of(s['lat'], s['lon'], prepared) == s['pref'])
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
                self.assertTrue(r['url'].startswith('https://'))

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
