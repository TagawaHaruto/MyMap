"""全国の OpenStreetMap データ（Geofabrik の日本全体の .osm.pbf、毎日更新）から、収集する種類の要素を取り出す。
地域ごとに Overpass に問い合わせる方式は、全国だと 1 回の実行に収まらないため、ファイルを 1 回読んで全種類を取り出す。

流れ: 1) select: 条件に合う要素だけを、参照する点・線と一緒に小さいファイルへ書き出す（BackReferenceWriter）
      2) elements: 小さいファイルを位置と面（マルチポリゴン）つきで読み、Overpass の結果と同じ形の要素
         {type, id, tags, lat/lon か center, (geometry)} にする → 収集の parse_* にそのまま渡せる
条件は Overpass の文の形（nwr["amenity"="cafe"]["name"] など）で書き、ここで解釈する。
"""
import math
import re

FILTER = re.compile(r'\[(!?)"([^"]+)"(?:(=|!=|~|!~)"((?:[^"\\]|\\.)*)")?\]')
TYPES = {'nwr': 'nwr', 'node': 'n', 'way': 'w', 'rel': 'r'}
ELEMENT = {'n': 'node', 'w': 'way', 'r': 'relation'}


def compile_stmt(stmt):
    """Overpass の 1 文 → (要素の種類 'n'/'w'/'r' を含む文字列, 目印のキー, 条件のリスト)。
    使えるのは nwr/node/way/rel と ["k"] [!"k"] ["k"="v"] ["k"!="v"] ["k"~"正規表現"] ["k"!~"正規表現"]。"""
    m = re.match(r'^(nwr|node|way|rel)(.*)$', stmt.strip())
    if not m:
        raise ValueError(f'解釈できない文: {stmt}')
    rest, tests, pos = m.group(2), [], 0
    for f in FILTER.finditer(rest):
        if f.start() != pos:
            raise ValueError(f'解釈できない条件: {stmt}')
        pos = f.end()
        neg, key, op, val = f.groups()
        if neg:
            tests.append((key, 'absent', None))
        elif not op:
            tests.append((key, 'has', None))
        elif op in ('=', '!='):
            tests.append((key, 'eq' if op == '=' else 'ne', val))
        else:
            tests.append((key, 're' if op == '~' else 'nre', re.compile(val)))
    if pos != len(rest) or not tests:
        raise ValueError(f'解釈できない条件: {stmt}')
    anchor = next((k for k, op, _ in tests if op in ('has', 'eq', 're')), None)
    if anchor is None:
        raise ValueError(f'必ずあるキーの条件が要る: {stmt}')
    return TYPES[m.group(1)], anchor, tests


def matches(c, t, tags):
    """Overpass と同じ意味: != と !~ はキーがなくても合う。正規表現は部分一致。"""
    types, _, tests = c
    if t not in types:
        return False
    for key, op, val in tests:
        v = tags.get(key)
        if op == 'has':
            ok = v is not None
        elif op == 'absent':
            ok = v is None
        elif op == 'eq':
            ok = v == val
        elif op == 'ne':
            ok = v != val
        elif op == 're':
            ok = v is not None and val.search(v) is not None
        else:
            ok = v is None or val.search(v) is None
        if not ok:
            return False
    return True


class Kinds:
    """取り出す種類の一覧: [(名前, 文 または 文のリスト)]。要素がどの種類に当たるかを調べる。"""

    def __init__(self, named):
        self.by_anchor = {}
        for name, stmts in named:
            for s in [stmts] if isinstance(stmts, str) else stmts:
                c = compile_stmt(s)
                self.by_anchor.setdefault(c[1], []).append((name, c))

    def of(self, t, tags):
        """tags は dict でも osmium の TagList でもよい（in と get だけ使う。全国分の要素ごとに dict を作ると遅いため）。"""
        out = set()
        for k, cs in self.by_anchor.items():
            if k in tags:
                for name, c in cs:
                    if name not in out and matches(c, t, tags):
                        out.add(name)
        return out


def select(src, dst, kinds):
    """条件に合う要素と、その線・面を作るのに要る点・線だけを dst に書き出す。書き出した数を返す。"""
    import osmium
    n = 0
    fp = osmium.FileProcessor(src).with_filter(osmium.filter.KeyFilter(*kinds.by_anchor))
    with osmium.BackReferenceWriter(dst, ref_src=src, overwrite=True) as w:
        for o in fp:
            if kinds.of(o.type_str(), o.tags):
                w.add(o)
                n += 1
    return n


def _center(points):
    """Overpass の center と同じく、外接矩形の中心。points は (lat, lon)。"""
    lats, lons = [p[0] for p in points], [p[1] for p in points]
    return {'lat': (min(lats) + max(lats)) / 2, 'lon': (min(lons) + max(lons)) / 2}


def elements(path, kinds, keep, geometry=(), rings=()):
    """select で作ったファイル → {種類: [要素]}。tags は keep のキーだけ残す（全国分を持つため）。
    geometry の種類は線の点の並び（Overpass の out geom）、rings の種類は面の外周（[[lon, lat], ...] のリスト）も付ける。"""
    import osmium
    out = {}
    # 位置だけのための点（タグなし）は Python に渡さない（面と線の位置はその前に記録される）
    fp = osmium.FileProcessor(path).with_locations().with_areas().with_filter(osmium.filter.EmptyTagFilter())
    for o in fp:
        if o.is_area():
            if o.from_way():  # 閉じた線はそのまま線として扱う（同じものが 2 回出ないように）
                continue
            t, oid = 'r', o.orig_id()
        else:
            t, oid = o.type_str(), o.id
            if t == 'r':  # 面にならない関係（type=site など）は位置が決まらないので使わない
                continue
        names = kinds.of(t, o.tags)
        if not names:
            continue
        el = {'type': ELEMENT[t], 'id': oid, 'tags': {tg.k: tg.v for tg in o.tags if tg.k in keep}}
        try:
            if t == 'n':
                el['lat'], el['lon'] = o.location.lat, o.location.lon
            elif t == 'w':
                pts = [(n.lat, n.lon) for n in o.nodes if n.location.valid()]
                if not pts:
                    continue
                el['center'] = _center(pts)
                if names & set(geometry):
                    el['geometry'] = [{'lat': la, 'lon': lo} for la, lo in pts]
            else:
                outer = [[(n.lat, n.lon) for n in ring] for ring in o.outer_rings()]
                pts = [p for ring in outer for p in ring]
                if not pts:
                    continue
                el['center'] = _center(pts)
                if names & set(rings):
                    el['rings'] = [[[lo, la] for la, lo in ring] for ring in outer]
        except osmium.InvalidLocationError:
            continue
        for name in names:
            out.setdefault(name, []).append(el)
    return out


class PrefIndex:
    """都道府県の境界（[{'name', 'rings': [[[lon, lat], ...], ...]}]）を約 1km の升目に塗り分けて、点の都道府県を速く引く。
    100 万件を多角形の内外判定にかけると Python では遅すぎるため。海の上（埠頭など）は近く 3 升目以内の都道府県。"""
    RES = 100  # 1 度あたりの升目の数

    def __init__(self, prefs):
        pts = [p for pref in prefs for ring in pref['rings'] for p in ring]
        self.names = [None] + [p['name'] for p in prefs]
        if not pts:
            self.x0 = self.y0 = self.w = self.h = 0
            self.grid = bytearray()
            return
        R = self.RES
        self.x0, self.y0 = math.floor(min(p[0] for p in pts) * R), math.floor(min(p[1] for p in pts) * R)
        self.w = math.floor(max(p[0] for p in pts) * R) - self.x0 + 1
        self.h = math.floor(max(p[1] for p in pts) * R) - self.y0 + 1
        self.grid = bytearray(self.w * self.h)
        for idx, pref in enumerate(prefs, 1):
            rows = {}
            for ring in pref['rings']:
                for i in range(len(ring)):
                    (xa, ya), (xb, yb) = ring[i - 1], ring[i]
                    # 升目の中心の高さ（行 r → r + 0.5）を横切る辺の、横の位置を集める（偶奇規則で塗る）
                    Ya, Yb = ya * R - self.y0 - 0.5, yb * R - self.y0 - 0.5
                    if Ya == Yb:
                        continue
                    lo, hi = min(Ya, Yb), max(Ya, Yb)
                    for r in range(math.ceil(lo), math.ceil(hi)):
                        x = xa * R - self.x0 - 0.5 + (r - Ya) * (xb - xa) * R / (Yb - Ya)
                        rows.setdefault(r, []).append(x)
            for r, xs in rows.items():
                xs.sort()
                base = r * self.w
                for i in range(0, len(xs) - 1, 2):
                    c0, c1 = max(0, math.ceil(xs[i])), min(self.w, math.ceil(xs[i + 1]))
                    if c1 > c0:
                        self.grid[base + c0:base + c1] = bytes([idx]) * (c1 - c0)

    def get(self, lat, lon):
        r, c = math.floor(lat * self.RES) - self.y0, math.floor(lon * self.RES) - self.x0
        for d in range(4):
            for dr in range(-d, d + 1):
                for dc in range(-d, d + 1):
                    if max(abs(dr), abs(dc)) != d:
                        continue
                    rr, cc = r + dr, c + dc
                    if 0 <= rr < self.h and 0 <= cc < self.w and self.grid[rr * self.w + cc]:
                        return self.names[self.grid[rr * self.w + cc]]
        return None
