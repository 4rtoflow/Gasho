# Gasho 仕様（案）

Gasho は、Mac と Ubuntu Server で動く Claude Code のセッションと、その作業対象のリポジトリの Git・GitHub の状況を、1つのブラウザ画面で見て、必要な操作をするためのダッシュボードである。この文書は、[調査と検証の記録](research.md) をもとにした仕様の案である。

## 前提

- 利用者は自分1人で、自分のマシンだけを対象にする
- 各マシンでは `claude rc` を使い、Claude Desktop とスマホのアプリからセッションを操作している。Gasho は公式アプリを置き換えず、並べて使う
- Anthropic の非公開 API と認証情報には触れない。Claude Code は、CLI、hooks、トランスクリプトといった公式の手段だけで扱う
- GitHub の情報は見るだけにする。GitHub での操作は rc 上の Agent が行い、Gasho は GitHub のページへのリンクを出す

## 機能

### セッション

| 番号 | 機能 | 対象 | 取得・操作の方法 |
|---|---|---|---|
| S1 | 全マシンのセッションの一覧と状態（busy・waiting・idle、待っているもの、題名、リポジトリ、ブランチ） | すべて | `claude agents --json`、トランスクリプト |
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
ブラウザ / スマホ ──(Tailscale, HTTPS)──▶ gasho-hub（Ubuntu Server）──▶ GitHub の API
                                              ▲ WebSocket（daemon から接続）
                          ┌───────────────────┴───────────────────┐
                 gasho-daemon（Ubuntu）                   gasho-daemon（Mac）
                  ├ Claude Code（hooks、トランスクリプト、claude agents）
                  ├ git
                  └ zellij
```

| 構成要素 | 置き場所 | 役割 |
|---|---|---|
| gasho-hub（ダッシュボードのサーバー） | Ubuntu Server | daemon からの情報をまとめて保存し、画面に送る。GitHub の情報を取得する。画面のファイルを配信する |
| gasho-daemon（常駐サーバー） | 各マシン | Claude Code・git・zellij の情報を集めて hub に送り、hub からの操作を実行する |
| gasho-web（画面） | hub から配信 | ブラウザとスマホで使う画面 |

技術は次を提案する。

- 言語：TypeScript。hub・daemon・画面で、通信の型を共有する
- gasho-hub と gasho-daemon：Node.js。hub のデータは SQLite に保存する
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

## gasho-daemon

Ubuntu では systemd のユーザーサービスとして、Mac では launchd で常駐させる。

### 役割

1. `claude agents --json` を数秒ごとに取得し、セッションの増減と状態の変化を hub に送る
2. トランスクリプトに追記された分を読み、hub に送る
3. hooks を HTTP で受け、イベントを hub に送る
4. 権限の確認（PermissionRequest）への応答を保留し、確認の内容を hub に送る。画面で許可か拒否が決まったら、それを応答として返す
5. Gasho が起動するセッションを zellij で起動し、発言の送信、割り込み、画面の取得を行う
6. `claude rc` のプロセスを監視する。通信断で終了したときは画面で知らせ、`claude remote-control --continue` で起動し直せるようにする
7. セッションの作業ディレクトリから git のリポジトリを見つけ、ブランチ・worktree・コミットのグラフを hub に送る。`.git` の中の参照を監視し、変化をすぐに送る

### hooks の設定

`~/.claude/settings.json` に、HTTP 型の hook として次のイベントを登録する。

- SessionEnd、UserPromptSubmit
- PreToolUse、PostToolUse、PostToolUseFailure
- PermissionRequest、Notification、Stop、StopFailure

ドキュメントでは SessionStart は HTTP 型に対応していないとされているので、セッションの開始は `claude agents --json` で見つける。

送り先は、daemon が 127.0.0.1 で待ち受けるポートにする。ヘッダーには共有シークレットを入れる。シークレットは Claude Code を起動する環境（systemd や launchd の設定）に環境変数として置き、hook の設定の `allowedEnvVars` で差し込む。ユーザー設定の hooks は、Mac の Claude Desktop で動かすセッションも含め、そのマシンのすべてのセッションにかかる。

hook の `onFailure` は既定のままにする。こうすると、daemon が止まっていても hook の失敗は判断なしとして扱われ、公式アプリの動きは変わらない。

### 操作の規則

検証で分かったことから、次の規則を守る。

- 発言を送るのは、状態が idle のときだけにする。権限の確認が開いているときに Enter を送ると、確認への許可として扱われる。busy のあいだはいつ確認が開くか分からないので、daemon で発言を待たせる
- 応答が始まる前に割り込むと、送った発言が入力欄に戻る。次の発言を送る前に入力欄を空にする（方法は未確認）
- 割り込まれたときは Stop が届かない。トランスクリプトの `[Request interrupted by user]` か、状態の変化から判断する
- 画面の承認待ちの表示は daemon が消す。公式アプリで答えられても hook は打ち切られないので、PostToolUse や状態の変化を見て消す。PermissionRequest には `tool_use_id` がないので、直前の PreToolUse とは、セッション・ツール名・入力の内容で対応づける
- zellij を操作するときは、`--session` と `--pane-id` を必ず指定する
- 新しいフォルダーでは、最初に信頼の確認が端末に出る。端末画面の表示（S9）から答えられるようにする

## gasho-hub

- daemon からの情報をマシンごとにまとめ、SQLite に保存する
- 画面とは WebSocket でつなぎ、変化をすぐに送る
- GitHub の情報を取得する。トークンは、対象のリポジトリだけに絞った fine-grained personal access token を読み取り専用で作り、hub だけに置く。CI の結果の取得に要る権限は、実装のときに確かめる
- 通知を Web Push でスマホに送る。iPhone では、ホーム画面に追加した PWA でだけ受け取れる。公式アプリの通知と重なるので、通知の種類ごとに切り替えられるようにする

## 画面

| 画面 | 内容 | 主な部品 |
|---|---|---|
| ホーム | マシンとセッションの一覧、承認待ち、通知 | Data Table、Badge、Notification Stack |
| セッション | 会話の履歴、許可と拒否、発言の入力、端末画面 | Chat、AI Response、AI Agent Activity、Prompt Input、xterm.js |
| リポジトリ | ブランチツリー、worktree、Issues、PRs、Actions | Animated Tabs、Data Table、自作の SVG |
| 全体の枠 | ナビゲーション、検索 | Sidebar、Sheet、Command Menu |

easyui.site にない部品は、次のもので補う。

- 端末の表示：xterm.js
- 長い会話やログの仮想スクロール：TanStack Virtual
- 画面の分割：shadcn/ui の Resizable
- PWA：vite-plugin-pwa
- ブランチツリー：SVG で自作する

easyui.site の部品はアニメーションが多いので、会話の逐次表示のように更新が多い場所では、アニメーションの少ない部品を使う。

## セキュリティ

Gasho からは手元のマシンでコマンドを実行させられるので、次のように守る。

- 画面と hub は Tailscale の中だけに公開する。HTTPS は Tailscale Serve で用意する
- daemon は、マシンごとのトークンで hub に接続する
- hooks を受けるポートは 127.0.0.1 に限り、共有シークレットを確かめる
- 発言の送信と承認は、すべて操作のログに残す
- Anthropic の認証情報は読まない。GitHub のトークンは hub だけに置く

## 実装の順序

1. セッションの観測と通知（S1〜S3、S5）
2. 権限の確認への許可と拒否（S4）
3. Git と GitHub の表示（G1〜G4、H1〜H3）
4. Gasho が起動するセッション（S6〜S9）

1と2は、`claude rc` の運用を変えずに使え、検証も済んでいる。3は、Claude Code の内部の形式に頼る部分が少ない。4は検証で動くことを確かめたが、守るべき操作の規則が多いので最後にする。

## 未確認の事項

- hook から拒否を返したときの動き
- 割り込みで入力欄に戻った発言を消す方法
- Mac（launchd、zellij）での動き
- AskUserQuestion に hook で答える方法
- トランスクリプトなどの内部の形式が、Claude Code の更新で変わったときの影響
- easyui.site の部品の、スマホでの重さ
