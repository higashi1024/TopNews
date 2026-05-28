/**
 * fetch-trends.js
 *
 * 役割:
 *   1. カテゴリ別 Google Trends RSS を並列取得
 *   2. 各カテゴリのTOP10 + 全体TOP10 を生成
 *   3. data/YYYY-MM-DD.json に保存
 *   4. 5日より古いファイルを削除
 *
 * 動作環境: Node.js 18以上
 * 外部ライブラリ: 不要
 * 環境変数: 不要（AI判定を廃止しRSSカテゴリで直接取得）
 */

const fs    = require("fs");
const path  = require("path");
const https = require("https");

// ================================================================
// 設定
// ================================================================
const CONFIG = {
  KEEP_DAYS:    5,
  DATA_DIR:     path.join(__dirname, "../data"),
  ASSOCIATE_ID: "YOUR-ASSOCIATE-ID",  // ← Amazonアソシエイト登録後に変更
};

// カテゴリ別 RSS URL
// cat パラメータは Google Trends の公式カテゴリID
const CATEGORY_FEEDS = [
  { name: "すべて",         url: "https://trends.google.co.jp/trending/rss?geo=JP" },
  { name: "テクノロジー",   url: "https://trends.google.co.jp/trending/rss?geo=JP&cat=5" },
  { name: "経済・投資",     url: "https://trends.google.co.jp/trending/rss?geo=JP&cat=7" },
  { name: "エンタメ",       url: "https://trends.google.co.jp/trending/rss?geo=JP&cat=3" },
  { name: "ライフスタイル", url: "https://trends.google.co.jp/trending/rss?geo=JP&cat=65" },
  { name: "スポーツ",       url: "https://trends.google.co.jp/trending/rss?geo=JP&cat=20" },
  { name: "グルメ",         url: "https://trends.google.co.jp/trending/rss?geo=JP&cat=71" },
  { name: "社会・ニュース", url: "https://trends.google.co.jp/trending/rss?geo=JP&cat=16" },
];

// ================================================================
// HTTPSでURLを取得
// ================================================================
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0 TrendBot/1.0" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        fetchUrl(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        return;
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => (data += chunk));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

// ================================================================
// CDATA または通常タグからテキストを抽出
// ================================================================
function extractText(block, tag) {
  const re = new RegExp(
    `<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}>([\\s\\S]*?)<\\/${tag}>`
  );
  const m = block.match(re);
  if (!m) return "";
  return (m[1] !== undefined ? m[1] : m[2] || "").trim();
}

// ================================================================
// Google Trends RSS を解析
// ================================================================
function parseRSS(xml, categoryName) {
  const items = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemPattern.exec(xml)) !== null) {
    const block = match[1];
    const keyword = extractText(block, "title");
    if (!keyword) continue;

    const trafficMatch = block.match(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/);
    const volume = trafficMatch ? trafficMatch[1].trim() : "不明";

    // 関連ニュース記事
    const newsItems = [];
    const newsPattern = /<ht:news_item>([\s\S]*?)<\/ht:news_item>/g;
    let nm;
    while ((nm = newsPattern.exec(block)) !== null) {
      const nb = nm[1];
      const title   = extractText(nb, "ht:news_item_title");
      const snippet = extractText(nb, "ht:news_item_snippet");
      const url     = extractText(nb, "ht:news_item_url");
      const source  = extractText(nb, "ht:news_item_source");
      if (title) newsItems.push({ title, snippet, url, source });
    }

    items.push({ keyword, volume, news: newsItems });
  }

  // TOP10 に絞ってランク・カテゴリ・アフィリエイトURLを付与
  return items.slice(0, 10).map((item, i) => {
    const encodedKw = encodeURIComponent(item.keyword);
    return {
      rank:          i + 1,
      keyword:       item.keyword,
      category:      categoryName,
      source:        "google",
      volume_approx: item.volume,
      trend:         "→0",
      news:          item.news,
      amazon_url:    `https://www.amazon.co.jp/s?k=${encodedKw}&tag=${CONFIG.ASSOCIATE_ID}`,
      rakuten_url:   `https://search.rakuten.co.jp/search/mall/${encodedKw}/`,
    };
  });
}

// ================================================================
// 古いファイルを削除
// ================================================================
function deleteOldFiles() {
  if (!fs.existsSync(CONFIG.DATA_DIR)) return;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - CONFIG.KEEP_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const files = fs.readdirSync(CONFIG.DATA_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  for (const file of files) {
    if (file.replace(".json", "") < cutoffStr) {
      fs.unlinkSync(path.join(CONFIG.DATA_DIR, file));
      console.log(`🗑 削除: ${file}`);
    }
  }
}

// ================================================================
// メイン処理
// ================================================================
async function main() {
  const jstOffset = 9 * 60 * 60 * 1000;
  const today = new Date(Date.now() + jstOffset).toISOString().slice(0, 10);
  console.log(`📅 対象日: ${today}`);

  if (!fs.existsSync(CONFIG.DATA_DIR)) {
    fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
  }

  // 全カテゴリのRSSを並列取得
  console.log(`🔍 ${CATEGORY_FEEDS.length}カテゴリのRSSを並列取得中...`);
  const results = await Promise.allSettled(
    CATEGORY_FEEDS.map(feed =>
      fetchUrl(feed.url).then(xml => ({ name: feed.name, items: parseRSS(xml, feed.name) }))
    )
  );

  // カテゴリ別データを組み立て
  const categories = {};
  for (const result of results) {
    if (result.status === "fulfilled") {
      const { name, items } = result.value;
      categories[name] = items;
      console.log(`✅ ${name}: ${items.length}件`);
    } else {
      console.warn(`⚠️ 取得失敗: ${result.reason.message}`);
    }
  }

  if (Object.keys(categories).length === 0) {
    console.error("❌ 全カテゴリの取得に失敗しました");
    process.exit(1);
  }

  // 更新日時（JST）
  const jst = new Date(Date.now() + jstOffset);
  const updatedAt = jst.toISOString().replace("Z", "+09:00");

  const data = { date: today, updated_at: updatedAt, categories };

  const outPath = path.join(CONFIG.DATA_DIR, `${today}.json`);
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2), "utf8");
  console.log(`💾 保存: ${outPath}`);

  deleteOldFiles();
  console.log("🎉 完了");
}

main().catch(err => {
  console.error("予期せぬエラー:", err);
  process.exit(1);
});
