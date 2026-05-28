/**
 * fetch-trends.js
 *
 * 役割:
 *   1. Google Trends RSS（日本）を取得
 *   2. キーワードからカテゴリを自動判定
 *   3. data/YYYY-MM-DD.json に保存
 *   4. 5日より古いファイルを削除
 *
 * 動作環境: Node.js 18以上（fetch が標準搭載）
 * 外部ライブラリ: 不要（標準モジュールのみ使用）
 */

const fs   = require("fs");
const path = require("path");
const https = require("https");

// ================================================================
// 設定
// ================================================================
const CONFIG = {
  KEEP_DAYS:      5,
  DATA_DIR:       path.join(__dirname, "../data"),
  ASSOCIATE_ID:   "YOUR-ASSOCIATE-ID",   // ← Amazonアソシエイト登録後に変更

  // Google Trends RSS（日本）
  GOOGLE_RSS_URL: "https://trends.google.com/trends/trendingsearches/daily/rss?geo=JP",
};

// ================================================================
// カテゴリ自動判定
// キーワードに含まれる語句でカテゴリを決定する
// ================================================================
const CATEGORY_RULES = [
  {
    category: "テクノロジー",
    keywords: ["AI","スマホ","iPhone","Android","PC","パソコン","プログラミング",
               "Python","アプリ","ソフトウェア","ゲーム","PS5","Switch","GPU",
               "ChatGPT","Claude","Gemini","LINE","Twitter","X "],
  },
  {
    category: "経済・投資",
    keywords: ["NISA","株","投資","仮想通貨","Bitcoin","円","ドル","金融","銀行",
               "ふるさと納税","確定申告","節税","副業","副収入","フリーランス"],
  },
  {
    category: "エンタメ",
    keywords: ["映画","ドラマ","アニメ","マンガ","漫画","音楽","ライブ","コンサート",
               "Netflix","Disney","YouTube","歌手","俳優","アイドル","芸能"],
  },
  {
    category: "スポーツ",
    keywords: ["野球","サッカー","バスケ","テニス","ゴルフ","水泳","陸上","格闘技",
               "MLB","NBA","Jリーグ","プロ野球","大谷","錦織","オリンピック"],
  },
  {
    category: "グルメ",
    keywords: ["レシピ","料理","ラーメン","寿司","焼肉","スイーツ","カフェ","コーヒー",
               "レストラン","グルメ","食べ","飲み","お酒","ワイン","居酒屋"],
  },
  {
    category: "ライフスタイル",
    keywords: ["旅行","観光","ホテル","温泉","キャンプ","アウトドア","インテリア",
               "ファッション","美容","スキンケア","ダイエット","筋トレ","ヨガ",
               "プロテイン","サプリ","健康","医療"],
  },
];

function detectCategory(keyword) {
  for (const rule of CATEGORY_RULES) {
    for (const kw of rule.keywords) {
      if (keyword.includes(kw)) return rule.category;
    }
  }
  return "ライフスタイル"; // デフォルト
}

// ================================================================
// HTTPSでURLを取得（Node.js 標準モジュール使用）
// ================================================================
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0 TrendBot/1.0" } }, (res) => {
      // リダイレクト対応（最大3回）
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
// Google Trends RSS を解析
// ================================================================
function parseGoogleTrendsRSS(xml) {
  const items = [];
  // <item>〜</item> を全て抽出
  const itemPattern = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemPattern.exec(xml)) !== null) {
    const block = match[1];

    // タイトル（キーワード）
    const titleMatch = block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                       block.match(/<title>(.*?)<\/title>/);
    if (!titleMatch) continue;
    const keyword = titleMatch[1].trim();

    // 検索ボリューム（approx_traffic）
    const trafficMatch = block.match(/<ht:approx_traffic>(.*?)<\/ht:approx_traffic>/);
    const volume = trafficMatch ? trafficMatch[1].trim() : "不明";

    items.push({ keyword, volume });
  }

  return items;
}

// ================================================================
// トレンドデータを整形
// ================================================================
function buildTrendData(dateStr, rawItems) {
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const jst = new Date(now.getTime() + jstOffset);
  const updatedAt = jst.toISOString().replace("Z", "+09:00");

  const trends = rawItems.slice(0, 10).map((item, i) => {
    const keyword = item.keyword;
    const category = detectCategory(keyword);
    const encodedKw = encodeURIComponent(keyword);

    return {
      rank: i + 1,
      keyword,
      category,
      source: "google",
      volume_approx: item.volume,
      trend: "→0",  // RSS には前日比がないため固定値
      amazon_url:  `https://www.amazon.co.jp/s?k=${encodedKw}&tag=${CONFIG.ASSOCIATE_ID}`,
      rakuten_url: `https://search.rakuten.co.jp/search/mall/${encodedKw}/`,
    };
  });

  return { date: dateStr, updated_at: updatedAt, trends };
}

// ================================================================
// 古いファイル削除（KEEP_DAYS 日より古いものを消す）
// ================================================================
function deleteOldFiles() {
  if (!fs.existsSync(CONFIG.DATA_DIR)) return;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - CONFIG.KEEP_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const files = fs.readdirSync(CONFIG.DATA_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));

  for (const file of files) {
    const dateStr = file.replace(".json", "");
    if (dateStr < cutoffStr) {
      fs.unlinkSync(path.join(CONFIG.DATA_DIR, file));
      console.log(`🗑 削除: ${file}`);
    }
  }
}

// ================================================================
// メイン処理
// ================================================================
async function main() {
  // 今日の日付（JST）
  const jstOffset = 9 * 60 * 60 * 1000;
  const today = new Date(Date.now() + jstOffset).toISOString().slice(0, 10);

  console.log(`📅 対象日: ${today}`);

  // data/ ディレクトリがなければ作成
  if (!fs.existsSync(CONFIG.DATA_DIR)) {
    fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
  }

  // Google Trends RSS を取得
  console.log("🔍 Google Trends RSS を取得中...");
  let xml;
  try {
    xml = await fetchUrl(CONFIG.GOOGLE_RSS_URL);
  } catch (err) {
    console.error("❌ RSS取得失敗:", err.message);
    process.exit(1);
  }

  // RSS を解析
  const rawItems = parseGoogleTrendsRSS(xml);
  if (rawItems.length === 0) {
    console.error("❌ トレンドデータが見つかりません");
    process.exit(1);
  }
  console.log(`✅ ${rawItems.length} 件取得`);

  // JSONデータを組み立て
  const data = buildTrendData(today, rawItems);

  // ファイルに保存
  const outPath = path.join(CONFIG.DATA_DIR, `${today}.json`);
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2), "utf8");
  console.log(`💾 保存: ${outPath}`);

  // 古いファイルを削除
  deleteOldFiles();

  console.log("🎉 完了");
}

main().catch(err => {
  console.error("予期せぬエラー:", err);
  process.exit(1);
});
