# MyMap — 休日おでかけ検索

起点（初期設定：調布駅）から、関東の遊び場・観光地・乗り物スポット・博物館・植物園・寺社・温泉・絶景・ショッピング・イベントを探せるスマホ用 Web アプリ（PWA）です。AI や有料サービスは使わず、無料で動きます。

## できること
- 移動手段（電車・車・バイク・自転車）と時間、都県、ジャンルで絞り込み
- 週末の天気を見て「雨の日モード」（屋内のみ）を自動で ON
- 今週末のおすすめ 3 件
- 近隣自治体・施設のイベント一覧（アプリを開いたとき、データが古ければ自動更新）
- ツーリング：目的地までのルートと、道沿いの立ち寄り候補（道の駅・温泉・展望台・滝・湖など）
- Instagram / X のハッシュタグ検索へのリンク

## 自分用にコピーして使う
1. このリポジトリの **Use this template → Create a new repository** で自分のアカウントにコピーする（Public）。
2. `config.json` を書き換える。
   - `origin`：起点の名前と緯度・経度（Google マップで地点を長押しすると表示されます）。
   - `github`：`owner` を自分のユーザー名、`repo` をリポジトリ名に。
   - `sources`：イベントの収集元。地元の自治体サイトの `/event.js` があれば `"type": "eventjs"` で 1 行追加できます。
3. **Settings → Pages**：Source を「Deploy from a branch」、Branch を `main` / `/ (root)` にして Save。
4. **Settings → Actions → General → Workflow permissions** を「Read and write permissions」にする。
5. **Actions タブ → collect → Run workflow** で初回のデータ収集を行う（2〜3 分）。
6. スマホで `https://<ユーザー名>.github.io/<リポジトリ名>/` を開き、共有メニューから「ホーム画面に追加」。
7. 自動更新を使う場合：GitHub の **Settings（個人）→ Developer settings → Fine-grained tokens → Generate new token**。
   - Repository access：このリポジトリだけ
   - Permissions：Actions を **Read and write**（ほかは不要）
   - 発行した文字列をアプリの「設定」タブに貼って保存（端末の中にだけ保存されます）

## データについて
- `data/spots.json`・`data/touring.json`：手作業で選んだスポットとツーリング目的地。自由に追加・編集できます。
- `data/events.json`・`data/pois.json`・`data/status.json`：自動生成。手で編集しないでください。
- 地図とスポット情報の一部は © OpenStreetMap contributors、ルートは OSRM、天気は Open-Meteo を利用しています。
- 移動時間は直線距離からの概算です。ずれる場合は `config.json` の `speedsKmh` を調整してください。

## 開発
- 画面の確認：`python -m http.server 8000` → http://localhost:8000/
- テスト：`node lib.test.js` と `python -m unittest discover -s collector -v`
