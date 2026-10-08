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
