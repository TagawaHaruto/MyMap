# MyMap 設計書（休日おでかけ検索 PWA）

- 作成日: 2026-10-08
- リポジトリ: GitHub の MyMap リポジトリ（当面 Private）

## 1. 目的と前提

調布駅を起点に、休日の遊び場・観光地・ショッピング・イベントをスマホで手早く探す。

- 利用者: 本人と家族。ほかの人も**テンプレートとしてコピーし、自分のアカウント・自分の起点で使える**こと。
- AI（Claude 等）や有料 API を使わずに動くこと。運用費は 0 円。
- 待機中に定期実行しないこと。データ更新は「アプリを開いたときに、古ければ依頼する」方式とする。
- 好み: 乗り物（車・バイク・飛行機・ロケット・鉄道）、博物館、植物園、寺社（深大寺など）、温泉。
- 探索範囲: 関東圏（東京・神奈川・埼玉・千葉・山梨・その他関東）。

### やらないこと（必要になったら追加する）
- Instagram / X の API 利用やスクレイピング（規約違反・有料のため）。ハッシュタグ検索ページへのリンクで代替する。
- Walker+ と Peatix からの収集（規約上 NG、公開 API なし）。
- お気に入りの家族間共有、現在地を起点にする機能、スポット写真の自動取得。
- 定期実行（cron）。

## 2. 全体構成

```
[スマホ PWA]  index.html / app.js / style.css（ビルド工程なし・素の JS）
   │ 同一オリジンから読込: config.json, data/*.json
   │ 起動時: data/status.json の updated_at が 24h 超
   │   → GitHub API で collect.yml を workflow_dispatch（トークンはスマホの localStorage）
   │ その場で取得: Open-Meteo（天気）/ OSRM（ルート）/ OSM タイル（地図, Leaflet）
   ▼
[GitHub Actions] collect.yml（手動・API 起動のみ。schedule なし）
   python collector/collect.py → data/events.json, data/pois.json, data/status.json を commit
   ▼
[GitHub Pages] main ブランチのルートを配信（Public 化後）
```

- Private の間は Pages が使えないため、PC のローカルサーバー（`python -m http.server`）で確認する。同じ Wi-Fi のスマホからも確認できる。
- Actions は Private でも無料枠（月 2,000 分）で動く。1 回 2〜3 分の見込み。

## 3. ファイル構成

```
index.html               画面（1 ページ、タブ切替）
app.js                   画面ロジック全部
style.css                デジタル庁デザインシステム（DADS）トークンを使った見た目
manifest.webmanifest     PWA 設定
sw.js                    オフライン用キャッシュ（Service Worker）
config.json              ★コピーした人が書き換える唯一のファイル
data/spots.json          厳選スポット（手作業でメンテ）
data/touring.json        定番ツーリング目的地（経由地付き）
data/events.json         生成物: イベント
data/pois.json           生成物: OSM の立ち寄り候補（道の駅・温泉・展望台）
data/status.json         生成物: 全体と収集元ごとの最終成功日時・件数・エラー
collector/collect.py     収集スクリプト（Python 標準ライブラリのみ）
collector/test_collect.py
collector/fixtures/      テスト用の保存済みサンプル
.github/workflows/collect.yml
README.md                テンプレート利用手順
```

## 4. config.json

```json
{
  "origin": { "name": "調布駅", "lat": 35.6518, "lon": 139.5440 },
  "github": { "owner": "", "repo": "MyMap", "workflow": "collect.yml" },
  "staleHours": 24,
  "rainThreshold": 50,
  "speedsKmh": { "train": 30, "car": 25, "bike": 25, "bicycle": 12 },
  "trainOverheadMin": 10,
  "eventMonthsAhead": 3,
  "poiRadiusKm": 150,
  "sources": [
    { "id": "musashino", "type": "eventjs", "url": "https://www.city.musashino.lg.jp/event_city.js", "pref": "東京" },
    { "id": "doorkeeper-chofu", "type": "doorkeeper", "query": "調布", "pref": "東京" }
  ]
}
```

- `speedsKmh` と `trainOverheadMin` は移動時間の補正用の値。実際の時間とずれたらここを調整する。
- 情報源を足すときは `sources` に 1 行追加するだけにする（type が既存の部品に当てはまる場合）。

## 5. 画面

1 画面構成。上から順に次を並べる。

1. **天気バー**: 次の土日の降水確率（Open-Meteo, 起点座標）。どちらかが `rainThreshold` 以上なら雨の日モードを自動で ON。タップで手動切替。
2. **絞り込み**
   - 移動手段: 🚃電車 / 🚗車 / 🏍バイク / 🚲自転車
   - 時間: 30分 / 60分 / 90分 / 2時間 / 3時間 / 制限なし
   - 都県: 東京 / 神奈川 / 埼玉 / 千葉 / 山梨 / その他（複数選択）
   - ジャンル: 遊び / 観光 / 買い物 / 🚗乗り物 / 🏛博物館 / 🌿植物園 / ⛩寺社 / ♨温泉
3. **今週末のおすすめ**（3 件）
4. **タブ**: スポット / イベント / ツーリング / 設定

### 5.1 スポットタブ
- 絞り込み条件に合うスポットを、推定移動時間の短い順に表示する。
- カードの内容: ジャンルアイコン、名前、☔OK、推定時間、料金目安、駐車場・二輪駐車場の有無、⭐お気に入り、✓行った。
- ボタン: [地図で経路]（Google マップ）、[#Instagram]、[#X]、[公式サイト]。
- 雨の日モードでは `indoor: true` のスポットだけを表示する。

### 5.2 イベントタブ
- 期間: 今週末 / 来週末 / 今月 / 3か月。開始日順に並べる。
- 移動時間・都県の絞り込みは、位置が分かるイベントにだけ適用する。位置不明のイベントも表示し、「位置不明」と明記する。
- 雨の日モードでは `indoor: false` を隠す。`null`（判定不能）は「?」付きで表示する。
- 画面下部に収集元ごとの最終更新日時を表示し、3 日以上古いものには ⚠ を付ける。

### 5.3 ツーリングタブ
- 目的地は `touring.json` の一覧から選ぶか、地図をタップして指定する。
- オプション: ☐高速を使わない、立ち寄り範囲 1 / 3 / 5 km。
- ルートは OSRM 公開サーバー（`router.project-osrm.org/route/v1/driving/...?overview=full&geometries=geojson`）で取得する。経由地は touring.json の waypoints を使う。「高速を使わない」は `exclude=motorway` を付けて試し、拒否されたら外して再取得し、「高速回避は未対応」と表示する。
- 立ち寄り候補: spots.json と pois.json から、ルートの線までの距離が範囲内のものを選び、ルート上の進行順に並べる。
- 候補をチェックして [Google マップでナビ開始] を押すと、`https://www.google.com/maps/dir/?api=1&origin=..&destination=..&waypoints=a|b&travelmode=driving` を開く（経由地は最大 9 件）。
- OSRM が使えないときは、[Google マップで開く] ボタンだけを出す。

### 5.4 設定タブ
- 好きなジャンルの選択。
- GitHub トークンの登録・削除。説明文として「Fine-grained / 対象リポジトリ限定 / Actions: Read and write のみ」を添える。
- 「今すぐ更新」ボタン。
- データの最終更新日時。

### 5.5 今週末のおすすめ（ルールベース）
スポットごとに点数をつけ、上位 3 件を出す。

| 条件 | 点数 |
|---|---|
| 好きなジャンル | +2 |
| 週末の天気に合う（雨なら屋内、晴れなら屋外） | +2 |
| 未訪問 | +1 |
| 現在の移動条件の範囲内 | 必須 |

- 3 件はジャンルが重ならないように選ぶ。
- 同点のときは週番号を種にした擬似乱数で並べる。同じ週は同じ結果になり、週が変わると入れ替わる。

### 5.6 SNS リンク
- Instagram: `https://www.instagram.com/explore/tags/{tag}/`
- X: `https://x.com/search?q=%23{tag}`
- tag はスポットの `tags[0]`。なければ名前から空白を除いたもの。

## 6. データ形式

### spots.json（配列）
```json
{ "id": "keio-rail-land", "name": "京王れーるランド", "lat": 35.6493, "lon": 139.4044,
  "pref": "東京", "genres": ["vehicle", "play"], "indoor": true,
  "fee": "250円", "parking": { "car": false, "bike": false },
  "tags": ["京王れーるランド"], "url": "https://www.keio.co.jp/train/rail-land/",
  "note": "運転シミュレーターあり" }
```
- genres に使う値: `play` / `sightseeing` / `shopping` / `vehicle` / `museum` / `garden` / `temple` / `onsen`。
- 初期データは関東全域で 150〜200 件。乗り物系（鉄道・航空宇宙・シミュレーター・工場見学・車とバイクの博物館）、博物館、植物園、寺社、温泉、ショッピング、雨の日向け施設を厚めにする。
- 各スポットの公式サイトで、名前・住所・座標を確認してから登録する。

### touring.json（配列）
```json
{ "id": "okutama-shuyu", "name": "奥多摩周遊道路", "lat": 35.74, "lon": 139.03,
  "waypoints": [[35.78, 139.30]], "note": "景色重視の定番ルート" }
```

### events.json（配列）
```json
{ "id": "musashino:12345", "title": "...", "start": "2026-10-11", "end": "2026-10-11",
  "place": "武蔵野市民文化会館", "lat": null, "lon": null, "pref": "東京",
  "indoor": true, "url": "https://...", "source": "musashino" }
```

### pois.json（配列）
```json
{ "name": "道の駅 どうし", "lat": 35.53, "lon": 139.03, "kind": "michinoeki" }
```
- kind に使う値: `michinoeki` / `onsen` / `viewpoint`。

### status.json
```json
{ "updated_at": "2026-10-08T05:00:00+09:00",
  "sources": { "musashino": { "ok_at": "...", "count": 120, "error": null } } }
```

## 7. 収集スクリプト（collector/collect.py）

Python 標準ライブラリのみを使う（urllib, json, re, html.parser, xml）。依存パッケージなし。

### 収集の部品（type）

| type | 対象 | 方法 |
|---|---|---|
| `eventjs` | 武蔵野（2 本）・多摩・稲城・立川・昭島・川越 | `var event_data={...}` の JSON 部分を取り出す。opendays から開始日・終了日を作る。category が議会などのものは除外 |
| `jsonld` | 施設サイト全般（今後の追加用） | `<script type="application/ld+json">` 内の `@type: Event` を読む |
| `doorkeeper` | Doorkeeper | `https://api.doorkeeper.jp/events?q=..&since=..` |
| `nextdata` | 調布市文化・コミュニティ振興財団（たづくり等） | ページ内の `__NEXT_DATA__` JSON |
| `chofu_html` | 調布市イベントカレンダー（月別 HTML, type=2） | 日付・タイトル・リンクを抜き出す |
| `fuchu_html` | 府中市 list_calendar | 日付ごとの表を抜き出す |

### 取得範囲と配慮
- 初期の収集元は上の 6 種で計 11 本程度。三鷹市・狛江市・神代植物公園・味の素スタジアムなどは、動作確認のあと順次追加する。
- アクセスは 1 秒以上の間隔をあける。User-Agent は `MyMap-collector (+https://github.com/<owner>/<repo>)` とする。
- 保存するのは「今日以降に終わる」かつ「`eventMonthsAhead` か月以内に始まる」イベント。
- 重複は「タイトルと開始日が同じ」で 1 件にまとめる。

### 屋内判定と位置
- 会場名を `VENUES` 表（会場名 → 屋内フラグ・座標）と照らし合わせる。
- 表にない会場は `indoor: null`、座標は `null` とする。

### POI（立ち寄り候補）
- `pois.json` が 7 日より古い場合だけ、Overpass API で取り直す。
- 範囲は起点から `poiRadiusKm` 以内。取得条件は次の 3 つ。
  - 道の駅: `name ~ "^道の駅"`
  - 温泉: `amenity=public_bath` かつ `bath:type=onsen`
  - 展望台: `tourism=viewpoint` かつ名前あり
- カフェは関東全域だと数万件になるため、OSM からは取らない。おすすめのカフェは spots.json で扱う。

### 失敗時の扱い
- 収集元ごとに try で囲む。失敗したらその収集元の前回データを残し、status にエラーを記録する。
- 全体が失敗しても、既存の data は壊さない。書き込みは一時ファイルに書いてから置き換える。

## 8. 更新依頼の流れ（方式 C）

1. 起動時に `data/status.json` を読む（キャッシュを無効にして取得）。
2. `updated_at` が `staleHours` より古く、トークンが登録されていて、直近 10 分以内に依頼していなければ、`POST https://api.github.com/repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches`（`{"ref":"main"}`）を送る。
3. 画面には前回のデータを表示したまま、「更新中…」を出す。30 秒ごとに status.json を確認し、最大 5 分待つ。更新されたら再描画する。
4. トークンが未登録なら依頼はせず、「データが古い（設定で更新を有効化）」と表示する。
5. collect.yml は `on: workflow_dispatch` のみ。`permissions: contents: write` で data/ を commit・push する。

トークンは端末の localStorage にだけ保存し、リポジトリには入れない。権限は対象リポジトリの Actions 読み書きだけに絞る。

## 9. 見た目（DADS 準拠）

- 公式トークン CSS（`https://cdn.jsdelivr.net/npm/@digital-go-jp/design-tokens@2.0.1/dist/tokens.css`）を読み込み、`var(--color-…)` で参照する。
  - キーカラー: `--color-key-*`（Blue）
  - 文字色: `--color-neutral-solid-gray-900`。補助テキストも gray-536 より濃い色に限る（白背景でコントラスト比 4.5:1 以上）。
  - 雨の日・屋内: Light Blue
  - 警告: `--color-semantic-warning-orange-1`
  - ジャンルの色分け: DADS の基本色（緑・紫・マゼンタ・シアンなど）の 700〜900 番台
- 文字: `--font-family-sans`（Noto Sans JP）、本文 16px。
- タップできる要素は 44px 以上。枠線は隣接する背景とのコントラスト比 3:1 以上。
- 画面幅 360px で横スクロールが出ないこと。

## 10. テンプレート化

- 公開時に GitHub の「Template repository」を ON にする。
- README に次の手順を書く。
  1. Use this template でコピーする
  2. config.json の `origin` と `github` を書き換える
  3. Settings → Pages を有効化する（Public 必須）
  4. Settings → Actions の Workflow permissions を Read and write にする
  5. Fine-grained トークンを発行し、スマホのアプリ設定に貼る
  6. 初回は Actions タブから手動で collect を実行する
- spots.json は関東全域が対象なので、首都圏の人はそのまま使える。地方の人は自分で編集する。

## 11. テスト

- `collector/test_collect.py`（unittest）: type ごとに fixtures の保存済みサンプルを読み、件数・日付・タイトルが正しく取れることを確認する。重複除去と期間フィルタも確認する。
- 画面側の純粋関数（距離計算・移動時間推定・ルートまでの距離・おすすめの点数）は `app.js` に置き、`test.html` をブラウザで開くと console.assert で自己チェックできるようにする。
- 手動確認: ローカルサーバーで 360px 幅の表示、雨の日モード、ツーリングのルート表示、Google マップへの遷移。

## 12. 段階的な進め方

1. 骨組み: config・画面・spots.json（最初は 30 件程度）・天気・絞り込み。ローカルで表示できる状態にする。
2. 収集: collect.py（eventjs / doorkeeper / nextdata / chofu_html / fuchu_html / jsonld）、テスト、collect.yml。
3. 更新依頼（方式 C）と設定タブ。
4. ツーリング: OSRM・Leaflet・pois.json・立ち寄り候補・Google マップ連携。
5. spots.json を 150〜200 件に拡充し、touring.json を整備する。
6. README・テンプレート化・PWA 化（manifest / sw.js）。Public 化はユーザーの確認後に行う。
