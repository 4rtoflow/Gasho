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

### working server に gasho-daemon を入れる

Claude Code を動かすマシン（working server）ごとに、gasho-daemon を1つ動かす。手順は [docs/daemon-setup.md](docs/daemon-setup.md) にまとめた。おおまかには次のとおり。

```bash
# GitHub Packages から入れる設定（初めてのときだけ。読むのに read:packages の権限のトークンが要る）
gh auth refresh -s read:packages
npm config set @4rtoflow:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken "$(gh auth token)"

npx @4rtoflow/gasho-daemon register --server http://<Gasho サーバーの IP アドレス>:7740 --code <コード>
npx @4rtoflow/gasho-daemon doctor          # 要るものが揃っているかを確かめる
npx @4rtoflow/gasho-daemon service install # 常駐させる（Ubuntu は systemd、Mac は launchd）。これからは Gasho の画面から更新できる
```

gasho-daemon は GitHub Packages の npm パッケージ `@4rtoflow/gasho-daemon` として配っているので、リポジトリの clone も `npm install` も要らない。`doctor` は、Node.js、登録、Claude Code、セッションの端末、git、GitHub CLI、通知の hooks が揃っているかを確かめ、足りないものがあれば、使えなくなる機能と直し方を示す。

### Gasho からセッションを起動して、入力する

ホームの「新しいセッション」か、サイドバーの worktree の一覧の見出しにある「＋」を押して、working server とフォルダーを選ぶと、そのマシンで `claude --remote-control <名前>` が起動する。「＋」はどの画面からでも押せて、選ぶ項目はダイアログに出る。このセッションには、セッション画面の入力欄から指示を送れる。公式アプリ（スマホ・Desktop）からも、同じセッションを操作できる。

画面に出すのは、こうして Gasho が起動したセッションだけ。端末や `claude rc` で起動したセッションは、一覧にも通知にも出さない。

サイドバーには、これらのセッションがある worktree を、working server に分けずに1つの一覧で出す。どの worktree のセッションかは、gasho-daemon がセッションの作業フォルダーで git を流して調べる。各行にはブランチ名（ブランチが無いときはフォルダー名）とリポジトリ名を出し、working server が2台以上あるときはその名前も出す。最後に会話があったセッションの worktree から並べ、まだ会話がないセッションは起動した時刻で数える。確認を待っているセッションがある worktree には「確認」、オフラインの working server の worktree には「オフライン」と出す。リポジトリの外のフォルダーのセッションと、worktree を調べない前の版の gasho-daemon のセッションは、作業フォルダーごとに1行にする。セッションがまだないときも、一覧の見出しと「＋」は出す。

セッションがすべて無くなった worktree も、ブラウザーが覚えていて、一覧の最後に残す。その worktree を押すと、セッションの無い worktree の画面が開き、そこの「サイドバーから外す」で一覧から外せる。覚えるのはそのブラウザーだけなので、スマホと PC では別になる。

worktree を押すと、その worktree で最後に開いたセッションを開く（ページを読み込み直したあとは、最後に会話があったセッション）。セッション画面の上には、同じ worktree のセッションを起動した順にタブで並べ、タブを押すとセッションを切り替える。タブの右の「＋」を押すと、その worktree の最上位のフォルダー（リポジトリの外ならセッションの作業フォルダー）で、新しいセッションをすぐ起動して開く。

タブの左の時計のボタンを押すと、その worktree の過去の会話を、新しいものから 30 件まで出す。Claude Code が worktree のフォルダー（とその中のフォルダー）に残した会話のうち、いま開いている Claude Code が無いものである。会話を押すと、その会話のフォルダーで `claude --remote-control <名前> --resume <ID>` を起動し、Gasho が起動したセッションとして開く。名前は、会話に付けた名前か、Claude Code が付けた題になる。Gasho の外で動いている会話は、一覧に出さない。

サイドバーの worktree は、ドラッグで並べ替えられる。PC では、マウスで項目をそのままドラッグする（押して離すだけなら、worktree を開く）。スマホでは、項目の右端のつまみをドラッグする（項目に触れて動かすと一覧がスクロールする）。キーボードでは、項目にフォーカスして Alt+↑・Alt+↓ で動かせる。並べ替えると、それからは最後に使った順ではなく、その並びのまま変わらない。並べ替えたあとに初めてセッションを起動した worktree は、一覧の先頭に出る。見出しの「最後に使った順に戻す」（「＋」の左）を押すと、元の並び方に戻る。並び順はブラウザーごとに覚えるので、PC とスマホでは別々になる。

PC では、サイドバーの右の端をドラッグして、幅を200〜360px（標準は248px）のあいだで変えられる。セッションの右に開くパネル（ブランチグラフ、ファイル、プラグインのパネル）も、左の端をドラッグして、幅を380〜620px（標準はウィンドウの幅の40%）のあいだで変えられる。ウィンドウが狭いときは、パネルを開いても会話の欄に140px残るところで止まる。端をダブルクリックすると標準の幅に戻る。端にフォーカスして ←・→ でも変えられる。幅はブラウザーごとに覚える。

- セッションは、gasho-daemon がセッションごとに用意する端末（`gasho-<名前>-xxxx`）の中で動く。端末は gasho-daemon とは別のプロセスで、Ubuntu では systemd のスコープの中で動くので、gasho-daemon を動かし直してもセッションは止まらない。SSH から `gasho-daemon attach <その名前>` で直接見て、そのまま操作することもできる（Ctrl+] で抜ける。名前を付けずに実行すると、端末の一覧を出す）。gasho-daemon 0.10 までは zellij が要った。そのころに起動したセッションは、終わるまで zellij で動かし続ける
- フォルダーの一覧に出るのは、Claude Code が信頼しているフォルダーと、その親フォルダー（`~/repos` など）。一覧にないフォルダーは「ほかのフォルダーを入力する…」で絶対パスを入れる。Claude Code がまだ信頼していないフォルダーで起動するときは、信頼するかを画面で確かめる（下の「起動する前に、フォルダーを作る・clone する」）。gasho-daemon が 0.10.0 より前の working server では、これまでどおり端末で一度 `claude` を起動して信頼してから使う
- 作業中は、送信ボタンが停止ボタンに変わる。押すと Esc を送って作業を止める
- 送った時点で作業中になっていた指示（公式アプリからの発言と重なったときなど）は daemon が預かり、作業が終わってから順に送る
- 送った指示は、すぐに会話の末尾に「送信中…」と出す。Claude Code が指示を会話に記録するのは、daemon が指示を入力したときで、モデルを先に切り替える（`/model`）ときなどは数秒かかる。記録されると、その記録に置き換わる。daemon が預かった指示は「送信待ち」と出す
- 応答が始まる前に止めると、Claude Code は止めた指示を端末の入力欄に戻す。daemon は、次の指示を貼り付ける前に入力欄を空にする
- Claude の返答は Markdown として表示する。HTML は表示せず、画像は読み込まずにリンクとして出す
- 会話は新しいほうから読み込む。上へスクロールすると、前の会話を自動で読み込んで上に足すので、ボタンを押さずにそのまま遡れる。見えている発言の位置は動かない。スマホでは、スクロールが止まってから足す。読み込めなかったときは、一覧の上の「もう一度」で読み込み直す
- 入力欄に「!」で始まる文を入れると、Claude Code の「!」（シェルモード）と同じく、working server のセッションのフォルダーで、そのままシェルのコマンドとして実行する。入力欄には「! シェル」と出て、文字が等幅になり、送信ボタンは「実行」になる。会話には、コマンドと出力を1つにまとめて出す（失敗したコマンドの出力は赤）。Claude Code はコマンドが終わってから会話に記録するので、それまでは「実行中…」と出す。止めるには停止ボタン（Esc）を押す。ファイルは添付できない。Claude Code 2.1.323 では、コマンドが終わると Claude がその出力に返答する。コマンドは Claude Code の権限の確認を通らずに実行される
- 入力欄で、モデル（既定・Opus 5.5 など、Claude Code の選択画面と同じ名前）、Effort（Low〜Max）、Ultracode を選んで送ると、送る前にそのセッションだけ切り替える。全体の既定は変えない。会話の途中でモデルを変えると、次の返答では履歴を新しいモデルで読み直すので、時間とトークンが多くかかる
- モデルの名前は、daemon が Claude Code の `/model` の選択画面から読んで覚える。覚えていないか24時間たったときは、待機中のいちばん新しい Gasho のセッションで選択画面を開いて閉じるので、その会話に `/model` の記録が残る
- 入力欄に `/model` や `/effort high` のように書いて送ることはできない。これらは、すべての新しいセッションの既定も変えてしまうため。`/effort ultracode on` と `off` は送れる
- Effort と Ultracode の切り替えには、その working server の gasho-daemon が 0.6.0 以上である必要がある。0.5 の gasho-daemon ではモデルの切り替えと添付だけ、それより前のものでは文字の入力だけになり、扱えない操作は出ない
- クリップのボタン、ドラッグ、貼り付けでファイルを添付できる（1回に5個、合わせて10MB まで）。ファイルは working server の `~/.local/share/gasho/attachments/` に保存され、Claude が読む。セッションが終わると消える
- 入力欄に書きかけた文、添付したファイル、選んだモデル・Effort・Ultracode、↑ で呼び出せる送った文は、セッションごとに覚えておく。ほかのセッションやホームに移って戻っても残る。ページを開いているあいだだけ覚えるので、読み込み直すと消える
- ホームでは、Gasho が起動したセッションが使ったトークンを、過去24時間の推移と内訳（入力、出力、キャッシュへの書き込み、キャッシュからの読み込み）で見られる。daemon が、セッションとそのサブエージェントの会話の記録（`~/.claude/projects/` の下）から、返答ごとに1回ずつ数える。キャッシュからの読み込みは、それまでの会話を毎回読み直した分で、たいてい全体の大部分を占める
- ホームのタイルは、上の辺の真ん中にあるつまみをドラッグして並べ替えられる。つまみは、PC ではタイルにポインターを乗せると出て、スマホではいつも出ている。ドラッグ中は、ほかのタイルが場所を空け、画面の上端・下端に近づけるとスクロールする。Esc を押すと元の並びに戻る。つまみにフォーカスして、矢印キーでも動かせる。並びはブラウザーごとに覚える。並べ替えると見出しの横に出る「並びを元に戻す」で、最初の並びに戻る
- `/exit` を送るか公式アプリで終了すると、daemon がセッションの端末も閉じる
- `claude rc` が起動したセッションには、外から入力する公式の手段がないので、Gasho からは入力できない。公式アプリから操作する

起動したセッションの記録は `~/.config/gasho/managed.json` に残り、daemon を起動し直しても引き継ぐ。

### 起動する前に、フォルダーを作る・clone する

新しいセッションのフォームでは、選んだフォルダーの中に新しいフォルダーを作ったり、GitHub のリポジトリを clone したりできる。1つのフォルダーに複数のリポジトリを置き、そのフォルダーでセッションを起動する使い方（`zen` のようなフォルダー）にも使える。使うには、working server の gasho-daemon が 0.10.0 以上である必要がある。

- 「新しいフォルダー」：名前を入れて「作る」を押すと、選んだフォルダーの中にフォルダーができ、そのフォルダーが選ばれる。続けて clone すると、その中に入る
- 「GitHub から clone」：`owner/name` か GitHub の URL を入れて「clone する」を押すと、working server で `gh repo clone` が動き、選んだフォルダーの中に clone する。フォルダーの名前は、空ならリポジトリの名前になる。clone したあとも選んだフォルダーはそのままなので、同じフォルダーに続けて clone できる。clone したリポジトリで起動するときは、「このフォルダーを選ぶ」を押してから起動する
- clone には、working server の GitHub CLI（`gh`）とそのログインを使う。Gasho は GitHub のトークンを扱わない。gh と git は端末なしで動かすので、パスワードや SSH のホスト鍵は尋ねず、それが要るときは失敗する。10分で終わらない clone は止める
- 同じ名前のフォルダーやファイルがすでにあるときは、作らず、clone もしない。名前に `/` は使えない（1階層ずつ作る）。`-` で始まる名前、`.`、`..` も使えない
- 作ったフォルダーと clone したリポジトリは、フォームを開いているあいだ、フォルダーの一覧に出る。そこで起動して Claude Code が信頼すると、それからは一覧にいつも出る

clone したリポジトリは、親のフォルダーを信頼していても、Claude Code はまだ信頼していない（Claude Code は、リポジトリの外のフォルダーの信頼を、リポジトリの中に引き継がない）。こうしたフォルダーで起動すると、Claude Code が信頼するかを尋ね、起動はそこで止まる。フォームには、そのことと、Claude Code からの注意（フォルダーの設定が前もって許可しているコマンドなど。英語のまま）が出る。

- 「信頼して起動する」を押したときだけ、gasho-daemon が Claude Code の確認で「Yes, I trust this folder」を選ぶ。カーソルが Yes にあることを画面で確かめてから、Enter を1回だけ押す。信頼したことは Claude Code に保存され、次からは尋ねられない
- 信頼すると、Claude Code はそのフォルダーのファイルを読み書きし、コマンドを実行できるようになる。フォルダーの中の設定（`.claude/settings.json` の許可や hooks など）も使う。自分で作ったものや、よく知っているリポジトリだけを信頼する
- 信頼のあとで、フォルダーの `.mcp.json` にある MCP サーバーを使うかを Claude Code が尋ねたときは、Esc で答えて、使わずに起動する。Claude Code は、この答えをフォルダーの `.claude/settings.local.json` に保存する。起動したあとで、そのことを知らせる。使うときは、端末で `claude` を起動し、`/mcp` から有効にする
- 信頼しているフォルダーの中に作ったフォルダー（リポジトリでないもの）は、その信頼を引き継ぐので、確認は出ない

### セッションの名前の変更、フォーク、削除

セッション画面の上のタブを右クリックすると（スマホでは長押し）、名前の変更、フォーク、削除のメニューが開く。使えるのは、その working server の gasho-daemon が 0.9.0 以上で、つながっているときだけ。

名前を変えると、Gasho での名前はすぐ変わる。

- daemon が Claude Code に `/rename <名前>` を送り、Claude Code での名前も変える。Claude Code は Remote Control のセッション名も変えるので、公式アプリの表示も変わる想定（公式アプリの画面ではまだ確かめていない）
- 作業中は、指示と同じように daemon が預かり、作業が終わってから送る
- 端末で `/rename` したときも、Gasho の名前をそれに合わせる
- 名前を付けずに起動したセッションは、はじめ「<フォルダー名>-gasho」で、最初の発言のあと、Claude Code がその発言から付けたタイトル（「セッション名の自動設定」など）に自動で変わる（gasho-daemon 0.10.0 以上）。その前に名前を変えたときは、変えた名前のまま。端末の入力欄に打ちかけの文字があるときは、それを消さずに、空くまで `/rename` を待たせる
- 名前は1行で、60文字まで

フォークすると、会話をそこまで引き継いだ新しいセッションが、同じフォルダーで起動する（`claude --remote-control <名前> --resume <ID> --fork-session`）。元のセッションは、そのまま使える。

- 名前は、はじめ「<元の名前> のフォーク」になっていて、変えられる
- Claude Code は、フォークした会話を、発言やコマンドが記録されるまでファイルに書き出さない。daemon は、起動した直後に `/rename` を送って名前を付け、引き継いだ会話をすぐ Gasho に出す
- 前の発言から時間がたっていて会話も長いと、Claude Code が要約から始めるかを尋ねることがある。daemon は Esc で答え、会話をそのまま引き継ぐ。次の返答では会話をすべて読み直すので、時間とトークンが多くかかる
- ホームのトークンの数には、引き継いだ会話の分を入れない
- まだ会話がないセッションは、フォークできない

削除すると、daemon が Claude Code を終了し、セッションの端末を閉じて、Gasho の一覧から外す。開いていたセッションを削除したときは、隣のタブ（右、無ければ左）を開き、タブが無くなったら worktree の画面を開く。会話の記録は working server に残るので、タブの左の過去の会話から開き直せる。

- 作業中なら、途中で止まる。待たせていた指示は送らず、添付ファイルは消える
- daemon は Claude Code に SIGTERM を送り、8秒たっても終わらなければ端末ごと止める

### セッション画面とブランチグラフ

- セッション画面のヘッダーは、右上のボタンで隠せる（スマホでは画面上部のバーの右端）。隠すと、セッション名と状態だけの1行になる。スマホでは、セッション名と状態をいつも画面上部のバーに出すので、隠すとこの1行もなくなり、その分を会話に使える。PC では、隠したかどうかをブラウザごとに覚える。スマホでは、セッション画面を開くたびに隠した状態から始まる
- 会話の文字の大きさは、サイドバーの「設定」で変えられる。12〜20px（標準は14px）のあいだで、見本の会話を見ながら選ぶ。時刻、ツールの折りたたみ、コード、表の文字も同じ割合で変わる。入力欄とヘッダーの文字は変わらない。ブラウザごとに覚えるので、スマホと PC で別々に決められる
- 会話の中のツールの呼び出し（コマンドの実行など）は、その結果と一緒に1つの折りたたみにまとめて出す
- ツールの呼び出しが続くところは、ツールの種類にかかわらず（Bash、Read、Edit などが混ざっていても）全部を1つの折りたたみにまとめる。閉じたままでも、呼び出した回数、最後に呼び出したツールとその内容、エラーになった回数がわかる。開くと、呼び出しごとの折りたたみが並ぶ
- Claude Code が会話を要約したところ（Conversation compacted）には、「会話を要約しました」の区切り線を出す。要約の本文は線の下に折りたたんでおき、押すと開く。要約は Claude Code がユーザーの発言として記録するが、Gasho では発言として出さない
- Claude Code が権限の確認を出しているあいだは、入力欄の上に確認のカードを出し、Gasho から「許可」「今後も許可」「拒否」で答えられる。端末や公式アプリでも答えられ、そちらで答えるとカードは消える。「今後も許可」は、Claude Code が許可のルール（`Bash(npm test:*)` など）を提案したときだけ出る。拒否すると、端末で「No」を選んだときと同じく、Claude は作業を止めて次の指示を待つ。使うには hooks を入れ直す（`hooks install`）
- ヘッダーのブランチ名を押すと、ブランチグラフを開く。PC ではセッションの右にパネルとして並べ、スマホでは画面全体に出す。セッションのリポジトリのブランチと、全ブランチの新しいほうから300件のコミットを、枝分かれとマージの線で表示する
- GitHub プラグインを入れると（「プラグイン」の節）、ブランチ名と「ファイル」のあいだに「Issues」「Pull requests」が出る。押すと、リポジトリの開いている Issue と Pull request の一覧を、同じようにパネルで開く。一覧の項目を押すと、GitHub へは移らずに、本文とコメント（Pull request ではレビュー、チェック、変更したファイルも）を Gasho の中で読める。GitHub のページは、パネルの「GitHub」から開く。working server の GitHub CLI（gh）で読むので、working server で `gh auth login` を済ませておく。gh のログインを使うので、Gasho は GitHub のトークンを扱わない。プラグインに対応した gasho-daemon の working server でだけ出る
- ブランチの一覧には、ローカルのブランチ（push していないコミットの数など）と、リモートにだけあるブランチ（雲のアイコン）を並べる。見出しを押すと、一覧を折りたためる
- コミットの件名は省略せずに出す。長い件名は、その行を横にスクロールして読む（スクロールバーは出さない）
- ブランチ名の右のアイコンは、GitHub のそのブランチのページを開く
- 作業フォルダーがリポジトリでなく、その中に複数のリポジトリがあるとき（2階層下まで探す）は、ヘッダーに「複数のリポジトリ…」と「ブランチ…」を出す。「複数のリポジトリ…」を押すと、GitHub で開くリポジトリを選べる。「ブランチ…」を押すとブランチグラフを開き、タブでリポジトリを切り替えられる

### セッションのフォルダーのファイルを見る・編集する

セッション画面のヘッダーの「ファイル」を押すと、そのセッションのフォルダーのファイルを、ブランチグラフと同じようにパネルで開く（PC ではセッションの右、スマホでは画面全体）。使うには、working server の gasho-daemon が 0.11.0 以上である必要がある。

- フォルダーを押すと中に入り、上の場所の表示から前のフォルダーに戻れる。フォルダーを先にして名前の順に並べ、ファイルには大きさと最終更新を添える。`.git` は出さない
- ファイルを押すと中身を開く。テキストは行番号を付けて出し、Markdown と SVG は「表示」と「テキスト」を切り替えられる。画像（PNG、JPEG、GIF、WebP など）は画像として出す。開けるのは、テキストは 1MB、画像は 5MB まで。バイナリのファイルと、UTF-8 でないテキストは表示しない
- 「折り返す」で長い行を折り返す。ブラウザーごとに覚え、スマホでは折り返す状態から始まる
- 「編集」を押すと書き換えられ、「保存」（Ctrl+S・⌘S）で working server のファイルに書き込む。改行コード（CRLF）と BOM は、元のまま保つ。読み取り専用のファイルは編集できない
- 保存しようとしたファイルが、開いたあとで変わっていたとき（Claude が書き換えたときなど）は、上書きせずに知らせる。「上書きして保存」を押したときだけ上書きする。「編集を捨てて読み込み直す」で、いまの中身を開き直す
- 編集中の内容は、ほかのファイルやセッションに移っても残り、フォルダーの一覧には「未保存」と出る。ページを開いているあいだだけ覚えるので、読み込み直すと消える（その前にブラウザーが確かめる）
- フォルダーの「新しいファイル」で、そのフォルダーに空のファイルを作り、編集の画面で開く。同じ名前のファイルやフォルダーがあれば作らない
- 読み書きできるのは、セッションのフォルダーの中だけ。フォルダーの外を指すシンボリックリンクは、一覧に「フォルダーの外」と出すが、開かない
- 保存と作成は、ファイルのパスと大きさを操作のログに残し、ホームの「最近の操作」に出す。ファイルの中身は Gasho サーバーに残さない

### 端末を管理する

画面の「端末」で、登録した端末の一覧、名前の変更、登録の取り消し、登録コードの発行ができる。取り消した端末の接続はすぐに切れる。コマンドでも操作できる。

```bash
npm run hub:devices                              # 一覧
node apps/hub/src/cli.ts revoke <端末の ID>      # 取り消し（30秒以内に接続が切れる）
```

### プラグイン

Gasho の画面と gasho-daemon には、プラグインで機能を足せる。仕組みは [docs/plugins.md](docs/plugins.md) にまとめた。プラグインは [GashoPlugins](https://github.com/4rtoflow/GashoPlugins) に置く。GitHub の Issues と Pull requests のパネル、ホームの GitHub のタイルも、GitHub プラグイン（`github`）になった。

いまは、Gasho サーバーでコマンドを実行して入れる。GashoPlugins から画面で選んで入れる機能は、次の段階で作る。

```bash
npm run hub:plugin -- add ~/repos/GashoPlugins/github/dist          # ビルドしたプラグインを入れる
npm run hub:plugin -- add --link ~/repos/GashoPlugins/github/dist   # 作っているあいだ。ビルドするたびに画面と gasho-daemon が入れ替わる
npm run hub:plugin -- list
npm run hub:plugin -- remove github
```

入れたプラグインは、サイドバーの「プラグイン」の画面に出る。そこで有効・無効を切り替え、daemon の部分（working server で動く部分）を動かす working server を選ぶ。入れ直したり有効にしたりしても、Gasho サーバーと gasho-daemon を起動し直さなくてよい。daemon の部分は、プラグインに対応した gasho-daemon でだけ動く。古い gasho-daemon の working server では、プラグインの画面に「gasho-daemon が古い」と出る。

### 外から使う（必要なとき）

Gasho サーバーは LAN の中だけで使う前提にしている。外から使うときや、iPhone のホーム画面に追加して使うときは、Tailscale を導入する。手順は [docs/iphone.md](docs/iphone.md) にまとめた。

1. Gasho サーバー・スマホ（・Mac）に Tailscale を入れる
2. Gasho サーバーで `sudo tailscale serve --bg 7740` を実行する。`https://<マシン名>.<tailnet>.ts.net/` で Gasho を開けるようになる。Serve は Gasho サーバーに 127.0.0.1 からつなぐので、`GASHO_ALLOW_NETS` は変えなくてよい
3. Mac の gasho-daemon を家の外からつなぐときは、Gasho サーバーを `GASHO_ALLOW_NETS=lan,tailscale npm run hub` で起動して、Tailscale のアドレスからも受け付ける

### 開発

```bash
npm run web:dev    # Vite。/ws、/api、/plugins は Gasho サーバー（127.0.0.1:7740）に中継する
npm test
npm run typecheck
```

### 公開

gasho-daemon（`@4rtoflow/gasho-daemon`）とプラグインの SDK（`@4rtoflow/gasho-plugin-sdk`）は、GitHub Actions（`.github/workflows/release.yml`）が GitHub Packages に公開する。15分ごとに main を見て、前に公開してから中身が変わったパッケージだけを公開する。

版は x.y.z の形にする。

- x は変えない。gasho-daemon は 0、SDK はプラグインの API のメジャーと同じ 1
- 機能を足したときは y を上げ、z を 0 に戻す。前に公開してからマージした PR に `enhancement` のラベルが付いているとき、またはプラグインの API の版（`PLUGIN_API`）が変わったときを、機能の追加とする
- それ以外は直しとして、z を上げる

機能を足す PR には `enhancement` のラベルを付ける。PR では版を変えない。公開するときに、GitHub Actions が新しい版を `apps/daemon/src/daemon.ts` の `DAEMON_VERSION` と `packages/plugin-sdk/package.json` に書いて main にコミットし、そのコミットに `daemon-v<版>`・`plugin-sdk-v<版>` のタグを付けてから公開する。タグを付けたあとで公開に失敗したときは、次の回にそのタグから公開し直す。

15分を待たずに公開するときは、`gh workflow run release.yml` で動かす。次に何が公開されるかは、最新の main を checkout して `node scripts/release.ts plan` を実行すると見られる（何も変えない）。パッケージの中身を確かめるときは、`npm run pack -w @gasho/daemon`、`npm run pack -w @gasho/plugin-sdk` で、それぞれの `dist/package` に作る。

## 環境変数

| 変数 | 使う側 | 既定値 |
|---|---|---|
| `GASHO_HUB_HOST` / `GASHO_HUB_PORT` | hub | `0.0.0.0` / `7740` |
| `GASHO_ALLOW_NETS` | hub | `lan`（このマシンと LAN のプライベートアドレス）。CIDR と `lan`・`tailscale` をカンマで並べる |
| `GASHO_DB` | hub | `~/.local/share/gasho/hub.db` |
| `GASHO_WEB_DIST` | hub | `apps/web/dist` |
| `GASHO_PLUGINS_DIR` | hub | `~/.local/share/gasho/plugins`（入れたプラグイン） |
| `GASHO_PLUGIN_CACHE` | hub | `~/.cache/gasho/hub-plugins`（配るプラグインの版ごとの写し） |
| `GASHO_LATEST_CHECK` | hub | なし。`off` にすると、公開されている gasho-daemon の最新の版を調べない |
| `GASHO_NPM_BIN` | hub・daemon | Node.js と同じフォルダーの `npm`（最新の版を調べる、更新で入れる） |
| `GASHO_DAEMON_CONFIG` | daemon | `~/.config/gasho/daemon.json` |
| `GASHO_HUB_URL` | daemon | 登録した Gasho サーバーから決める |
| `GASHO_HOOK_PORT` | daemon | `7741` |
| `GASHO_HOOK_SECRET` | daemon・hooks install | なし |
| `GASHO_CLAUDE_DIR` / `GASHO_CLAUDE_BIN` | daemon | `~/.claude` / `claude` |
| `GASHO_GH_BIN` | daemon | `gh` |
| `GASHO_POLL_MS` | daemon | `3000` |
| `GASHO_PLUGINS` | daemon | なし。`none` にすると、この working server ではプラグインの daemon の部分を動かさない |
| `GASHO_DAEMON_HOME` | daemon | `~/.local/share/gasho/daemon`（`service install` と更新が、版ごとに gasho-daemon を入れるフォルダー） |

gasho-daemon の変数は、`~/.config/gasho/daemon.env` に `名前=値` の形で書いておくこともできる。gasho-daemon のコマンドは、起動するときにこのファイルを読む。端末で設定した値のほうが優先される。

## フォントとアイコン

画面のフォントは [Gen Interface JP](https://gen.typesetting.jp/)（Inter と Noto Sans JP を組み合わせた書体）で、npm の `gen-interface-jp` を使い、Gasho サーバーから配信する。外部の CDN には取りに行かない。使う太さは Regular・Medium・SemiBold の3つで、どれも文字の範囲ごとに分かれたファイルなので、ブラウザは表示する文字を含むファイルだけを読み込む。ライセンスは SIL Open Font License 1.1 で、全文を `apps/web/public/licenses/gen-interface-jp-OFL.txt` に置き、画面と一緒に `/licenses/gen-interface-jp-OFL.txt` で配信している。

ホーム画面のアイコン（`apps/web/public/icons/`）は、[Noto Emoji](https://github.com/googlefonts/noto-emoji) の 🙏（`2D/svg/emoji_u1f64f.svg`）を画面の背景の色の上に置き、PNG にしたもの。ライセンスは SIL Open Font License 1.1 で、全文を `apps/web/public/licenses/noto-emoji-OFL.txt` に置き、`/licenses/noto-emoji-OFL.txt` で配信している。

## 注意

LAN の中では通信が暗号化されない。端末のトークンも平文で流れるので、家の LAN を信用できる前提で使う。外から使うときや、LAN を信用できないときは、Tailscale を導入する。

## nakamaba/

`nakamaba/` は Nakamaba で配信しているサイトで、公開・更新は `nakamaba/` フォルダを指定して行う。

```bash
node <nakamaba スキルのフォルダ>/scripts/nakamaba.mjs publish nakamaba
```
