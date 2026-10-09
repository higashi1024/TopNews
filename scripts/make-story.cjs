// 「今日のお話」: その日のGoogleトレンド(日本)から、短い物語(フィクション)を1本作り、
// src/content/stories/<日付>.json に保存する。
//  - 1日1回(GitHub Actions)。同じ日付のファイルが既にあれば、何もしない(APIも呼ばない)。
//  - 保存は新しい KEEP 本まで。それより古いファイルは削除する(Gitの履歴には残る)。
//  - 実在の人物・団体・事件は書かない(プロンプトで指示し、出力もプログラムで確認する)。
// 使い方: node scripts/make-story.cjs [日付]   (日付を省略すると、日本時間の今日)
//         node scripts/make-story.cjs --prompt [日付]   (APIを呼ばず、送る文面だけを表示)
const fs = require("fs");
const path = require("path");
const https = require("https");

const CONFIG = {
  KEEP: 10,                 // 保存する本数
  TOP_N: 8,                 // 題材の候補にするトレンドの数(上位から)
  MAX_ATTEMPTS: 3,          // 確認に通らなかったとき、書き直しを依頼する回数(最初の1回を含む)
  MODEL: process.env.STORY_MODEL || "claude-sonnet-5-5",
  API_URL: "https://api.anthropic.com/v1/messages",
  DATA_DIR: path.join(__dirname, "../data"),
  OUT_DIR: path.join(__dirname, "../src/content/stories"),
};

const DATE_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;

function jstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// その日のトレンド上位を、(キーワード, 関連ニュースの見出し)の形で取り出す
function loadTrends(date) {
  const file = path.join(CONFIG.DATA_DIR, `${date}.json`);
  if (!fs.existsSync(file)) throw new Error(`${file} がありません(先にトレンドの取得が必要です)`);
  const src = JSON.parse(fs.readFileSync(file, "utf8"));
  return (src.trends || []).slice(0, CONFIG.TOP_N).map((t) => ({
    keyword: String(t.keyword || "").trim(),
    headline: String(((t.news || [])[0] || {}).title || "").slice(0, 60),
  })).filter((t) => t.keyword);
}

function buildPrompt(date, trends) {
  const list = trends.map((t, i) => `${i + 1}. ${t.keyword}${t.headline ? `(関連ニュースの見出し: ${t.headline})` : ""}`).join("\n");
  return `あなたは短編作家です。次は ${date} のGoogleトレンド(日本)の急上昇キーワードです。

${list}

この中から2〜4個の話題を選び、それらを自然に織り込んだ、日本語の短い物語(フィクション)を1本書いてください。

【守ること】
- 登場人物・会社・団体・店・地名は、すべて架空にする。
- トレンドに出てくる実在の人名・団体名・企業名・商品名・番組名・作品名・キャラクター名は、本文に一切書かない。「野球」「新幹線」「コーヒー店のバッグ」のような一般的な言葉に置きかえる。キーワードの文字列そのものも、本文に書かない。
- 事件・事故・逮捕・裁判・病気・死亡・災害・個人情報の流出・炎上など、実在の被害者や加害者がいるかもしれない話題は使わない。
- 政治家・芸能人・スポーツ選手など、実在の人物についての話題(疑惑・批判・発言・私生活・結婚など)は使わない。使うなら、人物ではなく「野球」「ドラマ」「朝の情報番組」のような、一般的な題材だけにする。
- 選ばなかったキーワードは excluded_keywords に、理由を一言そえて入れる。
- ニュースの内容を事実として書かない。出来事の理由や経緯を、推測で書かない(見出しは話題の雰囲気をつかむための参考にとどめる)。
- 暴力や性的な表現は入れない。読み終えて、おだやかな気持ちになる話にする。
- 長さは本文あわせて800〜1500字。段落は4〜8つ。

【出力】次のJSONだけを出力する(前後に説明やコードブロックを付けない)。
{"title":"題名(30字以内)","themes":["題材にした話題を、一般的な言葉で(例: 野球)"],"used_keywords":["使ったキーワード(上の一覧のまま)"],"excluded_keywords":[{"keyword":"使わなかったキーワード","reason":"理由"}],"paragraphs":["段落1","段落2"]}`;
}

function callClaude(messages) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return Promise.reject(new Error("ANTHROPIC_API_KEY が設定されていません"));
  const body = JSON.stringify({ model: CONFIG.MODEL, max_tokens: 4000, messages });
  return new Promise((resolve, reject) => {
    const req = https.request(CONFIG.API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode !== 200) { reject(new Error(`Anthropic API エラー: HTTP ${res.statusCode} ${data.slice(0, 300)}`)); return; }
        try {
          const text = (JSON.parse(data).content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
          resolve(text);
        } catch (e) { reject(new Error(`API応答を読めませんでした: ${e.message}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(120000, () => req.destroy(new Error("Anthropic API タイムアウト(120秒)")));
    req.write(body);
    req.end();
  });
}

// モデルの出力(文字列)を読み取り、決めた条件を満たすか確認する。
// 満たさないときは、理由(日本語)つきの Error を投げる。
function parseAndValidate(text, trends) {
  let obj;
  try {
    const m = /\{[\s\S]*\}/.exec(text);
    obj = JSON.parse(m ? m[0] : text);
  } catch (e) { throw new Error("JSONとして読めませんでした。JSONだけを出力してください"); }

  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  if (!title || title.length > 40) throw new Error("title が空、または40字を超えています");
  if (!Array.isArray(obj.paragraphs) || obj.paragraphs.some((p) => typeof p !== "string" || !p.trim())) throw new Error("paragraphs は、空でない文字列の配列にしてください");
  const paragraphs = obj.paragraphs.map((p) => p.trim());
  if (paragraphs.length < 3 || paragraphs.length > 12) throw new Error("段落は3〜12個にしてください");
  const total = paragraphs.join("").length;
  if (total < 500 || total > 2500) throw new Error(`本文の長さが範囲外です(${total}字。500〜2500字にしてください)`);

  const keywords = trends.map((t) => t.keyword);
  const used = Array.isArray(obj.used_keywords) ? obj.used_keywords.filter((k) => keywords.includes(k)) : [];
  if (used.length < 1) throw new Error("used_keywords に、一覧にあるキーワードを1つ以上入れてください");
  const themes = Array.isArray(obj.themes) ? obj.themes.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim()) : [];
  if (themes.length < 1) throw new Error("themes を1つ以上入れてください");

  // 実在の名前などが入りやすいので、トレンドのキーワードそのものが、題名・本文・題材に入っていたらやり直し
  // (空白や中点を除き、英字は小文字にそろえて比べる。例: 「麻生 太郎」と「麻生太郎」を同じとみなす)
  const norm = (s) => String(s).replace(/[\s　・･·]/g, "").toLowerCase();
  const visible = norm([title, ...paragraphs, ...themes].join("\n"));
  const leaked = keywords.filter((k) => norm(k).length > 0 && visible.includes(norm(k)));
  if (leaked.length > 0) throw new Error(`次のキーワードが、そのまま書かれています: ${leaked.join("、")}。一般的な言葉に置きかえてください`);

  const excluded = (Array.isArray(obj.excluded_keywords) ? obj.excluded_keywords : [])
    .filter((e) => e && typeof e.keyword === "string")
    .map((e) => ({ keyword: e.keyword, reason: String(e.reason || "") }));
  return { title, themes, used_keywords: used, excluded_keywords: excluded, paragraphs };
}

// 新しい KEEP 本だけ残す。削除したファイル名の一覧を返す
function rotate(dir, keep) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => DATE_FILE.test(f)).sort().reverse();
  const removed = files.slice(keep);
  for (const f of removed) fs.unlinkSync(path.join(dir, f));
  return removed;
}

async function generate(date, trends) {
  const messages = [{ role: "user", content: buildPrompt(date, trends) }];
  let lastError = null;
  for (let attempt = 1; attempt <= CONFIG.MAX_ATTEMPTS; attempt++) {
    const text = await callClaude(messages);
    try {
      return parseAndValidate(text, trends);
    } catch (e) {
      lastError = e;
      console.log(`確認に通りませんでした(${attempt}回目): ${e.message}`);
      messages.push({ role: "assistant", content: text });
      messages.push({ role: "user", content: `条件を満たしていません: ${e.message}\n直して、JSONだけをもう一度出力してください。` });
    }
  }
  throw new Error(`${CONFIG.MAX_ATTEMPTS}回試しても条件を満たせませんでした: ${lastError.message}`);
}

async function main() {
  const args = process.argv.slice(2);
  const promptOnly = args.includes("--prompt");
  const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || jstToday();
  const outPath = path.join(CONFIG.OUT_DIR, `${date}.json`);

  if (!promptOnly && fs.existsSync(outPath)) { console.log(`スキップ: ${date} のお話は作成済みです`); return; }
  const trends = loadTrends(date);
  if (trends.length === 0) throw new Error(`${date} のトレンドが0件です`);
  if (promptOnly) { console.log(buildPrompt(date, trends)); return; }

  const story = await generate(date, trends);
  fs.mkdirSync(CONFIG.OUT_DIR, { recursive: true });
  const record = {
    date,
    ...story,
    source_keywords: trends.map((t) => t.keyword), // 元にしたトレンド(記録用。画面には出さない)
    model: CONFIG.MODEL,
    created_at: new Date().toISOString(),
  };
  fs.writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n", "utf8");
  console.log(`書き出し: ${date} 「${story.title}」(${story.paragraphs.join("").length}字)`);
  const removed = rotate(CONFIG.OUT_DIR, CONFIG.KEEP);
  if (removed.length) console.log(`古いお話を削除: ${removed.join(", ")}`);
}

module.exports = { buildPrompt, parseAndValidate, rotate, CONFIG };

if (require.main === module) {
  main().catch((e) => { console.error(`失敗: ${e.message}`); process.exit(1); });
}
