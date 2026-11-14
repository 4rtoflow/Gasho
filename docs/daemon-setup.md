# gasho-daemon のセットアップ

gasho-daemon は、Claude Code を動かすマシン（working server）ごとに1つ動かすプログラム。そのマシンのセッションの様子を Gasho サーバーに送り、Gasho から起動したセッションには指示を送る。この文書では、working server に gasho-daemon を入れて、動かし続けるまでの手順を説明する。Gasho サーバーの用意は [README](../README.md) を見る。

手順は次の6つで、Ubuntu と Mac で違うのは 5 だけ。

1. 要るものを入れる
2. GitHub Packages から入れられるようにする
3. Gasho サーバーに登録する
4. `doctor` で確かめる
5. 常駐させる
6. 通知を使うときは hooks を入れる

## 1. 要るものを入れる

| もの | 使う機能 | ないとき |
|---|---|---|
| Node.js 24 以上 | gasho-daemon そのもの | 動かない |
| Claude Code（`claude`）、ログイン済み | セッションを見る、起動する | 動かない |
| zellij 0.45 以上 | Gasho からセッションを起動し、指示を送る | セッションを見るだけになる |
| git | ブランチグラフ、カンバン | ブランチグラフが出ない。カンバンが repo を読めない |
| GitHub CLI（`gh`）、ログイン済み | Issues と Pull requests のパネル、新しいセッションの「GitHub から clone」、カンバン | パネルが出ない。clone できない。カンバンが repo を読めない |
| Claude Code の hooks | 通知（応答の完了、確認待ち、入力待ち）、Gasho からの権限の確認への回答 | 通知が来ない。権限の確認には端末か公式アプリで答える |

Mac では、Homebrew で `brew install node zellij gh` のように入れられる。Ubuntu では、Node.js は公式のバイナリかバージョン管理のツール（nvm など）、zellij は公式のリリースのバイナリ、gh は公式の apt リポジトリから入れる。どれも、`which claude zellij gh` で見つかる場所に置く。

Claude Code は公式の手順で入れ、端末で一度 `claude` を起動してログインしておく。Gasho の「新しいセッション」の一覧には、Claude Code が信頼しているフォルダーと、その親フォルダーが出る。まだ信頼していないフォルダー（clone したリポジトリなど）で起動するときは、Gasho の画面で信頼するかを確かめ、「信頼して起動する」を選べば gasho-daemon が Claude Code の確認に答える（gasho-daemon 0.10.0 以上。それより前の gasho-daemon では、端末で一度 `claude` を起動して信頼しておく）。

## 2. GitHub Packages から入れられるようにする

gasho-daemon は、GitHub Packages の npm パッケージ `@4rtoflow/gasho-daemon` として配っている。npx で実行するので、リポジトリを置く必要も `npm install` も要らない。gasho-daemon は Node.js の組み込みの機能だけで動く。

GitHub Packages の npm パッケージは、公開されていても、読むのに GitHub のトークン（`read:packages` の権限）が要る。GitHub CLI でログインしていれば、そのトークンに権限を足して、npm に設定する。

```bash
gh auth refresh -s read:packages
npm config set @4rtoflow:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken "$(gh auth token)"
```

トークンは `~/.npmrc` に保存される。gh を使わないときは、GitHub の設定で `read:packages` の権限を付けた classic の personal access token を作り、最後の行の `$(gh auth token)` の代わりに使う（fine-grained のトークンは GitHub Packages の npm に使えない）。

以下の手順の `npx @4rtoflow/gasho-daemon` は、どのフォルダーで実行してもよい。初めて実行したときに、パッケージを npm のキャッシュに入れる。毎回 `npx` を付けたくないときは、`npm install -g @4rtoflow/gasho-daemon` で入れて、`gasho-daemon` のコマンドで実行する。

開発のためにリポジトリを clone したマシンでは、`npx @4rtoflow/gasho-daemon` の代わりに、リポジトリのフォルダーで `node apps/daemon/src/cli.ts` を実行してもよい。

## 3. Gasho サーバーに登録する

まず登録コードを出す。Gasho の画面の「端末」で「コードを発行」を押すか、Gasho サーバーで `npm run hub:pair` を実行する。コードは10分間有効で、1回だけ使える。

```bash
npx @4rtoflow/gasho-daemon register --server http://<Gasho サーバーの IP アドレス>:7740 --code <コード>
```

working server は、このマシンのホスト名で画面に出る。別の名前にしたいときは `--name <名前>` を付ける。名前は、あとから「端末」画面でも変えられる。登録は `~/.config/gasho/daemon.json` に保存される（本人だけが読める権限）。

## 4. `doctor` で確かめる

```bash
npx @4rtoflow/gasho-daemon doctor
```

要るものが揃っているかを、1行ずつ確かめる。次は、hooks を入れていないマシンでの例。

```
gasho-daemon 0.11.0 のセットアップの確認

✓ Node.js         24.22.2
✓ 登録            「ubuntu-server」として http://192.168.3.133:7740 に登録済み
✓ Gasho サーバー  つながります
✓ Claude Code     2.1.323 (Claude Code)
✓ zellij          0.45.1
✓ git             2.53.0
✓ GitHub CLI      2.103.3、ログイン済み
! hooks           入っていません
    → 通知（応答の完了、確認待ち）と、Gasho からの権限の確認への回答に使います。docs/daemon-setup.md の「通知を使う」を見てください
✓ daemon          動いています（127.0.0.1:7741）

daemon は動かせます。! の機能は、入れるまで使えません。
```

✓ は揃っているもの、! はその機能だけが使えないもの、✗ は gasho-daemon が動かないもの。✗ があれば、→ の指示に従って直す。

## 5. 常駐させる

gasho-daemon を、マシンの起動とともに動かし、止まったら動かし直すようにする。そのための設定ファイルは `service print` が書き出す。Ubuntu では systemd のユーザーサービス、Mac では launchd のエージェントになる。

`service print` は、実行した端末の PATH と Node.js の場所を設定ファイルに書き込む。npx で実行したときは、npx のキャッシュは消えることがあるので、同じ版の gasho-daemon を npx で起動する設定になる（キャッシュにあればネットワークを使わない）。`npm install -g` で入れたときは、入れた場所の gasho-daemon を直接起動する。`doctor` で claude・zellij・gh が見つかる端末で実行する。あとでこれらを入れ直して場所が変わったら、もう一度書き出す。

### Ubuntu（systemd）

```bash
mkdir -p ~/.config/systemd/user
npx @4rtoflow/gasho-daemon service print > ~/.config/systemd/user/gasho-daemon.service
systemctl --user daemon-reload
systemctl --user enable --now gasho-daemon
loginctl enable-linger "$USER"
```

最後の `loginctl enable-linger` で、ログインしていなくても、マシンが起動したときから gasho-daemon が動く。

| すること | コマンド |
|---|---|
| 状態を見る | `systemctl --user status gasho-daemon` |
| ログを見る | `journalctl --user -u gasho-daemon -f` |
| 動かし直す | `systemctl --user restart gasho-daemon` |
| 止める | `systemctl --user stop gasho-daemon` |

### Mac（launchd）

```bash
npx @4rtoflow/gasho-daemon service print > ~/Library/LaunchAgents/local.gasho.daemon.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.gasho.daemon.plist
```

| すること | コマンド |
|---|---|
| 状態を見る | `launchctl print gui/$(id -u)/local.gasho.daemon` |
| ログを見る | `tail -f ~/Library/Logs/gasho-daemon.log` |
| 動かし直す | `launchctl kickstart -k gui/$(id -u)/local.gasho.daemon` |
| 止める | `launchctl bootout gui/$(id -u)/local.gasho.daemon` |

Mac では、ログインしているあいだだけ動く。スリープすると Gasho サーバーとの接続が切れ、スリープから戻ると自動でつなぎ直す。長く離れるあいだも使うときは、スリープしない設定にする。

### 試しに動かすとき

常駐させずに、端末の前面で動かすこともできる。Ctrl+C で止まる。

```bash
npx @4rtoflow/gasho-daemon run
```

1台のマシンで gasho-daemon を2つ動かさない。常駐させたあとに前面でも動かすと、hooks の待ち受けのポート（7741）がぶつかり、Gasho サーバーとの接続も取り合いになる。

## 6. 通知を使う（hooks）

応答の完了、権限の確認待ち、入力待ちを通知するには、Claude Code に hooks を入れる。hooks を入れなくても、セッションを見る、起動する、指示を送ることはできる。

hooks は、gasho-daemon にだけ分かる秘密の値を付けて送る。まず、その値を `~/.config/gasho/daemon.env` に書く。gasho-daemon のコマンドは、どれも起動するときにこのファイルを読む。

```bash
umask 077
echo "GASHO_HOOK_SECRET=$(openssl rand -hex 32)" >> ~/.config/gasho/daemon.env
```

次に、hooks を Claude Code の設定（`~/.claude/settings.json`）に追記する。秘密の値は `daemon.env` から入る。元のファイルはバックアップされる。

```bash
npx @4rtoflow/gasho-daemon hooks print     # 追加される内容を確かめる
npx @4rtoflow/gasho-daemon hooks install   # 追記する
```

最後に、gasho-daemon を動かし直して、秘密の値を読ませる（5 の表の「動かし直す」）。

- hooks はユーザーの設定に入るので、そのマシンのすべての Claude Code のセッションにかかる。設定は、動いているセッションにも数秒で反映される
- 秘密の値は `~/.claude/settings.json` にもそのまま書き込まれる
- gasho-daemon が止まっていても、hooks の失敗は無視され、Claude Code の動きは変わらない
- 権限の確認（PermissionRequest）の hook は、Gasho で答えるまで最大1時間待つ。そのあいだも端末の確認は開いていて、端末や公式アプリでも答えられる
- 権限の確認に Gasho から答えられるようにする前に hooks を入れたマシンでは、`hooks install` をもう一度実行する。`doctor` は、PermissionRequest が入っていないときに知らせる

## 更新する

常駐の設定は、書き出したときの版の gasho-daemon を起動する。新しい版にするときは、新しい版で設定を書き出し直してから、動かし直す。

```bash
npx @4rtoflow/gasho-daemon@latest service print > ~/.config/systemd/user/gasho-daemon.service   # Mac では 5 の plist に書き出す
systemctl --user daemon-reload
systemctl --user restart gasho-daemon
```

Mac では、書き出したあと `launchctl bootout` と `launchctl bootstrap` で読み直す（5 の表）。`npm install -g` で入れたときは、`npm install -g @4rtoflow/gasho-daemon@latest` のあと動かし直す。clone したリポジトリで動かしているときは、`git pull` のあと動かし直す。

新しい機能には、Gasho サーバーと gasho-daemon の両方の更新が要ることが多いので、Gasho サーバーも同じ版にしておく。gasho-daemon の版は、ホームの「working server」のタイルに出る。

## やめる

1. 常駐をやめる
   - Ubuntu：`systemctl --user disable --now gasho-daemon` のあと、`~/.config/systemd/user/gasho-daemon.service` を消す
   - Mac：`launchctl bootout gui/$(id -u)/local.gasho.daemon` のあと、`~/Library/LaunchAgents/local.gasho.daemon.plist` を消す
2. 登録を取り消す：Gasho の「端末」画面でこの working server を取り消し、`~/.config/gasho/` を消す
3. hooks を入れたときは、`~/.claude/settings.json` から Gasho の hooks（`http://127.0.0.1:7741/hooks` を送り先にしたもの）を消す。インストールしたときのバックアップから戻してもよい

## うまくいかないとき

| こと | 確かめること |
|---|---|
| 「端末」画面で working server がオフラインのまま | `doctor` の「Gasho サーバー」と「daemon」。動いていなければログを見る |
| ログに `the Gasho server rejected this machine` と出る | 登録が取り消されている。3 からやり直す |
| 「新しいセッション」で起動できない | `doctor` の zellij。信頼の確認が出たら「信頼して起動する」を選んだか（gasho-daemon が 0.10.0 より前なら、フォルダーを端末の `claude` で信頼したか） |
| 「GitHub から clone」できない | `doctor` の GitHub CLI（ログインしているか）。gh が SSH で clone する設定（`gh config get git_protocol` が ssh）なら、working server の SSH の鍵と known_hosts。gasho-daemon が 0.10.0 以上か |
| Issues と Pull requests が出ない | `doctor` の GitHub CLI。gasho-daemon が 0.7.0 以上か |
| 通知が来ない | `doctor` の hooks。`~/.config/gasho/daemon.env` と `~/.claude/settings.json` の秘密の値が同じか |
| 常駐させると claude や zellij が見つからない | 設定ファイルの PATH。`doctor` で見つかる端末で `service print` を実行し直す |

## 設定（環境変数）

gasho-daemon の設定は環境変数で変える。gasho-daemon のコマンドは、どれも起動するときに `~/.config/gasho/daemon.env` を読むので、そこに `名前=値` の形で1行ずつ書いておけば、常駐させたときも前面で動かすときも同じ値になる。端末で設定した値のほうが優先される。

| 変数 | 意味 | 既定値 |
|---|---|---|
| `GASHO_HOOK_SECRET` | hooks に付ける秘密の値 | なし |
| `GASHO_HOOK_PORT` | hooks を待ち受けるポート（127.0.0.1） | `7741` |
| `GASHO_DAEMON_CONFIG` | 登録を保存するファイル。`daemon.env` は、このファイルと同じフォルダーから読む | `~/.config/gasho/daemon.json` |
| `GASHO_HUB_URL` | Gasho サーバーにつなぐ URL | 登録した Gasho サーバーから決める |
| `GASHO_CLAUDE_DIR` | Claude Code の設定と会話の記録のフォルダー | `~/.claude` |
| `GASHO_CLAUDE_BIN` | Claude Code のコマンド | `claude` |
| `GASHO_GH_BIN` | GitHub CLI のコマンド | `gh` |
| `GASHO_POLL_MS` | セッションの一覧を読み直す間隔（ミリ秒） | `3000` |
