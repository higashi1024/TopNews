// 「今日の話題」用に、各日のテクノロジーTOP3を src/content/topics/<日付>.json に書き出す。
// 既にある解説(背景・読者ができること・確認できなかったこと・用語)は、同じ順位・同じ見出しなら残す。
// 使い方: node scripts/make-topics.js [日付 ...]   (日付を省略すると data/ にある全日付)
const fs = require("fs");
const path = require("path");
const dataDir = path.join(__dirname, "../data");
const outDir = path.join(__dirname, "../src/content/topics");
fs.mkdirSync(outDir, { recursive: true });
const dates = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(dataDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10));
for (const date of dates) {
  const src = JSON.parse(fs.readFileSync(path.join(dataDir, `${date}.json`), "utf8"));
  const outPath = path.join(outDir, `${date}.json`);
  const prev = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : { items: [] };
  const items = (src.categories?.["テクノロジー"] || []).slice(0, 3).map(t => {
    const n = (t.news || [])[0] || {};
    const old = prev.items.find(p => p.rank === t.rank && p.title === t.keyword) || {};
    return {
      rank: t.rank, title: t.keyword, source: n.source || "", url: n.url || "",
      published: n.published || old.published || "",
      background: old.background || [], actions: old.actions || [], unknown: old.unknown || [], terms: old.terms || [],
    };
  });
  fs.writeFileSync(outPath, JSON.stringify({ date, items }, null, 2), "utf8");
  console.log(`書き出し: ${date} (${items.length}件)`);
}
