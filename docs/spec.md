# Gasho 仕様（案）

Gasho は、Mac と Ubuntu Server で動く Claude Code のセッションと、その作業対象のリポジトリの Git・GitHub の状況を、1つのブラウザ画面で見て、必要な操作をするためのダッシュボードである。この文書は、[調査と検証の記録](research.md) をもとにした仕様の案である。

## 用語

| 用語 | 指すもの |
|---|---|
| working server | `claude rc` などで Claude Code が動き、gasho-daemon を動かすマシン（Ubuntu Server、MacBook など） |
| Gasho サーバー | ダッシュボードのサーバー（gasho-hub）。画面を配信し、各 working server からの情報をまとめる |
| 端末 | Gasho サーバーに登録したもの。ブラウザと working server の2種類がある |

## 前提

- 利用者は自分1人で、自分のマシンだけを対象にする
- 各 working server では `claude rc` を使い、Claude Desktop とスマホのアプリからセッションを操作している。Gasho は公式アプリを置き換えず、並べて使う
- Anthropic の非公開 API と認証情報には触れない。Claude Code は、CLI、hooks、トランスクリプトといった公式の手段だけで扱う
- GitHub の情報は見るだけにする。GitHub での操作は rc 上の Agent が行い、Gasho は GitHub のページへのリンクを出す
- Gasho サーバーは、同じマシンと同じ LAN の中からだけ使う。外から使う必要が出たときは、Tailscale などを導入する。Cloudflare Tunnel と Cloudflare Access も検討したが、LAN を基本にする方針にしたので採らなかった

## 機能

### セッション

| 番号 | 機能 | 対象 | 取得・操作の方法 |
|---|---|---|---|
| S1 | 全 working server のセッションの一覧と状態（busy・waiting・idle、待っているもの、題名、リポジトリ、ブランチ） | すべて | `claude agents --json`、トランスクリプト |
| S2 | 会話の履歴（ツールの呼び出しと割り込みを含む） | すべて | トランスクリプト |
| S3 | 通知（ツールの実行、応答の完了、権限の確認待ち、入力待ち） | すべて | hooks |
| S4 | 権限の確認への許可と拒否 | すべて | PermissionRequest hook |
| S5 | 公式アプリでセッションを開くリンク | すべて | `bridgeSessionId` |
| S6 | 新しいセッションの起動 | Gasho が起動するもの | zellij |
| S7 | 発言の送信 | Gasho が起動するもの | zellij（貼り付けと Enter） |
| S8 | 割り込み | Gasho が起動するもの | zellij（Esc） |
| S9 | 端末画面の表示 | Gasho が起動するもの | zellij（画面の取得） |

「すべて」は、`claude rc` が起動したセッションと Gasho が起動したセッションの両方を指す。`claude rc` が起動したセッションへの発言の送信と割り込みには公式の手段がないので、これまでどおり公式アプリで行う。

サーバーモードのセッションでは入力待ちの Notification が届かないので、S3 の入力待ちは Stop と `claude agents --json` の状態から判断する。

### 端末の登録

| 番号 | 機能 |
|---|---|
| D1 | ブラウザを登録コードで登録する |
| D2 | working server を登録コードで登録する |
| D3 | 登録した端末の一覧、名前の変更、登録の取り消し |
| D4 | 登録コードの発行。Gasho サーバーのコマンドか、登録済みの端末の「端末」画面から出す |

### Git

| 番号 | 機能 | 取得の方法 |
|---|---|---|
| G1 | ブランチの一覧（ローカルとリモート、push していないコミットの数、作業中の変更の有無） | `git for-each-ref`、`git status` |
| G2 | worktree の一覧 | `git worktree list` |
| G3 | ブランチツリー（コミットのグラフ） | `git log` の親コミットの情報 |
| G4 | セッションとブランチ・PR の対応 | トランスクリプトの `gitBranch` と `pr-link` |

git のリポジトリでないフォルダー（例：hardcore2）では、Git と GitHub の表示を出さない。

### GitHub（見るだけ）

| 番号 | 機能 |
|---|---|
| H1 | Issues の一覧 |
| H2 | PRs の一覧（下書きかどうか、レビューの状態、CI の結果、関係するセッション） |
| H3 | Actions の実行の一覧（ワークフロー、ブランチ、結果、所要時間） |

どの項目からも、GitHub の該当ページへリンクで移動できるようにする。GitHub の情報は60秒ごとに取得し、間隔は設定で変えられるようにする。Webhook による即時の反映は、今回は扱わない。

## 構成

```
ブラウザ・スマホ ──(同じ LAN、HTTP)──▶ Gasho サーバー（gasho-hub、Ubuntu Server）──▶ GitHub の API
                                           ▲ WebSocket（gasho-daemon から接続）
                       ┌───────────────────┴────────────────────┐
         gasho-daemon（working server：Ubuntu）     gasho-daemon（working server：Mac。同じ LAN にいるあいだ）
           ├ Claude Code（hooks、トランスクリプト、claude agents）
           ├ git
           └ zellij
```

| 構成要素 | 置き場所 | 役割 |
|---|---|---|
| gasho-hub（Gasho サーバー） | Ubuntu Server | 各 working server からの情報をまとめて保存し、画面に送る。端末の登録を管理する。GitHub の情報を取得する。画面のファイルを配信する |
| gasho-daemon | 各 working server | Claude Code・git・zellij の情報を集めて Gasho サーバーに送り、Gasho サーバーからの操作を実行する |
| gasho-web（画面） | Gasho サーバーから配信 | ブラウザとスマホで使う画面 |

技術は次のとおり。

- 言語：TypeScript。hub・daemon・画面で、通信の型を共有する
- gasho-hub と gasho-daemon：Node.js（24 以上）。TypeScript をビルドせずに実行する。hub のデータは SQLite（node:sqlite）に保存する
- gasho-web：Vite、React、Tailwind CSS v4、shadcn/ui に、easyui.site の部品を加える

リポジトリは、次の構成にする。

```
apps/web/          gasho-web
apps/hub/          gasho-hub
apps/daemon/       gasho-daemon
packages/protocol/ hub・daemon・web で共有する型
docs/
nakamaba/          Nakamaba で配信している 🙏 のサイト（ダッシュボードとは別）
```

## ネットワークと端末の登録

### 待ち受けと接続元の制限

Gasho サーバーは、LAN 側（既定は 0.0.0.0:7740）で待ち受ける。受け付ける接続元は `GASHO_ALLOW_NETS` で決め、既定ではこのマシン自身と LAN のプライベートアドレスだけにする。具体的には、127.0.0.0/8、::1、10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、169.254.0.0/16、fc00::/7、fe80::/10 である。これ以外からのリクエストは、画面のファイルも含めてすべて 403 で断る。

Tailscale で外から使うときは、`GASHO_ALLOW_NETS=lan,tailscale` として Tailscale のアドレスの範囲を加える。HTTPS は Tailscale Serve で用意する。

### 登録の流れ

LAN の中にも自分以外の機器はある。そのため、接続元の制限に加えて、登録した端末しか Gasho を使えないようにする。

1. 登録コードを発行する。最初の1台は Gasho サーバーで `npm run hub:pair` を実行して出す。2台目からは、登録済みの端末の「端末」画面からも出せる
2. 登録コードは8文字（例：`ABCD-2345`）で、10分間有効、1回だけ使える。読み間違えやすい文字（I・L・O・0・1）は使わない
3. ブラウザでは、Gasho を開くと登録の画面が出るので、コードと端末の名前を入れる
4. working server では、`node apps/daemon/src/cli.ts register --server <Gasho サーバーの URL> --code <コード>` を実行する
5. Gasho サーバーは端末の ID とトークンを発行する。保存するのはトークンのハッシュだけにする
6. ブラウザはトークンを Cookie（HttpOnly、SameSite=Strict）に、working server は `~/.config/gasho/daemon.json`（本人だけが読める権限）に保存する

working server は、ホスト名ではなく登録時に発行した ID で区別する。名前は表示用で、あとから変えられる。

登録を取り消すと、その端末の接続はすぐに切れ、次からの接続も拒否される。コマンド（`node apps/hub/src/cli.ts revoke <id>`）で取り消した場合は、30秒以内に切れる。登録コードを間違えた入力が10分間に10回続いた接続元は、しばらく受け付けない。

### LAN だけで使うときの制約

- HTTPS がないので、スマホへのプッシュ通知（Web Push）と、PWA としてホーム画面に追加することはできない。通知は、画面を開いているあいだだけになる
- 通信は暗号化されない。端末のトークンも LAN の中を平文で流れるので、家の LAN を信用できる前提で使う
- Mac の gasho-daemon がつながるのは、Mac が同じ LAN にいるあいだだけになる。家の外にいるあいだは、Mac のセッションは画面に出ない

どれも、Tailscale を導入すれば解消する。

## gasho-daemon

### 役割

1. `claude agents --json` を数秒ごとに取得し、セッションの増減と状態の変化を Gasho サーバーに送る
2. トランスクリプトに追記された分を読み、Gasho サーバーに送る
3. hooks を HTTP で受け、イベントを Gasho サーバーに送る
4. 権限の確認（PermissionRequest）への応答を保留し、確認の内容を Gasho サーバーに送る。画面で許可か拒否が決まったら、それを応答として返す
5. Gasho が起動するセッションを zellij で起動し、発言の送信、割り込み、画面の取得を行う
6. `claude rc` のプロセスを監視する。通信断で終了したときは画面で知らせ、`claude remote-control --continue` で起動し直せるようにする
7. セッションの作業ディレクトリから git のリポジトリを見つけ、ブランチ・worktree・コミットのグラフを Gasho サーバーに送る。`.git` の中の参照を監視し、変化をすぐに送る

常駐のさせ方（systemd のユーザーサービス、launchd、zellij）は、まだ決めていない。

### hooks の設定

`~/.claude/settings.json` に、HTTP 型の hook として次のイベントを登録する。

- SessionEnd、UserPromptSubmit
- PreToolUse、PostToolUse、PostToolUseFailure
- PermissionRequest、Notification、Stop、StopFailure

ドキュメントでは SessionStart は HTTP 型に対応していないとされているので、セッションの開始は `claude agents --json` で見つける。

送り先は、gasho-daemon が 127.0.0.1 で待ち受けるポートにする。ヘッダーには共有シークレットを入れ、その値は hooks の設定に直接書く。環境変数から差し込む方式（`allowedEnvVars`）は、Claude Code 本体の環境変数しか読まないので、動いている `claude rc` を起動し直すまで効かない。そのため採らない。ユーザー設定の hooks は、Mac の Claude Desktop で動かすセッションも含め、そのマシンのすべてのセッションにかかる。

hook の `onFailure` は既定のままにする。こうすると、gasho-daemon が止まっていても hook の失敗は判断なしとして扱われ、公式アプリの動きは変わらない。

### 操作の規則

検証で分かったことから、次の規則を守る。

- 発言を送るのは、状態が idle のときだけにする。権限の確認が開いているときに Enter を送ると、確認への許可として扱われる。busy のあいだはいつ確認が開くか分からないので、gasho-daemon で発言を待たせる
- 応答が始まる前に割り込むと、送った発言が入力欄に戻る。次の発言を送る前に入力欄を空にする（方法は未確認）
- 割り込まれたときは Stop が届かない。トランスクリプトの `[Request interrupted by user]` か、状態の変化から判断する
- 画面の承認待ちの表示は gasho-daemon が消す。公式アプリで答えられても hook は打ち切られないので、PostToolUse や状態の変化を見て消す。PermissionRequest には `tool_use_id` がないので、直前の PreToolUse とは、セッション・ツール名・入力の内容で対応づける
- zellij を操作するときは、`--session` と `--pane-id` を必ず指定する
- 新しいフォルダーでは、最初に信頼の確認が端末に出る。端末画面の表示（S9）から答えられるようにする

## gasho-hub（Gasho サーバー）

- 各 working server からの情報を、登録した ID ごとにまとめて SQLite に保存する
- 画面とは WebSocket でつなぎ、変化をすぐに送る。30秒ごとに ping を送り、応答のない接続を切る
- GitHub の情報を取得する。トークンは、対象のリポジトリだけに絞った fine-grained personal access token を読み取り専用で作り、Gasho サーバーだけに置く。CI の結果の取得に要る権限は、実装のときに確かめる
- 通知を Web Push でスマホに送るのは、Tailscale などで HTTPS を用意してからにする。iPhone では、ホーム画面に追加した PWA でだけ受け取れる。公式アプリの通知と重なるので、通知の種類ごとに切り替えられるようにする

## 画面

| 画面 | 内容 | 主な部品 |
|---|---|---|
| ホーム | working server とセッションの一覧、承認待ち、通知 | Data Table、Badge、Notification Stack |
| セッション | 会話の履歴、許可と拒否、発言の入力、端末画面 | Chat、AI Response、AI Agent Activity、Prompt Input、xterm.js |
| リポジトリ | ブランチツリー、worktree、Issues、PRs、Actions | Animated Tabs、Data Table、自作の SVG |
| 端末 | 登録した端末の一覧、登録コードの発行 | Data Table、Badge |
| 登録 | 登録していないブラウザに出す、登録コードの入力 | 自作 |
| 全体の枠 | ナビゲーション、検索 | Sidebar、Sheet、Command Menu |

easyui.site にない部品は、次のもので補う。

- 端末画面の表示：xterm.js
- 長い会話やログの仮想スクロール：TanStack Virtual
- 画面の分割：shadcn/ui の Resizable
- PWA：vite-plugin-pwa
- ブランチツリー：SVG で自作する

easyui.site の部品はアニメーションが多いので、会話の逐次表示のように更新が多い場所では、アニメーションの少ない部品を使う。

## セキュリティ

Gasho からは手元のマシンでコマンドを実行させられるので、次のように守る。

- Gasho サーバーは、許可したネットワーク（既定はこのマシンと LAN）からの接続だけを受け付ける
- 画面と API は、登録したブラウザしか使えない。working server も、登録したものしか接続できない
- 状態を変える API は、JSON で、同じオリジンから送られたものだけを受け付ける。別のサイトからの操作を防ぐためである
- hooks を受けるポートは 127.0.0.1 に限り、共有シークレットを確かめる
- 発言の送信と承認は、すべて操作のログに残す
- Anthropic の認証情報は読まない。GitHub のトークンは Gasho サーバーだけに置く

## 実装の順序

1. セッションの観測と通知（S1〜S3、S5）：済み
2. LAN での待ち受けと端末の登録（D1〜D4）：済み
3. 権限の確認への許可と拒否（S4）
4. Git と GitHub の表示（G1〜G4、H1〜H3）
5. Gasho が起動するセッション（S6〜S9）

3は、`claude rc` の運用を変えずに使え、検証も済んでいる。4は、Claude Code の内部の形式に頼る部分が少ない。5は検証で動くことを確かめたが、守るべき操作の規則が多いので最後にする。

## 未確認の事項

- hook から拒否を返したときの動き
- 割り込みで入力欄に戻った発言を消す方法
- Mac（launchd、zellij）での動き
- AskUserQuestion に hook で答える方法
- トランスクリプトなどの内部の形式が、Claude Code の更新で変わったときの影響
- easyui.site の部品の、スマホでの重さ
- Gasho サーバーを名前（`rg.local`）で開く方法。avahi-daemon を有効にするか、ルーターで IP アドレスを固定する必要がある
