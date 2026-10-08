// お題の記事: src/content/articles/*.md を読み、日付の新しい順に最大 KEEP 件だけ使う。
// KEEP より古い記事は、ページを作らない(ファイル自体はGitの履歴に残る)。
export const KEEP = 10;

export function loadArticles() {
  const mods = import.meta.glob("../content/articles/*.md", { eager: true });
  return Object.entries(mods)
    .map(([file, m]) => ({
      slug: file.split("/").pop().replace(/\.md$/, ""),
      ...m.frontmatter,
      Content: m.Content,
    }))
    .filter((a) => a.title && a.date)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.slug.localeCompare(a.slug))
    .slice(0, KEEP);
}

// 日付(Date または "2026-10-08" の文字列)を「2026年10月8日(木)」の形にする。判断できなければ元の文字列を返す。
export function formatDate(d) {
  const iso = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return String(d);
  const wd = "日月火水木金土"[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
  return `${m[1]}年${+m[2]}月${+m[3]}日(${wd})`;
}

// 「10月8日(木)」の形(年なし)
export function shortDate(d) {
  const iso = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return String(d);
  const wd = "日月火水木金土"[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
  return `${+m[2]}月${+m[3]}日(${wd})`;
}
