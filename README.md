# 今日の話題（Astro版）

## 構成
- `scripts/fetch-trends.cjs` … データ取得（GitHub Actions が毎時実行）
- `data/` … 当日分の全データ（5日で削除）／ `data/archive/` … 話題キーワードの履歴（こちらも直近5日分だけ残す）
- `src/pages/` … ページ。ビルド時にランキングがHTMLへ書き込まれる
- `scripts/make-story.cjs` … 「今日のお話」を作る(1日1回、`.github/workflows/daily-story.yml`)
- `src/content/stories/` … お話の保存場所(新しい10本だけ残し、古いものは自動で削除)
- `public/robots.txt`、サイトマップは自動生成

## 公開前にやること（上から順に）
1. 楽天の管理画面でアクセスキーを再発行（旧キーは公開リポジトリに残っているため）
2. GitHub の Settings → Secrets に登録：`RAKUTEN_APP_ID` `RAKUTEN_AFF_ID` `RAKUTEN_ACCESS_KEY`（`ANTHROPIC_API_KEY` は登録済み）
3. 旧リポジトリの内容をこのフォルダで置き換え、Vercel の Framework Preset を Astro にする
4. `about` `privacy` `contact` の【　】を記入し、`noindex` を外す（sitemapのfilterも外す）
5. ガイド記事は【要確認】を一次情報で確認してから本文を書く
6. Google Search Console に登録し、sitemap-index.xml を送信

## 動かし方
npm install && npm run build   （確認は npm run preview）

## 今日のお話
- 毎日 日本時間7:05に、その日のGoogleトレンド(`data/<日付>.json` の `trends` 上位)から、短い物語(フィクション)を1本作ります。
- 実在の人物・団体・事件は書かない決まりです。プロンプトで指示し、出力もプログラムで確認します(トレンドのキーワードがそのまま書かれていたら、書き直しを依頼。3回で通らなければ、その日は作らず失敗として記録)。
- 同じ日付のお話がすでにあれば、何もしません。手動で作り直すときは、`src/content/stories/<日付>.json` を消してから Actions の「Daily Story」を実行します。
- 使うモデルは、環境変数 `STORY_MODEL` で変えられます(初期値は `claude-sonnet-5-5`)。`ANTHROPIC_API_KEY` は、トレンド取得と同じものを使います。
- 送る文面の確認(APIは呼びません): `node scripts/make-story.cjs --prompt 2026-10-09`
