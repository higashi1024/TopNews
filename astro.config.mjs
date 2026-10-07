import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// 公開URL（独自ドメインにしたらここを変更する）
export default defineConfig({
  site: "https://top-news-kappa.vercel.app",
  output: "static",
  redirects: { "/topics": "/" },
  integrations: [
    sitemap({
      // 下書きページ（noindex）はサイトマップに載せない
      filter: (page) => !page.includes("/guide/") && !page.includes("/updates") && !page.includes("/privacy") && !page.includes("/contact") && !page.includes("/about"),
    }),
  ],
});
