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

いま動くのは、セッションの観測と通知、LAN での待ち受け、端末の登録、Gasho から起動したセッションへの入力まで。

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

### Gasho からセッションを起動して、入力する

ホームの「新しいセッション」で working server とフォルダーを選ぶと、そのマシンで `claude --remote-control <名前>` が起動する。このセッションには、セッション画面の入力欄から指示を送れる。公式アプリ（スマホ・Desktop）からも、同じセッションを操作できる。

画面に出すのは、こうして Gasho が起動したセッションだけ。端末や `claude rc` で起動したセッションは、一覧にも通知にも出さない。

- working server に zellij が要る（0.45 で確かめた）。セッションは、専用の zellij セッション（`gasho-<名前>-xxxx`）の中で動くので、SSH から `zellij attach <その名前>` で直接見ることもできる
- フォルダーの一覧に出るのは、Claude Code がすでに信頼しているフォルダー。ほかのフォルダーは、端末で一度 `claude` を起動して信頼してから使う
- 作業中は、送信ボタンが停止ボタンに変わる。押すと Esc を送って作業を止める
- 送った時点で作業中になっていた指示（公式アプリからの発言と重なったときなど）は daemon が預かり、作業が終わってから順に送る
- 応答が始まる前に止めると、Claude Code は止めた指示を端末の入力欄に戻す。daemon は、次の指示を貼り付ける前に入力欄を空にする
- Claude の返答は Markdown として表示する。HTML は表示せず、画像は読み込まずにリンクとして出す
- 入力欄で、モデル（既定・Opus 5.5 など、Claude Code の選択画面と同じ名前）、Effort（Low〜Max）、Ultracode を選んで送ると、送る前にそのセッションだけ切り替える。全体の既定は変えない。会話の途中でモデルを変えると、次の返答では履歴を新しいモデルで読み直すので、時間とトークンが多くかかる
- モデルの名前は、daemon が Claude Code の `/model` の選択画面から読んで覚える。覚えていないか24時間たったときは、待機中のいちばん新しい Gasho のセッションで選択画面を開いて閉じるので、その会話に `/model` の記録が残る
- 入力欄に `/model` や `/effort high` のように書いて送ることはできない。これらは、すべての新しいセッションの既定も変えてしまうため。`/effort ultracode on` と `off` は送れる
- Effort と Ultracode の切り替えには、その working server の gasho-daemon が 0.6.0 以上である必要がある。0.5 の gasho-daemon ではモデルの切り替えと添付だけ、それより前のものでは文字の入力だけになり、扱えない操作は出ない
- クリップのボタン、ドラッグ、貼り付けでファイルを添付できる（1回に5個、合わせて10MB まで）。ファイルは working server の `~/.local/share/gasho/attachments/` に保存され、Claude が読む。セッションが終わると消える
- `/exit` を送るか公式アプリで終了すると、daemon が zellij のセッションも閉じる
- `claude rc` が起動したセッションには、外から入力する公式の手段がないので、Gasho からは入力できない。入力欄の下の「公式アプリで開く」から操作する

起動したセッションの記録は `~/.config/gasho/managed.json` に残り、daemon を起動し直しても引き継ぐ。

### セッション画面とブランチグラフ

- セッション画面のヘッダーは、右上のボタンで隠せる（スマホでは画面上部のバーの右端）。隠すと、セッション名と状態だけの1行になる。PC では、隠したかどうかをブラウザごとに覚える。スマホでは、セッション画面を開くたびに隠した状態から始まる
- 会話の中のツールの呼び出し（コマンドの実行など）は、その結果と一緒に1つの折りたたみにまとめて出す
- ヘッダーのブランチ名を押すと、ブランチグラフを開く。PC ではセッションの右にパネルとして並べ、スマホでは画面全体に出す。セッションのリポジトリのブランチと、全ブランチの新しいほうから300件のコミットを、枝分かれとマージの線で表示する
- ブランチ名と最終更新のあいだの「Issues」「Pull requests」を押すと、リポジトリの開いている Issue と Pull request の一覧を、同じようにパネルで開く。一覧の項目を押すと、GitHub へは移らずに、本文とコメント（Pull request ではレビュー、チェック、変更したファイルも）を Gasho の中で読める。GitHub のページは、パネルの「GitHub」から開く。working server の GitHub CLI（gh）で読むので、working server で `gh auth login` を済ませておく。gh のログインを使うので、Gasho は GitHub のトークンを扱わない。その working server の gasho-daemon が 0.7.0 以上のときだけ出る。項目を Gasho の中で読むには 0.8.0 以上が要る（それより前のものでは、項目を押すと GitHub で開く）
- ブランチの一覧には、ローカルのブランチ（push していないコミットの数など）と、リモートにだけあるブランチ（雲のアイコン）を並べる。見出しを押すと、一覧を折りたためる
- コミットの件名は省略せずに出す。長い件名は、その行を横にスクロールして読む（スクロールバーは出さない）
- ブランチ名の右のアイコンは、GitHub のそのブランチのページを開く
- 作業フォルダーがリポジトリでなく、その中に複数のリポジトリがあるとき（2階層下まで探す）は、ヘッダーに「複数のリポジトリ…」と「ブランチ…」を出す。「複数のリポジトリ…」を押すと、GitHub で開くリポジトリを選べる。「ブランチ…」を押すとブランチグラフを開き、タブでリポジトリを切り替えられる

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

## フォント

画面のフォントは [Gen Interface JP](https://gen.typesetting.jp/)（Inter と Noto Sans JP を組み合わせた書体）で、npm の `gen-interface-jp` を使い、Gasho サーバーから配信する。外部の CDN には取りに行かない。使う太さは Regular・Medium・SemiBold の3つで、どれも文字の範囲ごとに分かれたファイルなので、ブラウザは表示する文字を含むファイルだけを読み込む。ライセンスは SIL Open Font License 1.1 で、全文を `apps/web/public/licenses/gen-interface-jp-OFL.txt` に置き、画面と一緒に `/licenses/gen-interface-jp-OFL.txt` で配信している。

## 注意

LAN の中では通信が暗号化されない。端末のトークンも平文で流れるので、家の LAN を信用できる前提で使う。外から使うときや、LAN を信用できないときは、Tailscale を導入する。

## nakamaba/

`nakamaba/` は Nakamaba で配信しているサイトで、公開・更新は `nakamaba/` フォルダを指定して行う。

```bash
node <nakamaba スキルのフォルダ>/scripts/nakamaba.mjs publish nakamaba
```
