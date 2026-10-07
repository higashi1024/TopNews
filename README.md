# 今日の話題（Astro版）

## 構成
- `scripts/fetch-trends.cjs` … データ取得（GitHub Actions が毎時実行）
- `data/` … 当日分の全データ（5日で削除）／ `data/archive/` … 話題キーワードの履歴（こちらも直近5日分だけ残す）
- `src/pages/` … ページ。ビルド時にランキングがHTMLへ書き込まれる
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
