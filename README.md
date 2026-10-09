# MyMap — 休日おでかけ検索

起点（初期設定：調布駅）から半径 300km（関東・甲信越・東海・南東北の一部）の遊び場・観光地・乗り物スポット・博物館・植物園・寺社・温泉・絶景・ショッピング・イベント・ツーリングルートを探せるスマホ用 Web アプリ（PWA）です。AI や有料サービスは使わず、無料で動きます。

## できること
- **スポット**（観光スポット・体験・グルメ・史跡・宿・お土産・遊び。範囲は `config.json` の `poiRadiusKm`）：移動手段（電車・車・バイク・自転車）と時間、都県、方面（北・西など）、ジャンルで絞り込み。★厳選と⭐お気に入りを先頭に表示
- **名前で検索**：ひらがな・カタカナ・全角半角の違いを無視（例：「じんだいじ」で深大寺）
- **説明と写真**：「▼詳しく」で Wikipedia の説明と写真、なければ付近の写真（Wikimedia Commons）。Google マップで写真・口コミを見るボタンつき
- **雨の日モード**：週末の天気を見て自動で ON（屋内のみ表示）
- **🎨体験**（陶芸・ガラス工房、カート・サーキット、ボルダリング、脱出ゲーム、果物狩り・牧場など）。「当日参加OKだけ」で予約不要の所に絞り込み
- **🎮シミュレーター**（フライト・ドライビング・電車の運転など）が体験できる施設で絞り込み
- **今週末のおすすめ** 3 件
- **イベント**：近隣自治体・施設のイベント一覧。募集・講座などの告知は隠せる
- **ツーリング**
  - 走り方の選択：有料道路を使わない／高速道路をなるべく使わない／バイク向け
  - ルート候補を最大 5 本並べて、時間・距離・有料の有無・景色★で比べる
  - 走って楽しい道・景色の良い道（32 本）を寄り道として通す候補、または道を選んで調布に戻る周回
  - 道沿いの立ち寄り候補（道の駅・温泉・展望台・滝・湖など）。地図の点を押すと写真と説明
  - Google マップでナビ開始（選んだルートから外れないよう経由地を自動で追加）、GPX で保存
- **屋外モード**（☀屋外）：日なた・グローブ向けに文字とボタンを大きく太く。ツーリングを開くと自動で ON
- **圏外でも**：一度開いたデータ・ルートは端末に残り、圏外でも表示できる

## スマホで使う（このリポジトリの持ち主）
1. **リポジトリを公開にする**：GitHub のリポジトリ画面 → **Settings → General** の一番下 **Danger Zone → Change visibility → Make public**。
   - 無料プランの GitHub Pages は公開リポジトリでしか使えません。公開されるのはアプリとスポット・イベントのデータだけです（お気に入り・行った記録・トークンはスマホの中にだけ保存され、公開されません）。
2. **Pages を有効にする**：**Settings → Pages** → Source を「Deploy from a branch」、Branch を **`gh-pages`** / `/ (root)` にして **Save**。1〜2 分で `https://<ユーザー名>.github.io/<リポジトリ名>/` が開けるようになります。
   - `gh-pages` は Actions が「アプリ＋最新のデータ」を組み立てて毎回上書きする公開用のブランチです（約10万件のデータを `main` の履歴に積まないため）。`main` を更新すると自動で作り直されます。
3. **スマホで開いてホーム画面に追加**
   - iPhone（Safari）：共有ボタン（□↑）→「ホーム画面に追加」
   - Android（Chrome）：右上の ⋮ →「ホーム画面に追加」または「アプリをインストール」
4. **（任意）データの自動更新**：GitHub の **Settings（個人）→ Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**。
   - Repository access：このリポジトリだけ／Permissions：**Actions を Read and write**（ほかは不要）
   - 発行した文字列をアプリの「設定」タブに貼って保存（端末の中にだけ保存されます）。データが 24 時間以上古いとき、開くと自動で収集を依頼します。
   - トークンを使わない場合は、GitHub の **Actions タブ → collect → Run workflow** で手動で更新できます。

### 使い方のコツ
- ナビは **Google マップのアプリ**で開いてください（ブラウザ版の Google マップは経由地が 3 件までしか使えません）。「有料道路を使わない」を選んだときは、Google マップ側の「ルートオプション」でも同じ設定にしてください。
- 走行中は画面を見ないでください。ツーリングタブは停車中に使う前提です（走行中の案内は Google マップの音声ナビに任せます）。
- 日なたでは「☀屋外」に。端末の明るさの自動調整をオンにし、反射防止フィルムを貼るとさらに見やすくなります。

## 自分用にコピーして使う（ほかの人）
1. このリポジトリの **Use this template → Create a new repository** で自分のアカウントにコピーする（Public）。
2. `config.json` を書き換える。
   - `origin`：起点の名前と緯度・経度（Google マップで地点を長押しすると表示されます）。
   - `github`：`owner` を自分のユーザー名、`repo` をリポジトリ名に。
   - `sources`：イベントの収集元。地元の自治体サイトの `/event.js` があれば `"type": "eventjs"` で 1 行追加できます。
   - `directionLabels`：方面の表示名（例 `"W": "西（奥多摩・山梨）"`）。
3. **Settings → Actions → General → Workflow permissions** を「Read and write permissions」にする。
4. 上の「スマホで使う」の 2〜4 を行い、**Actions タブ → collect → Run workflow** で初回のデータ収集を行う（5〜15 分）。

## データについて
- `data/spots.json`・`data/touring.json`・`data/scenic_roads.json`：手作業で選んだスポット・ツーリング目的地・おすすめの道。自由に追加・編集できます。
- `data/osm_spots.json`・`data/pois.json`・`data/cells/`（グルメなどを約 25km 四方の升目ごとに分けたもの）：OpenStreetMap から週 1 回自動収集。料金や駐車場の情報はありません。これらは `gh-pages` にだけ置かれます。
- `data/events.json`・`data/status.json`：自動生成。手で編集しないでください。
- `data/prefectures.json`：都県の判定用の境界（OpenStreetMap を簡略化したもの）。関東周辺の 10 都県のみ（それより外は「その他」）。
- 出典：地図・スポットの一部 © OpenStreetMap contributors（ODbL）／ルート Valhalla (FOSSGIS)・OSRM／天気 Open-Meteo／説明・写真 Wikipedia・Wikimedia Commons（各ページのライセンス）。
- 移動時間は直線距離からの概算です。ずれる場合は `config.json` の `speedsKmh` を調整してください。

## 開発
- 画面の確認：`python -m http.server 8000` → http://localhost:8000/
- テスト：`node lib.test.js` と `python -m unittest discover -s collector -v`
