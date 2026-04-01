# BTCQ — Bitcoin Address Quantum Risk Checker

**[https://j-sokol.github.io/btcq/](https://j-sokol.github.io/btcq/)**

Check any Bitcoin address for quantum vulnerability: public-key exposure, spend history, and script type — all from your browser, no backend.

Repo: [github.com/j-sokol/btcq](https://github.com/j-sokol/btcq)

## GitHub Pages

This repo includes a GitHub Pages workflow at `.github/workflows/deploy-gh-pages.yml`.

Before going live:

- the default GitHub Pages project URL for this repo will be `https://j-sokol.github.io/btcq/`
- replace that later if you move to a custom domain

Then:

1. Push the repo to GitHub.
2. In GitHub, enable Pages and set the source to `GitHub Actions`.
3. Push to `main` to trigger deployment.

## What it does

- Accepts one Bitcoin address, a batch list, or a specific `txid:vout` output reference
- Calls an Esplora-compatible API directly from the browser
- Supports a user-specified Esplora-compatible endpoint
- Classifies the address into a practical risk tier
- Explains why the tier was assigned

## Data sources

The UI currently supports:

- `https://blockstream.info/api`
- `https://mempool.space/api`

The app does not include a backend. Requests go from the user's browser to the selected API provider.
If you want to use your own infrastructure, point the app at an Esplora-compatible endpoint. Raw Bitcoin Core RPC is not sufficient on its own.

## Run locally

Because this is a static app, use any local static server from the repo root. For example:

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173`.

## Tests

Run the logic tests with:

```bash
npm test
```

The tests cover address-type detection, script-type inference, output-reference classification, tier classification, and end-to-end assessment cases.
There are also utility tests for batch-input parsing and custom endpoint handling.

## Notes

- The assessment is heuristic.
- Some legacy `P2PKH` addresses are explicitly marked exposed when they are historically linked to earlier bare-pubkey outputs whose public keys are already on-chain.
- P2SH is intentionally treated as a manual-review case.
- Taproot is treated separately because the output key is committed on-chain.
- The page links to the March 31, 2026 Google Quantum AI research note referenced in the product framing.
- The app is client-side only, but the selected public API provider still sees the address request.
