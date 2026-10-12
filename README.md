# 応力彫刻 STRESS CARVE

荷重のかかった3Dブロックを削り、壊れないギリギリの最軽量構造を彫り出すブラウザ用パズル。
削るたびに本物の有限要素解析（3D線形弾性、Rust → WASM）が走り、応力の流れが色で見えます。

- 企画・技術設計書: [docs/削り出しパズル 企画・技術設計書.md](docs/削り出しパズル%20企画・技術設計書.md)
- 開発ループ（並行・自動開発の仕組み）: [docs/loop/README.md](docs/loop/README.md)
- タスクボード: `node scripts/tasks.mjs`
- エージェント向けガイド: [CLAUDE.md](CLAUDE.md)

## Quick start

```bash
pnpm install
pnpm build:wasm          # requires wasm-pack
pnpm dev
```

Quality gate: `bash scripts/verify.sh fast` (or `full`).
