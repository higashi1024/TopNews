/**
 * fetch-trends.js
 *
 * 役割:
 *   1. Google Trends RSS（日本）を取得
 *   2. Anthropic API でカテゴリを自動判定（10件まとめて1回のAPI呼び出し）
 *   3. data/YYYY-MM-DD.json に保存
 *   4. 5日より古いファイルを削除
 *
 * 動作環境: Node.js 18以上（fetch が標準搭載）
 * 外部ライブラリ: 不要（標準モジュールのみ使用）
 * 必要な環境変数: ANTHROPIC_API_KEY
 */

const fs    = require("fs");
const path  = require("path");
const https = require("https");

// ================================================================
// 設定
// ================================================================
const CONFIG = {
  KEEP_DAYS:      5,
  DATA_DIR:       path.join(__dirname, "../data"),
  ASSOCIATE_ID:   "YOUR-ASSOCIATE-ID",   // ← Amazonアソシエイト登録後に変更

  // Google Trends RSS（日本）※2025年2月にURLが変更された
  GOOGLE_RSS_URL: "https://trends.google.co.jp/trending/rss?geo=JP",

  // Anthropic API
  ANTHROPIC_API_URL: "https://api.anthropic.com/v1/messages",
  ANTHROPIC_MODEL:   "claude-haiku-4-5-20251001",  // 軽量・低コストモデルを使用
};

// カテゴリの選択肢（AIへの指示にも使用）
const CATEGORIES = ["テクノロジー", "経済・投資", "エンタメ", "ライフスタイル", "スポーツ", "グルメ", "社会・ニュース"];

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
// CDATA または通常タグからテキストを抽出するヘルパー
// ================================================================
function extractText(block, tag) {
  const escaped = tag.replace(":", "\\:");
  const re = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  const m = block.match(re);
  if (!m) return "";
  return (m[1] !== undefined ? m[1] : m[2] || "").trim();
}

// ================================================================
// Google Trends RSS を解析（ニュース記事も取得）
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
// Anthropic API で 10キーワードをまとめてカテゴリ判定
// ================================================================
async function classifyWithAI(keywords) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY が設定されていません");

  const categoryList = CATEGORIES.join("、");
  const keywordList  = keywords.map((kw, i) => `${i + 1}. ${kw}`).join("\n");

  const prompt = `以下の日本語キーワードをそれぞれ最も適切なカテゴリに分類してください。

カテゴリの選択肢: ${categoryList}

キーワード一覧:
${keywordList}

回答はJSON配列のみ返してください。配列の順番はキーワードの順番と同じにしてください。
例: ["テクノロジー","スポーツ","経済・投資"]`;

  const body = JSON.stringify({
    model:      CONFIG.ANTHROPIC_MODEL,
    max_tokens: 512,
    messages:   [{ role: "user", content: prompt }],
  });

  return new Promise((resolve, reject) => {
    const options = {
      method:   "POST",
      headers:  {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
      },
    };

    const req = https.request(CONFIG.ANTHROPIC_API_URL, options, (res) => {
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
          // JSON配列部分だけ抽出（前後に余分な文字がある場合に対応）
          const arrMatch = text.match(/\[[\s\S]*\]/);
          if (!arrMatch) throw new Error("JSON配列が見つかりません: " + text);
          const categories = JSON.parse(arrMatch[0]);
          resolve(categories);
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
  return "社会・ニュース"; // デフォルトを社会・ニュースに変更
}

// ================================================================
// トレンドデータを整形
// ================================================================
async function buildTrendData(dateStr, rawItems) {
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const jst = new Date(now.getTime() + jstOffset);
  const updatedAt = jst.toISOString().replace("Z", "+09:00");

  // RSSから取得できた全件を使用（通常20〜25件）
  const allItems = rawItems;
  const keywords = allItems.map(item => item.keyword);

  // AI でカテゴリ判定（失敗したらフォールバック）
  let categories;
  try {
    console.log("🤖 AI によるカテゴリ判定中...");
    categories = await classifyWithAI(keywords);
    // カテゴリ数がキーワード数と一致しない場合はフォールバック
    if (!Array.isArray(categories) || categories.length !== keywords.length) {
      throw new Error(`カテゴリ数不一致: ${categories.length} / ${keywords.length}`);
    }
    console.log("✅ AI カテゴリ判定完了");
  } catch (err) {
    console.warn(`⚠️ AI判定失敗 → ルールベースで代替: ${err.message}`);
    categories = keywords.map(fallbackCategory);
  }

  const trends = allItems.map((item, i) => {
    const encodedKw = encodeURIComponent(item.keyword);
    // CATEGORIES に含まれないカテゴリが返ってきた場合はフォールバック
    const category = CATEGORIES.includes(categories[i])
      ? categories[i]
      : fallbackCategory(item.keyword);

    return {
      rank:          i + 1,
      keyword:       item.keyword,
      category,
      source:        "google",
      volume_approx: item.volume,
      trend:         "→0",
      news:          item.news || [],
      amazon_url:    `https://www.amazon.co.jp/s?k=${encodedKw}&tag=${CONFIG.ASSOCIATE_ID}`,
      rakuten_url:   `https://search.rakuten.co.jp/search/mall/${encodedKw}/`,
    };
  });

  return { date: dateStr, updated_at: updatedAt, trends };
}

// ================================================================
// 古いファイル削除
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

  const data = await buildTrendData(today, rawItems);

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
