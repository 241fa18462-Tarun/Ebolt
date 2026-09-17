import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Netlify is configured to publish `dist/client`. Nitro's Vercel preset
 * emits static files to `.vercel/output/static` instead. Copy them over
 * after `vite build` so either host can serve the app.
 */
const src = ".vercel/output/static";
const dest = "dist/client";

if (!existsSync(src)) {
  console.warn("[sync-netlify-dist] no", src, "— skipping");
  process.exit(0);
}

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });

if (!existsSync(join(dest, "index.html"))) {
  const assetsDir = join(dest, "assets");
  const assets = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
  const css = assets.find((f) => f.endsWith(".css"));
  const js = assets.find((f) => f.startsWith("index-") && f.endsWith(".js"));
  if (!js) {
    console.error("[sync-netlify-dist] no client bundle in", assetsDir);
    process.exit(1);
  }
  writeFileSync(
    join(dest, "index.html"),
    `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Ebolt</title>
    <meta name="theme-color" content="#071923" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    ${css ? `<link rel="stylesheet" href="/assets/${css}" />` : ""}
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&family=Playfair+Display:wght@500;600;700&display=swap" />
  </head>
  <body>
    <script type="module" src="/assets/${js}"></script>
  </body>
</html>
`,
  );
  console.log("[sync-netlify-dist] wrote fallback index.html");
}

writeFileSync(
  join(dest, "_redirects"),
  "/*    /index.html   200\n",
);

console.log("[sync-netlify-dist] published", dest);
