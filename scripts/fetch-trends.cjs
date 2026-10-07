/**
 * fetch-trends.cjs
 *
 * すべて   → Google Trends RSS → AI分類 → TOP10
 * 各カテゴリ → Google News カテゴリ別RSS → TOP10
 */

const fs    = require("fs");
const path  = require("path");
const https = require("https");

// ================================================================
// 設定
// ================================================================
const CONFIG = {
  KEEP_DAYS:         7,
  DATA_DIR:          path.join(__dirname, "../data"),
  ASSOCIATE_ID:      "topnews22-22",
  GOOGLE_TRENDS_URL: "https://trends.google.co.jp/trending/rss?geo=JP",
  ANTHROPIC_API_URL: "https://api.anthropic.com/v1/messages",
  ANTHROPIC_MODEL:   "claude-haiku-4-5-20251001",
  // 秘密の値はコードに書かず、GitHub の Secrets から環境変数で受け取る
  RAKUTEN_APP_ID:    process.env.RAKUTEN_APP_ID || "",
  RAKUTEN_AFF_ID:    process.env.RAKUTEN_AFF_ID || "",
  RAKUTEN_ACCESS_KEY:process.env.RAKUTEN_ACCESS_KEY || "",
  GADGET_KEYWORD:    process.env.GADGET_KEYWORD || "モバイルバッテリー",
  ARCHIVE_DIR:       path.join(__dirname, "../data/archive"),
};

// カテゴリ別 Google News RSS
const CATEGORY_SOURCES = [
  { name: "テクノロジー",   url: "https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=ja&gl=JP&ceid=JP:ja" },
  { name: "経済・投資",     url: "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=ja&gl=JP&ceid=JP:ja" },
  { name: "エンタメ",       url: "https://news.google.com/rss/headlines/section/topic/ENTERTAINMENT?hl=ja&gl=JP&ceid=JP:ja" },
  { name: "ライフスタイル", url: "https://news.google.com/rss/headlines/section/topic/HEALTH?hl=ja&gl=JP&ceid=JP:ja" },
  { name: "スポーツ",       url: "https://news.google.com/rss/headlines/section/topic/SPORTS?hl=ja&gl=JP&ceid=JP:ja" },
  { name: "グルメ",         url: "https://news.google.com/rss/search?q=グルメ+料理+レシピ&hl=ja&gl=JP&ceid=JP:ja" },
  { name: "社会・ニュース", url: "https://news.google.com/rss/headlines/section/topic/NATION?hl=ja&gl=JP&ceid=JP:ja" },
];

const CATEGORIES = ["テクノロジー","経済・投資","エンタメ","ライフスタイル","スポーツ","グルメ","社会・ニュース"];

// ================================================================
// HTTPSでURLを取得
// ================================================================
const FETCH_TIMEOUT_MS = 15000; // 15秒でタイムアウト

// カスタムヘッダー付きHTTPS GET
function fetchUrlWithHeaders(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path:     parsedUrl.pathname + parsedUrl.search,
      method:   "GET",
      headers:  {
        "User-Agent": "Mozilla/5.0 TrendBot/1.0",
        ...extraHeaders,
      },
    };
    const req = https.request(options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        fetchUrlWithHeaders(res.headers.location, extraHeaders).then(resolve).catch(reject);
        return;
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          // エラー本文を含めてreject（デバッグ用）
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
          return;
        }
        resolve(data);
      });
    });
    req.on("error", reject);
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error(`タイムアウト: ${new URL(url).hostname}`));
    });
    req.end();
  });
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0 TrendBot/1.0" } }, (res) => {
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
    });
    req.on("error", reject);
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error(`タイムアウト: ${new URL(url).hostname}`));
    });
  });
}

// ================================================================
// テキスト抽出ヘルパー
// ================================================================
function extractText(block, tag) {
  const re = new RegExp(
    `<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}>([\\s\\S]*?)<\\/${tag}>`
  );
  const m = block.match(re);
  if (!m) return "";
  return (m[1] !== undefined ? m[1] : m[2] || "").trim();
}

function decodeHtml(str) {
  return str
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/<[^>]+>/g, "").trim();
}

// ================================================================
// Google Trends RSS を解析
// ================================================================
function parseTrendsRSS(xml) {
  const items = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemPattern.exec(xml)) !== null) {
    const block = match[1];
    const keyword = extractText(block, "title");
    if (!keyword) continue;
    const trafficMatch = block.match(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/);
    const volume = trafficMatch ? trafficMatch[1].trim() : "";
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
// Google News RSS を解析
// ================================================================
function parseNewsRSS(xml, categoryName) {
  const items = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemPattern.exec(xml)) !== null) {
    const block = match[1];

    // タイトル
    const titleRaw = extractText(block, "title") ||
      (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
    const title = decodeHtml(titleRaw);
    if (!title) continue;

    // URL（link または guid）
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/) ||
                      block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
    const url = linkMatch ? linkMatch[1].trim() : "";

    // 概要（description から HTML タグ除去）
    const descRaw = extractText(block, "description") ||
      (block.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || "";
    const snippet = decodeHtml(descRaw).slice(0, 120);

    // 発行元
    const sourceMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/);
    const publisher = sourceMatch ? decodeHtml(sourceMatch[1]) : "";

    // 公開時刻（RSSの pubDate。取れなければ空文字）
    const pubMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const pubDate = pubMatch ? new Date(pubMatch[1].trim()) : null;
    const published = pubDate && !isNaN(pubDate.getTime()) ? pubDate.toISOString() : "";

    items.push({ title, url, snippet, publisher, published });
  }

  return items.slice(0, 50).map((item, i) => {
    // アフィリエイト検索用：見出しの先頭30文字
    const searchKw = encodeURIComponent(item.title.slice(0, 30));
    return {
      rank:          i + 1,
      keyword:       item.title,
      category:      categoryName,
      source:        "google_news",
      type:          "news",
      volume_approx: "",
      trend:         "",
      news:          [{ title: item.title, snippet: item.snippet, url: item.url, source: item.publisher, published: item.published }],
      amazon_url:    `https://www.amazon.co.jp/s?k=${searchKw}&tag=${CONFIG.ASSOCIATE_ID}`,
      rakuten_url:   `https://hb.afl.rakuten.co.jp/hgc/${CONFIG.RAKUTEN_AFF_ID}/?pc=https%3A%2F%2Fsearch.rakuten.co.jp%2Fsearch%2Fmall%2F${searchKw}%2F&link_type=hybrid_url`,
    };
  });
}

// ================================================================
// Anthropic API でカテゴリ判定（すべて用）
// ================================================================
async function classifyWithAI(items) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY が設定されていません");
  const categoryList = CATEGORIES.join("、");
  const keywordList = items.map((item, i) => {
    const hint = item.news.length > 0
      ? ` (関連ニュース: 「${item.news[0].title.slice(0, 40)}」)` : "";
    return `${i + 1}. ${item.keyword}${hint}`;
  }).join("\n");
  const prompt = `以下の日本語トレンドキーワードを最も適切なカテゴリに分類してください。
カテゴリ: ${categoryList}
人名・固有名詞はニュース見出しを参考に判断してください。

${keywordList}

JSON配列のみ返してください: ["エンタメ","スポーツ",...]`;

  const body = JSON.stringify({
    model: CONFIG.ANTHROPIC_MODEL, max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });
  return new Promise((resolve, reject) => {
    const req = https.request(CONFIG.ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Anthropic API エラー: HTTP ${res.statusCode}`)); return;
        }
        try {
          const json = JSON.parse(data);
          const text = json.content[0].text.trim();
          const arr  = text.match(/\[[\s\S]*\]/);
          if (!arr) throw new Error("JSON配列なし");
          resolve(JSON.parse(arr[0]));
        } catch (e) { reject(new Error("解析失敗: " + e.message)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error("Anthropic API タイムアウト（30秒）"));
    });
    req.write(body); req.end();
  });
}

// フォールバック判定
const FALLBACK_RULES = [
  { category: "テクノロジー",   keywords: ["AI","スマホ","iPhone","Android","PC","アプリ","ゲーム","Switch","PS5","ChatGPT","Claude","プログラミング","GPU","IT"] },
  { category: "経済・投資",     keywords: ["NISA","株","投資","Bitcoin","仮想通貨","円","ドル","銀行","ふるさと納税","確定申告","税"] },
  { category: "エンタメ",       keywords: ["映画","ドラマ","アニメ","音楽","ライブ","Netflix","YouTube","アイドル","俳優","歌手","漫画"] },
  { category: "スポーツ",       keywords: ["野球","サッカー","バスケ","テニス","ゴルフ","MLB","NBA","Jリーグ","大谷","オリンピック","選手","試合"] },
  { category: "グルメ",         keywords: ["レシピ","料理","ラーメン","寿司","スイーツ","カフェ","レストラン","食べ","グルメ","居酒屋"] },
  { category: "社会・ニュース", keywords: ["地震","台風","首相","大臣","選挙","事故","事件","裁判","政府","警察","火災"] },
  { category: "ライフスタイル", keywords: ["旅行","観光","ホテル","キャンプ","ファッション","美容","スキンケア","ダイエット","健康","サプリ"] },
];
function fallbackCategory(kw) {
  for (const r of FALLBACK_RULES) for (const k of r.keywords) if (kw.includes(k)) return r.category;
  return "社会・ニュース";
}

// ================================================================
// 古いファイルを削除
// ================================================================
function deleteOldFiles() {
  // data/ と data/archive/ の両方で、新しい日付から数えて KEEP_DAYS 日分だけ残す
  for (const dir of [CONFIG.DATA_DIR, CONFIG.ARCHIVE_DIR]) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
    for (const file of files.slice(CONFIG.KEEP_DAYS)) {
      fs.unlinkSync(path.join(dir, file));
      console.log(`🗑 削除: ${path.basename(dir)}/${file}`);
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
  if (!fs.existsSync(CONFIG.DATA_DIR)) fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });

  // ── すべて：Google Trends RSS + AI分類 ──
  console.log("🔍 Google Trends RSS を取得中...");
  let trendsItems = [];
  try {
    const xml      = await fetchUrl(CONFIG.GOOGLE_TRENDS_URL);
    const rawItems = parseTrendsRSS(xml);
    console.log(`✅ Trends: ${rawItems.length} 件取得`);

    let cats;
    try {
      console.log("🤖 AI カテゴリ判定中...");
      cats = await classifyWithAI(rawItems);
      if (!Array.isArray(cats) || cats.length !== rawItems.length) throw new Error("件数不一致");
      console.log("✅ AI 判定完了");
    } catch (err) {
      console.warn(`⚠️ AI失敗 → ルールベース: ${err.message}`);
      cats = rawItems.map(item => fallbackCategory(item.keyword));
    }

    trendsItems = rawItems.slice(0, 25).map((item, i) => {
      const cat = CATEGORIES.includes(cats[i]) ? cats[i] : fallbackCategory(item.keyword);
      const enc = encodeURIComponent(item.keyword);
      return {
        rank: i + 1, keyword: item.keyword, category: cat,
        source: "google", type: "trend",
        volume_approx: item.volume, trend: "→0",
        news: item.news,
        amazon_url:  `https://www.amazon.co.jp/s?k=${enc}&tag=${CONFIG.ASSOCIATE_ID}`,
        rakuten_url: `https://hb.afl.rakuten.co.jp/hgc/${CONFIG.RAKUTEN_AFF_ID}/?pc=https%3A%2F%2Fsearch.rakuten.co.jp%2Fsearch%2Fmall%2F${enc}%2F&link_type=hybrid_url`,
      };
    });
  } catch (err) {
    console.error("❌ Trends取得失敗:", err.message);
  }

  // ── カテゴリ別：Google News RSS ──
  console.log("📰 Google News RSS を並列取得中...");
  const categoryResults = await Promise.allSettled(
    CATEGORY_SOURCES.map(src =>
      fetchUrl(src.url).then(xml => ({ name: src.name, items: parseNewsRSS(xml, src.name) }))
    )
  );

  const categories = {};
  for (const result of categoryResults) {
    if (result.status === "fulfilled") {
      const { name, items } = result.value;
      categories[name] = items;
      console.log(`✅ ${name}: ${items.length}件`);
    } else {
      console.warn(`⚠️ 取得失敗: ${result.reason.message}`);
    }
  }

  // ── 楽天商品検索API ──
  // おすすめ商品は「1日1回」だけ更新する。
  //  - 今日のデータに商品が既にあれば、それをそのまま使う（毎時の実行では取り直さない）
  //  - なければ、今日のトレンドキーワードを上位から順に検索し、商品が見つかった最初のキーワードを使う
  //  - どれも見つからなければ、GADGET_KEYWORD（既定:モバイルバッテリー）で検索する
  async function searchRakuten(keyword) {
    const rakutenParams = new URLSearchParams({
      applicationId: CONFIG.RAKUTEN_APP_ID,
      accessKey:     CONFIG.RAKUTEN_ACCESS_KEY,
      keyword,
      hits:          "30",  // 楽天APIの上限は30件
      format:        "json",
    });
    // アフィリエイトIDを渡すと、商品リンクがアフィリエイト用URL(affiliateUrl)で返る想定（公式仕様は未確認。動作確認が必要）
    if (CONFIG.RAKUTEN_AFF_ID) rakutenParams.set("affiliateId", CONFIG.RAKUTEN_AFF_ID);
    const rakutenApiUrl = "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260401?" + rakutenParams.toString();
    const rakutenRes = await fetchUrlWithHeaders(rakutenApiUrl, {
      "Authorization": `Bearer ${CONFIG.RAKUTEN_ACCESS_KEY}`,
      "Referer":       "https://top-news-kappa.vercel.app/",
      "Origin":        "https://top-news-kappa.vercel.app",
    });
    const rakutenJson = JSON.parse(rakutenRes);
    // 「ふるさと納税」の返礼品は紹介対象外にする
    const items = (rakutenJson.Items || []).filter(it => !String((it.itemName || (it.Item && it.Item.itemName) || "")).includes("ふるさと納税"));
    return items.map((it, i) => {
      // formatVersion=2はフラット、1はit.Item形式
      const item = it.itemName ? it : (it.Item || it);
      const imgUrl = Array.isArray(item.mediumImageUrls)
        ? (item.mediumImageUrls[0]?.imageUrl || item.mediumImageUrls[0] || "")
        : "";
      return {
        rank:       i + 1,
        name:       (item.itemName || "").slice(0, 40),
        price:      item.itemPrice ? `¥${Number(item.itemPrice).toLocaleString()}` : "",
        image:      imgUrl,
        rakutenUrl: item.affiliateUrl || item.itemUrl || "",
        amazonUrl:  `https://www.amazon.co.jp/s?k=${encodeURIComponent((item.itemName || "").slice(0, 20))}&tag=${CONFIG.ASSOCIATE_ID}`,
      };
    });
  }

  let gadgets = [];
  let gadgetsKeyword = "";
  try {
    const todayFile = path.join(CONFIG.DATA_DIR, `${today}.json`);
    const prev = fs.existsSync(todayFile) ? JSON.parse(fs.readFileSync(todayFile, "utf8")) : null;
    if (prev && Array.isArray(prev.gadgets) && prev.gadgets.length > 0 && prev.gadgets_keyword) {
      gadgets = prev.gadgets;
      gadgetsKeyword = prev.gadgets_keyword;
      console.log(`🛍 今日の商品は取得済みのため再利用: 「${gadgetsKeyword}」${gadgets.length}件`);
    } else {
      console.log("🛍 おすすめ商品を取得中（1日1回）...");
      const candidates = [...trendsItems.slice(0, 5).map(t => t.keyword), CONFIG.GADGET_KEYWORD];
      for (const kw of candidates) {
        try {
          const found = await searchRakuten(kw);
          if (found.length >= 5) { gadgets = found; gadgetsKeyword = kw; break; }
          console.log(`  「${kw}」は商品が少ないため次の候補へ（${found.length}件）`);
        } catch (err) {
          console.warn(`  「${kw}」の検索失敗: ${err.message}`);
        }
      }
      if (gadgets.length > 0) console.log(`✅ おすすめ商品: 「${gadgetsKeyword}」${gadgets.length}件`);
      else if (prev && Array.isArray(prev.gadgets) && prev.gadgets.length > 0) {
        // 取得に失敗したときは、前回の商品を残す
        gadgets = prev.gadgets;
        gadgetsKeyword = prev.gadgets_keyword || "";
        console.log("⚠️ 商品を取得できなかったため、前回の商品を残します");
      }
    }
  } catch (err) {
    console.warn(`⚠️ 楽天商品の取得失敗: ${err.message}`);
  }

  // ── JSON保存 ──
  const updatedAt = new Date(Date.now() + jstOffset).toISOString().replace("Z", "+09:00");
  const data = { date: today, updated_at: updatedAt, trends: trendsItems, categories, gadgets, gadgets_keyword: gadgetsKeyword };
  const outPath = path.join(CONFIG.DATA_DIR, `${today}.json`);
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2), "utf8");
  console.log(`💾 保存: ${outPath}`);

  // 履歴：話題キーワードだけを別フォルダに保存（KEEP_DAYS日分だけ残す）
  if (trendsItems.length > 0) {
    if (!fs.existsSync(CONFIG.ARCHIVE_DIR)) fs.mkdirSync(CONFIG.ARCHIVE_DIR, { recursive: true });
    const slim = trendsItems.map(({ rank, keyword, category, volume_approx }) => ({ rank, keyword, category, volume_approx }));
    fs.writeFileSync(path.join(CONFIG.ARCHIVE_DIR, `${today}.json`),
      JSON.stringify({ date: today, updated_at: updatedAt, trends: slim }, null, 2), "utf8");
    console.log(`📚 履歴保存: ${today}`);
  }

  deleteOldFiles();
  console.log("🎉 完了");
}

main().catch(err => { console.error("エラー:", err); process.exit(1); });
