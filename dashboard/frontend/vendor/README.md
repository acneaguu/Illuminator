# Vendored third-party assets

Committed so the dashboard works completely offline (no CDN, no build step) —
a requirement for running it on a kiosk or a Raspberry Pi with no network.

## uPlot 1.6.32

* Source: `https://registry.npmjs.org/uplot/-/uplot-1.6.32.tgz`
* Integrity: `sha512-KIMVnG68zvu5XXUbC4LQEPnhwOxBuLyW1AHtpm6IKTXImkbLgkMy+jabjLgSLMasNuGGzQm/ep3tOkyTxpiQIw==`
  (verified on download; shasum `c800a63b432bad692d6d746f44f0882aa73a49ae`)
* Licence: MIT — see `uplot.LICENSE`
* Files taken verbatim from the package: `dist/uPlot.iife.min.js`, `dist/uPlot.min.css`

To upgrade, download the new tarball, verify its integrity against the registry
metadata, and replace all three files together.
