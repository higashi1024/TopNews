// 今日のお話: src/content/stories/<日付>.json を読み、日付の新しい順に最大 KEEP 本だけ使う。
// (ファイルの削除は scripts/make-story.cjs が行う。ここは、念のための上限)
import fs from "node:fs";
import path from "node:path";

export const KEEP = 10;

export function loadStories() {
  const dir = path.resolve("src/content/stories");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
    .filter((s) => s.date && s.title && Array.isArray(s.paragraphs) && s.paragraphs.length > 0)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, KEEP);
}
