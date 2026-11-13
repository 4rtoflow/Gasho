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

いま動くのは、セッションの観測と通知、LAN での待ち受け、端末の登録、Gasho から起動したセッションへの入力、worktree と Pull request のカンバンまで。

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

### working server に gasho-daemon を入れる

Claude Code を動かすマシン（working server）ごとに、gasho-daemon を1つ動かす。手順は [docs/daemon-setup.md](docs/daemon-setup.md) にまとめた。おおまかには次のとおり。

```bash
git clone https://github.com/4rtoflow/Gasho.git ~/repos/Gasho && cd ~/repos/Gasho
node apps/daemon/src/cli.ts register --server http://<Gasho サーバーの IP アドレス>:7740 --code <コード>
node apps/daemon/src/cli.ts doctor          # 要るものが揃っているかを確かめる
node apps/daemon/src/cli.ts service print   # 常駐させる設定ファイル（Ubuntu は systemd、Mac は launchd）を書き出す
```

`npm install` は要らない。`doctor` は、Node.js、登録、Claude Code、zellij、git、GitHub CLI、通知の hooks が揃っているかを確かめ、足りないものがあれば、使えなくなる機能と直し方を示す。

### Gasho からセッションを起動して、入力する

ホームの「新しいセッション」か、サイドバーのセッションの一覧の見出しにある「＋」を押して、working server とフォルダーを選ぶと、そのマシンで `claude --remote-control <名前>` が起動する。「＋」はどの画面からでも押せて、選ぶ項目はダイアログに出る。このセッションには、セッション画面の入力欄から指示を送れる。公式アプリ（スマホ・Desktop）からも、同じセッションを操作できる。

画面に出すのは、こうして Gasho が起動したセッションだけ。端末や `claude rc` で起動したセッションは、一覧にも通知にも出さない。

サイドバーには、これらのセッションを working server に分けずに1つの一覧で出し、最後に会話があったものから並べる。まだ会話がないセッションは、起動した時刻で並べる。オフラインの working server のセッションには「オフライン」と出す。セッションがまだないときも、一覧の見出しと「＋」は出す。

- working server に zellij が要る（0.45 で確かめた）。セッションは、専用の zellij セッション（`gasho-<名前>-xxxx`）の中で動くので、SSH から `zellij attach <その名前>` で直接見ることもできる
- フォルダーの一覧に出るのは、Claude Code がすでに信頼しているフォルダー。ほかのフォルダーは、端末で一度 `claude` を起動して信頼してから使う
- 作業中は、送信ボタンが停止ボタンに変わる。押すと Esc を送って作業を止める
- 送った時点で作業中になっていた指示（公式アプリからの発言と重なったときなど）は daemon が預かり、作業が終わってから順に送る
- 送った指示は、すぐに会話の末尾に「送信中…」と出す。Claude Code が指示を会話に記録するのは、daemon が指示を入力したときで、モデルを先に切り替える（`/model`）ときなどは数秒かかる。記録されると、その記録に置き換わる。daemon が預かった指示は「送信待ち」と出す
- 応答が始まる前に止めると、Claude Code は止めた指示を端末の入力欄に戻す。daemon は、次の指示を貼り付ける前に入力欄を空にする
- Claude の返答は Markdown として表示する。HTML は表示せず、画像は読み込まずにリンクとして出す
- 入力欄で、モデル（既定・Opus 5.5 など、Claude Code の選択画面と同じ名前）、Effort（Low〜Max）、Ultracode を選んで送ると、送る前にそのセッションだけ切り替える。全体の既定は変えない。会話の途中でモデルを変えると、次の返答では履歴を新しいモデルで読み直すので、時間とトークンが多くかかる
- モデルの名前は、daemon が Claude Code の `/model` の選択画面から読んで覚える。覚えていないか24時間たったときは、待機中のいちばん新しい Gasho のセッションで選択画面を開いて閉じるので、その会話に `/model` の記録が残る
- 入力欄に `/model` や `/effort high` のように書いて送ることはできない。これらは、すべての新しいセッションの既定も変えてしまうため。`/effort ultracode on` と `off` は送れる
- Effort と Ultracode の切り替えには、その working server の gasho-daemon が 0.6.0 以上である必要がある。0.5 の gasho-daemon ではモデルの切り替えと添付だけ、それより前のものでは文字の入力だけになり、扱えない操作は出ない
- クリップのボタン、ドラッグ、貼り付けでファイルを添付できる（1回に5個、合わせて10MB まで）。ファイルは working server の `~/.local/share/gasho/attachments/` に保存され、Claude が読む。セッションが終わると消える
- 入力欄に書きかけた文、添付したファイル、選んだモデル・Effort・Ultracode、↑ で呼び出せる送った文は、セッションごとに覚えておく。ほかのセッションやホームに移って戻っても残る。ページを開いているあいだだけ覚えるので、読み込み直すと消える
- ホームでは、Gasho が起動したセッションが使ったトークンを、過去24時間の推移と内訳（入力、出力、キャッシュへの書き込み、キャッシュからの読み込み）で見られる。daemon が、セッションとそのサブエージェントの会話の記録（`~/.claude/projects/` の下）から、返答ごとに1回ずつ数える。キャッシュからの読み込みは、それまでの会話を毎回読み直した分で、たいてい全体の大部分を占める
- `/exit` を送るか公式アプリで終了すると、daemon が zellij のセッションも閉じる
- `claude rc` が起動したセッションには、外から入力する公式の手段がないので、Gasho からは入力できない。入力欄の下の「公式アプリで開く」から操作する

起動したセッションの記録は `~/.config/gasho/managed.json` に残り、daemon を起動し直しても引き継ぐ。

### セッションの名前の変更、フォーク、削除

サイドバーのセッションを右クリックすると（スマホでは長押し）、名前の変更、フォーク、削除のメニューが開く。使えるのは、その working server の gasho-daemon が 0.9.0 以上で、つながっているときだけ。

名前を変えると、Gasho での名前はすぐ変わる。

- daemon が Claude Code に `/rename <名前>` を送り、Claude Code での名前も変える。Claude Code は Remote Control のセッション名も変えるので、公式アプリの表示も変わる想定（公式アプリの画面ではまだ確かめていない）
- 作業中は、指示と同じように daemon が預かり、作業が終わってから送る
- 端末で `/rename` したときも、Gasho の名前をそれに合わせる
- 名前は1行で、60文字まで

フォークすると、会話をそこまで引き継いだ新しいセッションが、同じフォルダーで起動する（`claude --remote-control <名前> --resume <ID> --fork-session`）。元のセッションは、そのまま使える。

- 名前は、はじめ「<元の名前> のフォーク」になっていて、変えられる
- Claude Code は、フォークした会話を、発言やコマンドが記録されるまでファイルに書き出さない。daemon は、起動した直後に `/rename` を送って名前を付け、引き継いだ会話をすぐ Gasho に出す
- 前の発言から時間がたっていて会話も長いと、Claude Code が要約から始めるかを尋ねることがある。daemon は Esc で答え、会話をそのまま引き継ぐ。次の返答では会話をすべて読み直すので、時間とトークンが多くかかる
- ホームのトークンの数には、引き継いだ会話の分を入れない
- まだ会話がないセッションは、フォークできない

削除すると、daemon が Claude Code を終了し、zellij のセッションを閉じて、Gasho の一覧から外す。会話の記録は working server に残るので、端末で `claude --resume` を使えば開き直せる。

- 作業中なら、途中で止まる。待たせていた指示は送らず、添付ファイルは消える
- daemon は Claude Code に SIGTERM を送り、8秒たっても終わらなければ zellij のセッションごと止める

### セッション画面とブランチグラフ

- セッション画面のヘッダーは、右上のボタンで隠せる（スマホでは画面上部のバーの右端）。隠すと、セッション名と状態だけの1行になる。PC では、隠したかどうかをブラウザごとに覚える。スマホでは、セッション画面を開くたびに隠した状態から始まる
- 会話の中のツールの呼び出し（コマンドの実行など）は、その結果と一緒に1つの折りたたみにまとめて出す
- Bash の呼び出しが続くところは、全部を1つの折りたたみにまとめる。閉じたままでも、実行した回数、最後に実行したコマンド、エラーになった回数がわかる。開くと、コマンドごとの折りたたみが並ぶ
- ヘッダーのブランチ名を押すと、ブランチグラフを開く。PC ではセッションの右にパネルとして並べ、スマホでは画面全体に出す。セッションのリポジトリのブランチと、全ブランチの新しいほうから300件のコミットを、枝分かれとマージの線で表示する
- ブランチ名と最終更新のあいだの「Issues」「Pull requests」を押すと、リポジトリの開いている Issue と Pull request の一覧を、同じようにパネルで開く。一覧の項目を押すと、GitHub へは移らずに、本文とコメント（Pull request ではレビュー、チェック、変更したファイルも）を Gasho の中で読める。GitHub のページは、パネルの「GitHub」から開く。working server の GitHub CLI（gh）で読むので、working server で `gh auth login` を済ませておく。gh のログインを使うので、Gasho は GitHub のトークンを扱わない。その working server の gasho-daemon が 0.7.0 以上のときだけ出る。項目を Gasho の中で読むには 0.8.0 以上が要る（それより前のものでは、項目を押すと GitHub で開く）
- ブランチの一覧には、ローカルのブランチ（push していないコミットの数など）と、リモートにだけあるブランチ（雲のアイコン）を並べる。見出しを押すと、一覧を折りたためる
- コミットの件名は省略せずに出す。長い件名は、その行を横にスクロールして読む（スクロールバーは出さない）
- ブランチ名の右のアイコンは、GitHub のそのブランチのページを開く
- 作業フォルダーがリポジトリでなく、その中に複数のリポジトリがあるとき（2階層下まで探す）は、ヘッダーに「複数のリポジトリ…」と「ブランチ…」を出す。「複数のリポジトリ…」を押すと、GitHub で開くリポジトリを選べる。「ブランチ…」を押すとブランチグラフを開き、タブでリポジトリを切り替えられる

### カンバン

サイドバーの「カンバン」で、選んだ repo の worktree と自分の Pull request を、次に動く人ごとの5つの列（自分の番、エージェント作業中、GitHub 待ち、レビュー待ち、完了）に並べる。判定は [4rtoflow/Dashboard](https://github.com/4rtoflow/Dashboard) と同じにしている。

- 見る repo は、「見る repo」から working server ごとに選ぶ（1台に30まで）。選べるのは、Claude Code が信頼しているフォルダーにある GitHub の repo で、worktree がいくつ信頼されていても、repo ごとに primary checkout の1つにまとめる。選んだ repo は Gasho サーバーが覚える
- gasho-daemon が、repo ごとに `git worktree list` と、working server の gh で自分の Pull request（開いているものと閉じたもの）を1分おきに読む。「今すぐ見直す」で、すぐに読み直す（10秒以内に読んだばかりなら読まない）。読めなかった repo は、前に読めたカードを出したまま、理由を上に出す
- worktree 1つを1枚のカードにし、次の表を上から当てはめて、先に当たったものの列に置く。「次にすること」は、自分の番のカードにだけ出す

| 順 | 条件 | 列 | 次にすること |
|---|---|---|---|
| 1 | Claude Code の会話が答えを待っている（同じ worktree でほかの会話が作業していても） | 自分の番 | その会話で答える |
| 2 | Claude Code の会話が作業している | エージェント作業中 | |
| 3 | 開いた Pull request がなく、閉じたものがある | 完了 | |
| 4 | Pull request がまだない | 自分の番 | 作業を進めるか、PR を作る |
| 5 | ベースブランチとコンフリクトしている | 自分の番 | ベースブランチを取り込んでコンフリクトを解く |
| 6 | CI が失敗している（同じチェックは最新の run だけを見る） | 自分の番 | ログを見て直し、push する |
| 7 | 今の commit に対して変更が求められている | 自分の番 | 指摘を直して push する |
| 8 | CI が走っている | GitHub 待ち | |
| 9 | Draft のまま | 自分の番 | Ready にする |
| 10 | 変更を求められた後に push した（再レビュー待ち） | レビュー待ち | |
| 11 | 承認されている | 自分の番 | マージする |
| 12 | それ以外 | レビュー待ち | |

- Claude Code の会話は、Gasho が起動したものに限らず、その working server で動いているものをすべて見る。会話の作業フォルダーを含む、いちばん深い worktree のカードに付く。Gasho が起動したセッションは、カードの名前を押すと開く
- primary checkout は、開いた Pull request があるか、会話が作業しているか答えを待っているときだけ出す。worktree のない、開いた Pull request も1枚のカードにする
- 同じ列の中では、Pull request が長く動いていないものを上に出す。カードの題を押すと、GitHub の Pull request を開く
- PC では、カンバンをページの高さに収め、カードがページの下端を超える列は、その列の中でスクロールする。スマホでは列を1つずつ出し、ページごとスクロールする
- 列ごとに、並び（既定の順か、Issue 番号・PR 番号・最終更新の昇順・降順）、表示（詳細か、1行の簡潔）、幅を変えられる。番号や更新の時刻がないカードは、どちらの向きでも下に並べる。最初はレビュー待ちと完了を簡潔にする。幅は、列の右端のつまみをドラッグするか、つまみを選んで左右キー（Shift で4倍）で変え、ダブルクリックで元に戻す（スマホでは列を1つずつ出すので、幅は変えない）。どれも、ブラウザごとに覚える
- サイドバーの「カンバン」の数字は、自分の番のカードの数
- 使えるのは、その working server の gasho-daemon が 0.10.0 以上のとき。オフラインの working server の repo のカードは出さない

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
| `GASHO_GH_BIN` | daemon | `gh` |
| `GASHO_POLL_MS` | daemon | `3000` |

gasho-daemon の変数は、`~/.config/gasho/daemon.env` に `名前=値` の形で書いておくこともできる。gasho-daemon のコマンドは、起動するときにこのファイルを読む。端末で設定した値のほうが優先される。

## フォント

画面のフォントは [Gen Interface JP](https://gen.typesetting.jp/)（Inter と Noto Sans JP を組み合わせた書体）で、npm の `gen-interface-jp` を使い、Gasho サーバーから配信する。外部の CDN には取りに行かない。使う太さは Regular・Medium・SemiBold の3つで、どれも文字の範囲ごとに分かれたファイルなので、ブラウザは表示する文字を含むファイルだけを読み込む。ライセンスは SIL Open Font License 1.1 で、全文を `apps/web/public/licenses/gen-interface-jp-OFL.txt` に置き、画面と一緒に `/licenses/gen-interface-jp-OFL.txt` で配信している。

## 注意

LAN の中では通信が暗号化されない。端末のトークンも平文で流れるので、家の LAN を信用できる前提で使う。外から使うときや、LAN を信用できないときは、Tailscale を導入する。

## nakamaba/

`nakamaba/` は Nakamaba で配信しているサイトで、公開・更新は `nakamaba/` フォルダを指定して行う。

```bash
node <nakamaba スキルのフォルダ>/scripts/nakamaba.mjs publish nakamaba
```
