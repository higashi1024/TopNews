/**
 * fetch-trends.js
 *
 * 役割:
 *   1. Google Trends RSS（全体）を取得（最大25件）
 *   2. Anthropic API でカテゴリを自動判定
 *      ※ キーワード + ニュース見出しをセットで渡すことで人名も正確に判定
 *   3. data/YYYY-MM-DD.json に保存
 *   4. 5日より古いファイルを削除
 *
 * 動作環境: Node.js 18以上
 * 必要な環境変数: ANTHROPIC_API_KEY
 */

const fs    = require("fs");
const path  = require("path");
const https = require("https");

// ================================================================
// 設定
// ================================================================
const CONFIG = {
  KEEP_DAYS:         5,
  DATA_DIR:          path.join(__dirname, "../data"),
  ASSOCIATE_ID:      "YOUR-ASSOCIATE-ID",
  GOOGLE_RSS_URL:    "https://trends.google.co.jp/trending/rss?geo=JP",
  ANTHROPIC_API_URL: "https://api.anthropic.com/v1/messages",
  ANTHROPIC_MODEL:   "claude-haiku-4-5-20251001",
};

const CATEGORIES = ["テクノロジー","経済・投資","エンタメ","ライフスタイル","スポーツ","グルメ","社会・ニュース"];

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
function parseGoogleTrendsRSS(xml) {
  const items = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemPattern.exec(xml)) !== null) {
    const block = match[1];
    const keyword = extractText(block, "title");
    if (!keyword) continue;

    const trafficMatch = block.match(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/);
    const volume = trafficMatch ? trafficMatch[1].trim() : "不明";

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

  return items;
}

// ================================================================
// Anthropic API でカテゴリ判定
// ※ キーワード + ニュース見出しをセットで渡す（人名も正確に判定できる）
// ================================================================
async function classifyWithAI(items) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY が設定されていません");

  const categoryList = CATEGORIES.join("、");

  // 各キーワードに関連ニュース見出し（1件目）を付けてリスト化
  const keywordList = items.map((item, i) => {
    const newsHint = item.news.length > 0
      ? ` (関連ニュース: 「${item.news[0].title.slice(0, 40)}」)`
      : "";
    return `${i + 1}. ${item.keyword}${newsHint}`;
  }).join("\n");

  const prompt = `以下の日本語トレンドキーワードを、それぞれ最も適切なカテゴリに分類してください。
カテゴリの選択肢: ${categoryList}

各キーワードには参考として関連ニュースの見出しを付けています。
人名・固有名詞はニュース見出しの内容を参考に判断してください。

${keywordList}

回答はJSON配列のみ返してください。配列の順番はキーワードの順番と同じにしてください。
例: ["エンタメ","スポーツ","経済・投資"]`;

  const body = JSON.stringify({
    model:      CONFIG.ANTHROPIC_MODEL,
    max_tokens: 512,
    messages:   [{ role: "user", content: prompt }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request(CONFIG.ANTHROPIC_API_URL, {
      method:  "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
      },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Anthropic API エラー: HTTP ${res.statusCode} - ${data}`));
          return;
        }
        try {
          const json     = JSON.parse(data);
          const text     = json.content[0].text.trim();
          const arrMatch = text.match(/\[[\s\S]*\]/);
          if (!arrMatch) throw new Error("JSON配列が見つかりません: " + text);
          resolve(JSON.parse(arrMatch[0]));
        } catch (e) {
          reject(new Error("レスポンス解析失敗: " + e.message));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ================================================================
// フォールバック: AIが失敗した場合のルールベース判定
// ================================================================
const FALLBACK_RULES = [
  { category: "テクノロジー",   keywords: ["AI","スマホ","iPhone","Android","PC","アプリ","ゲーム","Switch","PS5","ChatGPT","Claude","プログラミング","GPU","IT"] },
  { category: "経済・投資",     keywords: ["NISA","株","投資","Bitcoin","仮想通貨","円","ドル","銀行","ふるさと納税","確定申告","税"] },
  { category: "エンタメ",       keywords: ["映画","ドラマ","アニメ","音楽","ライブ","Netflix","YouTube","アイドル","俳優","歌手","漫画"] },
  { category: "スポーツ",       keywords: ["野球","サッカー","バスケ","テニス","ゴルフ","MLB","NBA","Jリーグ","大谷","オリンピック","選手","試合"] },
  { category: "グルメ",         keywords: ["レシピ","料理","ラーメン","寿司","スイーツ","カフェ","レストラン","食べ","グルメ","居酒屋"] },
  { category: "社会・ニュース", keywords: ["地震","台風","首相","大臣","選挙","事故","事件","裁判","政府","自民","立憲","国会","警察","火災"] },
  { category: "ライフスタイル", keywords: ["旅行","観光","ホテル","キャンプ","ファッション","美容","スキンケア","ダイエット","健康","サプリ"] },
];

function fallbackCategory(keyword) {
  for (const rule of FALLBACK_RULES) {
    for (const kw of rule.keywords) {
      if (keyword.includes(kw)) return rule.category;
    }
  }
  return "社会・ニュース";
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

  console.log("🔍 Google Trends RSS を取得中...");
  let xml;
  try {
    xml = await fetchUrl(CONFIG.GOOGLE_RSS_URL);
  } catch (err) {
    console.error("❌ RSS取得失敗:", err.message);
    process.exit(1);
  }

  const rawItems = parseGoogleTrendsRSS(xml);
  if (rawItems.length === 0) {
    console.error("❌ トレンドデータが見つかりません");
    process.exit(1);
  }
  console.log(`✅ ${rawItems.length} 件取得`);

  // AI でカテゴリ判定
  let categories;
  try {
    console.log("🤖 AI によるカテゴリ判定中（ニュース見出し付き）...");
    categories = await classifyWithAI(rawItems);
    if (!Array.isArray(categories) || categories.length !== rawItems.length) {
      throw new Error(`カテゴリ数不一致: ${categories?.length} / ${rawItems.length}`);
    }
    console.log("✅ AI カテゴリ判定完了");
  } catch (err) {
    console.warn(`⚠️ AI判定失敗 → ルールベースで代替: ${err.message}`);
    categories = rawItems.map(item => fallbackCategory(item.keyword));
  }

  // データを組み立て（全件をフラットな trends 配列に）
  const jst = new Date(Date.now() + jstOffset);
  const updatedAt = jst.toISOString().replace("Z", "+09:00");

  const trends = rawItems.map((item, i) => {
    const category = CATEGORIES.includes(categories[i])
      ? categories[i]
      : fallbackCategory(item.keyword);
    const encodedKw = encodeURIComponent(item.keyword);
    return {
      rank:          i + 1,
      keyword:       item.keyword,
      category,
      source:        "google",
      volume_approx: item.volume,
      trend:         "→0",
      news:          item.news,
      amazon_url:    `https://www.amazon.co.jp/s?k=${encodedKw}&tag=${CONFIG.ASSOCIATE_ID}`,
      rakuten_url:   `https://search.rakuten.co.jp/search/mall/${encodedKw}/`,
    };
  });

  const data = { date: today, updated_at: updatedAt, trends };
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
