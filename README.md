# Gasho

Mac と Ubuntu Server で動く Claude Code（Remote Control）のセッションと、その作業対象のリポジトリの Git・GitHub の状況を、1つのブラウザ画面で見るためのダッシュボード。

- 仕様の案：[docs/spec.md](docs/spec.md)
- 調査と検証の記録：[docs/research.md](docs/research.md)

Claude Code が動くマシンを **working server**、ダッシュボードのサーバーを **Gasho サーバー** と呼ぶ。

## 構成

| ディレクトリ | 中身 |
|---|---|
| `apps/hub` | gasho-hub（Gasho サーバー）。各 working server からの情報をまとめて保存し、画面に配信する。端末の登録も管理する |
| `apps/daemon` | gasho-daemon。各 working server で動き、セッションの一覧・会話・hooks のイベントを Gasho サーバーに送る |
| `apps/web` | gasho-web。画面（Vite・React・Tailwind CSS・easyui.site の部品） |
| `packages/protocol` | 3つで共有する型 |
| `nakamaba/` | Nakamaba で配信している「🙏 Gasho」のサイト（ダッシュボードとは別） |

いま動くのは、セッションの観測と通知、LAN での待ち受け、端末の登録まで。

## 動かし方

Node.js 24 以上が要る。TypeScript はビルドせずにそのまま実行する。

### Gasho サーバー（Ubuntu Server）

```bash
npm install
npm run web:build
npm run hub        # LAN 側の 0.0.0.0:7740 で待ち受ける
```

起動すると、LAN から開くときの URL がログに出る。受け付ける接続元は、既定ではこのマシンと LAN のプライベートアドレスだけで、それ以外からのリクエストは断る。

### ブラウザを登録する

Gasho は、登録した端末からしか使えない。

```bash
npm run hub:pair   # 登録コード（10分間有効、1回だけ使える）を出す
```

ブラウザで `http://<Gasho サーバーの IP アドレス>:7740` を開き、登録の画面にコードを入れる。2台目からは、登録済みの端末の「端末」画面でもコードを出せる。

### working server を登録する

working server になるマシンには、Node.js 24 以上とこのリポジトリがあればよい（`npm install` は要らない）。登録コードを出して、そのマシンで次を実行する。

```bash
node apps/daemon/src/cli.ts register --server http://<Gasho サーバーの IP アドレス>:7740 --code <コード>
npm run daemon     # または node apps/daemon/src/cli.ts run
```

登録は `~/.config/gasho/daemon.json` に保存される（本人だけが読める権限）。working server は、登録したときの名前で画面に出る。名前は「端末」画面で変えられる。

### hooks（通知に使う）

応答の完了・権限の確認待ち・入力待ちを通知するには、各 working server の Claude Code に hooks を入れる。

```bash
# 追加される内容を確かめる
GASHO_HOOK_SECRET=<長いランダムな文字列> node apps/daemon/src/cli.ts hooks print
# ~/.claude/settings.json に追記する（元のファイルはバックアップする）
GASHO_HOOK_SECRET=<同じ値> node apps/daemon/src/cli.ts hooks install
# daemon にも同じ値を渡して起動する
GASHO_HOOK_SECRET=<同じ値> npm run daemon
```

- シークレットは設定ファイルに直接書き込まれる
- 設定は、動いているセッションにも数秒で反映される
- ユーザー設定の hooks は、そのマシンのすべてのセッションにかかる
- daemon が止まっていても、hook の失敗は無視され、Claude Code の動きは変わらない

hooks を入れなくても、セッションの一覧と会話の表示は使える。

### 端末を管理する

画面の「端末」で、登録した端末の一覧、名前の変更、登録の取り消し、登録コードの発行ができる。取り消した端末の接続はすぐに切れる。コマンドでも操作できる。

```bash
npm run hub:devices                              # 一覧
node apps/hub/src/cli.ts revoke <端末の ID>      # 取り消し（30秒以内に接続が切れる）
```

### 外から使う（必要なとき）

Gasho サーバーは LAN の中だけで使う前提にしている。外から使うときは Tailscale を導入する。

1. Gasho サーバー・Mac・スマホに Tailscale を入れる
2. Gasho サーバーを `GASHO_ALLOW_NETS=lan,tailscale npm run hub` で起動する
3. HTTPS が要るときは、Tailscale Serve で公開する（スマホへのプッシュ通知には HTTPS が要る）

### 開発

```bash
npm run web:dev    # Vite。/ws と /api は Gasho サーバー（127.0.0.1:7740）に中継する
npm test
npm run typecheck
```

## 環境変数

| 変数 | 使う側 | 既定値 |
|---|---|---|
| `GASHO_HUB_HOST` / `GASHO_HUB_PORT` | hub | `0.0.0.0` / `7740` |
| `GASHO_ALLOW_NETS` | hub | `lan`（このマシンと LAN のプライベートアドレス）。CIDR と `lan`・`tailscale` をカンマで並べる |
| `GASHO_DB` | hub | `~/.local/share/gasho/hub.db` |
| `GASHO_WEB_DIST` | hub | `apps/web/dist` |
| `GASHO_DAEMON_CONFIG` | daemon | `~/.config/gasho/daemon.json` |
| `GASHO_HUB_URL` | daemon | 登録した Gasho サーバーから決める |
| `GASHO_HOOK_PORT` | daemon | `7741` |
| `GASHO_HOOK_SECRET` | daemon・hooks install | なし |
| `GASHO_CLAUDE_DIR` / `GASHO_CLAUDE_BIN` | daemon | `~/.claude` / `claude` |

## 注意

LAN の中では通信が暗号化されない。端末のトークンも平文で流れるので、家の LAN を信用できる前提で使う。外から使うときや、LAN を信用できないときは、Tailscale を導入する。

## nakamaba/

`nakamaba/` は Nakamaba で配信しているサイトで、公開・更新は `nakamaba/` フォルダを指定して行う。

```bash
node <nakamaba スキルのフォルダ>/scripts/nakamaba.mjs publish nakamaba
```
