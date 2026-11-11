# Gasho

Mac と Ubuntu Server で動く Claude Code（Remote Control）のセッションと、その作業対象のリポジトリの Git・GitHub の状況を、1つのブラウザ画面で見るためのダッシュボード。

- 仕様の案：[docs/spec.md](docs/spec.md)
- 調査と検証の記録：[docs/research.md](docs/research.md)

## 構成

| ディレクトリ | 中身 |
|---|---|
| `apps/daemon` | gasho-daemon。各マシンで動き、セッションの一覧・会話・hooks のイベントを hub に送る |
| `apps/hub` | gasho-hub。daemon からの情報をまとめて保存し、画面に配信する |
| `apps/web` | gasho-web。画面（Vite・React・Tailwind CSS・easyui.site の部品） |
| `packages/protocol` | 3つで共有する型 |
| `nakamaba/` | Nakamaba で配信している「🙏 Gasho」のサイト（ダッシュボードとは別） |

いまは仕様の「実装の順序」の1番目（セッションの観測と通知）まで動く。

## 動かし方

Node.js 24 以上が要る。hub と daemon は TypeScript をビルドせずにそのまま実行する。

```bash
npm install
npm run web:build
```

### hub（Ubuntu Server）

```bash
export GASHO_TOKEN=<daemon と共有する長いランダムな文字列>
npm run hub    # http://127.0.0.1:7740
```

hub は 127.0.0.1 でだけ待ち受ける。画面にはまだログインの仕組みがないので、外から使うときは Tailscale Serve で tailnet の中にだけ公開する（例：`tailscale serve --bg 7740`）。インターネットには直接公開しない。

### daemon（各マシン）

```bash
export GASHO_TOKEN=<hub と同じ値>
export GASHO_HUB_URL=ws://127.0.0.1:7740/ws/daemon   # Mac からは wss://<hub のホスト名>/ws/daemon
export GASHO_HOOK_SECRET=<長いランダムな文字列>
npm run daemon
```

daemon は `claude agents --json` とトランスクリプト（`~/.claude/projects/`）を読む。hooks を入れなくても、セッションの一覧と会話の表示は使える。

### hooks（通知に使う）

応答の完了・権限の確認待ち・入力待ちを通知するには、Claude Code の hooks を入れる。

```bash
# 追加される内容を確かめる
GASHO_HOOK_SECRET=<daemon と同じ値> node apps/daemon/src/cli.ts hooks print
# ~/.claude/settings.json に追記する（元のファイルはバックアップする）
GASHO_HOOK_SECRET=<daemon と同じ値> node apps/daemon/src/cli.ts hooks install
```

- シークレットは設定ファイルに直接書き込まれる
- 設定は、動いているセッションにも数秒で反映される
- ユーザー設定の hooks は、そのマシンのすべてのセッションにかかる
- daemon が止まっていても、hook の失敗は無視され、Claude Code の動きは変わらない

### 開発

```bash
npm run web:dev    # Vite。/ws と /api は hub（127.0.0.1:7740）に中継する
npm test
npm run typecheck
```

## 環境変数

| 変数 | 使う側 | 既定値 |
|---|---|---|
| `GASHO_TOKEN` | hub・daemon | なし（必須） |
| `GASHO_HUB_HOST` / `GASHO_HUB_PORT` | hub | `127.0.0.1` / `7740` |
| `GASHO_DB` | hub | `~/.local/share/gasho/hub.db` |
| `GASHO_WEB_DIST` | hub | `apps/web/dist` |
| `GASHO_HUB_URL` | daemon | `ws://127.0.0.1:7740/ws/daemon` |
| `GASHO_MACHINE` | daemon | ホスト名 |
| `GASHO_HOOK_PORT` | daemon | `7741` |
| `GASHO_HOOK_SECRET` | daemon・hooks install | なし |
| `GASHO_CLAUDE_DIR` / `GASHO_CLAUDE_BIN` | daemon | `~/.claude` / `claude` |

## nakamaba/

`nakamaba/` は Nakamaba で配信しているサイトで、公開・更新は `nakamaba/` フォルダを指定して行う。

```bash
node <nakamaba スキルのフォルダ>/scripts/nakamaba.mjs publish nakamaba
```
