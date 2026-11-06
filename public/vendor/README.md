# Vendored libraries

Copied here so the site runs as plain static files (GitHub Pages, Cloudflare
Pages) with no build step.

| Directory | Package | Version | License |
| --- | --- | --- | --- |
| `three/` | [three](https://github.com/mrdoob/three.js) (`build/three.module.min.js` plus the OrbitControls and fat-line addons) | 0.170.0 | MIT (`three/LICENSE`) |
| `openmeteo/` | [@openmeteo/file-reader](https://github.com/open-meteo/typescript-omfiles) (`dist/esm/index.browser.js`) and @openmeteo/file-format-wasm (`dist/om_file_format.web.*`) | 0.0.21 | GPL-2.0-only (both packages; the WASM includes TurboPFor) |

`openmeteo/file-reader.js` has one change from upstream: the dynamic import of
`@openmeteo/file-format-wasm` points at `./om_file_format.web.js`, because import
maps don't apply inside Web Workers. It's only loaded when an ICON field is
requested. The decode worker reads ICON files through it with its own backend
(small reads through cached 64 KB blocks, a variable's data in one or two big
range requests); see `js/decode/worker.js`.
