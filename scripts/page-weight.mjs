import { gzipSync } from "node:zlib";

/**
 * How much a page costs to load: the HTML, plus every script and stylesheet it
 * references, measured after gzip (which is roughly what goes over the wire).
 *
 *   node scripts/page-weight.mjs http://localhost:3000 / /signin /demo/app
 *
 * It reads the server-rendered HTML, so it counts what is needed for first
 * load. Chunks loaded later by client-side navigation are not included.
 */

const [base = "http://localhost:3000", ...paths] = process.argv.slice(2);
const pages = paths.length > 0 ? paths : ["/"];

const kb = (bytes) => `${(bytes / 1024).toFixed(1).padStart(7)} KB`;

async function gzipped(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  return { raw: body.length, gzip: gzipSync(body).length, text: body.toString("utf8") };
}

for (const path of pages) {
  const html = await gzipped(new URL(path, base).href);

  const scripts = new Set();
  const styles = new Set();
  for (const match of html.text.matchAll(/<script[^>]+src="([^"]+)"/g)) scripts.add(match[1]);
  for (const match of html.text.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)) styles.add(match[1]);
  for (const match of html.text.matchAll(/<link[^>]+href="([^"]+\.css[^"]*)"[^>]+rel="stylesheet"/g)) styles.add(match[1]);

  let js = 0;
  let css = 0;
  for (const src of scripts) js += (await gzipped(new URL(src, base).href)).gzip;
  for (const href of styles) css += (await gzipped(new URL(href, base).href)).gzip;

  console.log(path);
  console.log(`  html   ${kb(html.gzip)}`);
  console.log(`  css    ${kb(css)}  (${styles.size} file${styles.size === 1 ? "" : "s"})`);
  console.log(`  js     ${kb(js)}  (${scripts.size} file${scripts.size === 1 ? "" : "s"})`);
  console.log(`  total  ${kb(html.gzip + css + js)}`);
}
