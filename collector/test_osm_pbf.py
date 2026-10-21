import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osm_pbf  # noqa: E402

try:
    import osmium  # noqa: F401  (pyosmium があるかだけ確かめる)
    HAVE_OSMIUM = True
except ImportError:
    HAVE_OSMIUM = False

# 小さな OSM ファイル: 点のカフェ、建物（閉じた線）の食堂、2 本の線でできた公園（マルチポリゴン）、名前つきの道、
# 都県の境界（正方形）、条件に合わない点
OSM = '''<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
 <node id="1" version="1" lat="35.60" lon="139.50"><tag k="amenity" v="cafe"/><tag k="name" v="森のカフェ"/><tag k="source" v="survey"/></node>
 <node id="2" version="1" lat="35.61" lon="139.51"/>
 <node id="3" version="1" lat="35.61" lon="139.53"/>
 <node id="4" version="1" lat="35.63" lon="139.53"/>
 <node id="5" version="1" lat="35.63" lon="139.51"/>
 <node id="6" version="1" lat="35.70" lon="139.60"/>
 <node id="7" version="1" lat="35.70" lon="139.70"/>
 <node id="8" version="1" lat="35.80" lon="139.70"/>
 <node id="9" version="1" lat="35.80" lon="139.60"/>
 <node id="10" version="1" lat="35.65" lon="139.40"/>
 <node id="11" version="1" lat="35.66" lon="139.42"/>
 <node id="12" version="1" lat="35.64" lon="139.45"/>
 <node id="13" version="1" lat="35.0" lon="139.0"/>
 <node id="14" version="1" lat="35.0" lon="140.0"/>
 <node id="15" version="1" lat="36.0" lon="140.0"/>
 <node id="16" version="1" lat="36.0" lon="139.0"/>
 <node id="17" version="1" lat="35.5" lon="139.5"><tag k="amenity" v="bench"/></node>
 <way id="100" version="1"><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="5"/><nd ref="2"/><tag k="amenity" v="restaurant"/><tag k="name" v="そば処"/><tag k="building" v="yes"/></way>
 <way id="101" version="1"><nd ref="6"/><nd ref="7"/><nd ref="8"/></way>
 <way id="102" version="1"><nd ref="8"/><nd ref="9"/><nd ref="6"/></way>
 <way id="103" version="1"><nd ref="10"/><nd ref="11"/><nd ref="12"/><tag k="highway" v="secondary"/><tag k="name" v="奥多摩周遊道路"/></way>
 <way id="104" version="1"><nd ref="13"/><nd ref="14"/><nd ref="15"/><nd ref="16"/><nd ref="13"/></way>
 <relation id="200" version="1"><member type="way" ref="101" role="outer"/><member type="way" ref="102" role="outer"/>
  <tag k="type" v="multipolygon"/><tag k="leisure" v="park"/><tag k="name" v="大きな公園"/></relation>
 <relation id="201" version="1"><member type="way" ref="104" role="outer"/>
  <tag k="type" v="boundary"/><tag k="boundary" v="administrative"/><tag k="admin_level" v="4"/><tag k="name" v="東京都"/></relation>
</osm>
'''


class StmtTest(unittest.TestCase):
    def test_overpass_semantics(self):
        k = osm_pbf.Kinds([
            ('cafe', 'nwr["amenity"="cafe"]["name"]'),
            ('park', 'nwr["leisure"~"^(park|playground)$"]["name"][!"wikipedia"]'),
            ('parking', 'nwr["amenity"="parking"]["access"!~"^(private|no)$"]'),
            ('road', 'way["highway"~"^(secondary|tertiary)$"]["name"~"周遊|峠"]'),
            ('michi', ['nwr["name"~"^道の駅"]', 'node["tourism"="information"]["name"~"道の駅"]']),
        ])
        self.assertEqual(k.of('n', {'amenity': 'cafe', 'name': 'A'}), {'cafe'})
        self.assertEqual(k.of('n', {'amenity': 'cafe'}), set())
        self.assertEqual(k.of('w', {'leisure': 'park', 'name': 'P'}), {'park'})
        self.assertEqual(k.of('w', {'leisure': 'park', 'name': 'P', 'wikipedia': 'ja:P'}), set())
        self.assertEqual(k.of('n', {'amenity': 'parking'}), {'parking'})                      # access がなくても合う
        self.assertEqual(k.of('n', {'amenity': 'parking', 'access': 'private'}), set())
        self.assertEqual(k.of('w', {'highway': 'secondary', 'name': '奥多摩周遊道路'}), {'road'})
        self.assertEqual(k.of('n', {'highway': 'secondary', 'name': '奥多摩周遊道路'}), set())  # way だけ
        self.assertEqual(k.of('r', {'name': '道の駅どうし', 'amenity': 'cafe'}), {'michi', 'cafe'})
        with self.assertRaises(ValueError):
            osm_pbf.compile_stmt('nwr[!"name"]')
        with self.assertRaises(ValueError):
            osm_pbf.compile_stmt('nwr["a"="b"](around:10)')

    def test_collector_queries_compile(self):
        import collect
        for name, q in collect.osm_queries():
            for s in [q] if isinstance(q, str) else q:
                osm_pbf.compile_stmt(s)


class PrefIndexTest(unittest.TestCase):
    def test_lookup(self):
        sq = lambda x0, y0, x1, y1: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
        idx = osm_pbf.PrefIndex([{'name': '東京', 'rings': [sq(139.0, 35.5, 139.9, 35.9)]},
                                 {'name': '神奈川', 'rings': [sq(139.0, 35.1, 139.8, 35.5)]},
                                 {'name': '島', 'rings': [sq(139.30, 34.60, 139.40, 34.70), sq(139.50, 34.60, 139.60, 34.70)]}])
        self.assertEqual(idx.get(35.7, 139.5), '東京')
        self.assertEqual(idx.get(35.3, 139.5), '神奈川')
        self.assertEqual(idx.get(34.65, 139.55), '島')       # 2 つ目の外周
        self.assertEqual(idx.get(34.65, 139.45), None)      # 島のあいだの海（3 升目より遠い）
        self.assertEqual(idx.get(35.7, 139.915), '東京')     # 境界のすぐ外（埠頭など）は近くの都県
        self.assertEqual(idx.get(40.0, 141.0), None)


@unittest.skipUnless(HAVE_OSMIUM, 'osmium（pyosmium）がない')
class PbfTest(unittest.TestCase):
    def test_select_and_elements(self):
        kinds = osm_pbf.Kinds([('cafe', 'nwr["amenity"="cafe"]["name"]'), ('food', 'nwr["amenity"="restaurant"]["name"]'),
                               ('park', 'nwr["leisure"="park"]["name"]'), ('road', 'way["highway"="secondary"]["name"]'),
                               ('pref', 'rel["boundary"="administrative"]["admin_level"="4"]')])
        with tempfile.TemporaryDirectory() as d:
            src, dst = os.path.join(d, 'a.osm'), os.path.join(d, 'b.osm.pbf')
            with open(src, 'w', encoding='utf-8') as f:
                f.write(OSM)
            self.assertEqual(osm_pbf.select(src, dst, kinds), 5)
            els = osm_pbf.elements(dst, kinds, keep={'amenity', 'name', 'leisure', 'highway'}, geometry=('road',), rings=('pref',))
        cafe, = els['cafe']
        self.assertEqual((cafe['type'], cafe['id'], cafe['lat'], cafe['lon'], cafe['tags']),
                         ('node', 1, 35.6, 139.5, {'amenity': 'cafe', 'name': '森のカフェ'}))  # source は捨てる
        food, = els['food']
        self.assertEqual((food['type'], food['id']), ('way', 100))
        self.assertAlmostEqual(food['center']['lat'], 35.62)
        self.assertAlmostEqual(food['center']['lon'], 139.52)
        self.assertNotIn('geometry', food)
        park, = els['park']
        self.assertEqual((park['type'], park['id']), ('relation', 200))
        self.assertAlmostEqual(park['center']['lat'], 35.75)
        self.assertAlmostEqual(park['center']['lon'], 139.65)
        road, = els['road']
        self.assertEqual([(g['lat'], g['lon']) for g in road['geometry']], [(35.65, 139.4), (35.66, 139.42), (35.64, 139.45)])
        pref, = els['pref']
        self.assertEqual(len(pref['rings']), 1)
        self.assertEqual(sorted(map(tuple, pref['rings'][0]))[0], (139.0, 35.0))


if __name__ == '__main__':
    unittest.main()
