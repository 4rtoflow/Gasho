# Claude Code の Remote Control と連携するための調査と検証

Gasho を、Mac と Ubuntu Server で動いている `claude rc` のセッションのクライアントにできるかを、2026年11月11日に調べた。実機での確認は Ubuntu Server で行い、Claude Code は 2.1.318 を使った。検証の途中で自動更新が入ったため、サーバーモードの子プロセスだけは 2.1.322 で動いた。仕様の案は [spec.md](spec.md) にまとめている。

## 結論

- rc の通信は、ローカルの子プロセスと Anthropic の API のあいだで直接行われる。第三者のクライアントが加わるための公開 API はなく、ローカルの認証情報で非公開の API を呼ぶことは規約で禁じられている
- 同じマシンの上なら、`claude agents --json`、トランスクリプト、hooks を使って、セッションの状態と履歴を取得し、権限の確認に答えられる。rc のサーバーモードで起動したセッションでも動くことを確かめた
- Gasho が自分の端末（はじめは zellij、gasho-daemon 0.11 からは node-pty と xterm.js。検証7）で `claude --remote-control` を起動したセッションには、発言の送信、割り込み、新規作成もできる。同じセッションを公式アプリからも操作できる

## rc の仕組み

`claude rc`（`claude remote-control`）の親プロセスは、セッションごとに次の子プロセスを起動する。

```
claude --print --sdk-url https://api.anthropic.com/v1/code/sessions/cse_… \
  --input-format stream-json --output-format stream-json --replay-user-messages …
```

子プロセスの入出力は Anthropic の API に直接つながっていて、ローカルで待ち受けるポートはない。公式ドキュメントも、ローカルのセッションは外向きの HTTPS 通信だけを行い、通信はすべて Anthropic の API を経由すると説明している。

ローカルには、次の情報が残る。

| 場所 | 中身 | 位置づけ |
|---|---|---|
| `claude agents --json` の出力 | pid、作業ディレクトリ、sessionId、名前、状態（busy・waiting・idle）、待っているもの（`waitingFor`） | 公式。CLI のヘルプにスクリプト用と書かれている |
| `~/.claude/projects/<作業ディレクトリ>/<sessionId>.jsonl` | 会話の記録（トランスクリプト） | 形式は非公開。Agent SDK の `getSessionMessages()` で読める |
| `~/.claude/sessions/<pid>.json` | 動いているセッションの情報。`bridgeSessionId` を含む | 内部用 |

トランスクリプトには、Gasho で使える記録が入っている。

| 記録 | 中身 |
|---|---|
| 各メッセージの `gitBranch` | その時点のブランチ |
| `pr-link` | セッションで扱った PR の番号、URL、リポジトリ |
| `bridge-session` | Remote Control のセッション ID。`cse_` で始まり、後半は公式アプリの URL の ID と同じ |
| `ai-title` | セッションの題名 |
| `cost-state` | 費用、所要時間、変更した行数 |
| `[Request interrupted by user]` | 割り込まれたこと |

公式アプリでセッションを開く URL は `https://claude.ai/code/<bridgeSessionId>` だった。`bridgeSessionId` は `~/.claude/sessions/<pid>.json` の値で、`session_` で始まる。

## 使えない手段と、その理由

- claude.ai/code が使う API を直接呼ぶ方法：規約は「Claude.ai の認証情報やセッショントークンを収集・保存・仲介してはならない」「Claude Code のバイナリを改変してはならない」と定めている（[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)）
- `--sdk-url` を自前のサーバーに向ける方法と、セッション間の通信に使われている Unix ソケットを使う方法：どちらも非公開の内部仕様に頼る
- Channels（MCP サーバーから、動いているセッションにメッセージを送る研究プレビューの機能）：自作のチャンネルには `--dangerously-load-development-channels` が要り、このフラグは `-p` で動く rc の子プロセスでは無視される。また、`claude remote-control` の前に付けたフラグは、安全と分かっているもの以外は起動を拒否される
- Agent SDK で専用のセッションを作る方法：Remote Control と併用できるという記載がない。規約は、製品やサービスを作る開発者に API キーでの認証を求めていて、個人用の常駐サーバーがサブスクリプションの認証で使ってよいかは明記されていない

規約は、改変していない Claude Code に自分のサブスクリプションでログインして使うことは妨げないとしている。Gasho は、ローカルの `claude` を公式の手段で動かすだけにする。

## 検証1：rc の子セッションでも hooks が届く

Gasho のフォルダーに一時的な hook を置き、rc のサーバーモードで起動されたセッションで確かめた。

- PreToolUse と PostToolUse が、command 型と HTTP 型の両方で届いた。HTTP 型では、イベントの JSON が 127.0.0.1 の受信サーバーに POST された。本文には `session_id`、`transcript_path`、`cwd`、`permission_mode`、`tool_name`、`tool_use_id`、`duration_ms` などが入っていた
- Stop はターンの終わりに届き、最後の応答の全文（`last_assistant_message`）と、動いているバックグラウンド処理の一覧（`background_tasks`）が入っていた
- 設定ファイルは、作ったときも書き換えたときも、セッションを再起動せずに数秒で反映された
- hook のプロセスには、`CLAUDE_CODE_SESSION_ID`、`CLAUDE_PID`、`CLAUDE_PROJECT_DIR`、`CLAUDE_CODE_ENVIRONMENT_KIND=bridge` が渡る。ドキュメントにある `CLAUDE_CODE_BRIDGE_SESSION_ID` は渡らなかった
- HTTP 型の hook のヘッダーに環境変数を入れる機能は、`${HOME}` では動いた。`CLAUDE_CODE_SESSION_ID` と `CLAUDE_PID` は空になったので、これらは hook の子プロセスにだけ渡されると見ている
- MessageDisplay（応答の文章を表示したときのイベント）は、文章を8回出したうち2回しか届かなかった

## 検証2：権限の確認は、先に答えたほうが採用される

テスト用のフォルダーに PermissionRequest の hook を置き、受信サーバーで応答を保留したり、時間をおいて許可したりした。対話モード（`claude --remote-control`）とサーバーモード（`claude remote-control --spawn session`）の両方で、同じ結果になった。

- hook が応答を保留しているあいだも、スマホのアプリに許可の確認が出た。対話モードでは、端末にもダイアログが出た
- スマホで先に許可すると、コマンドはすぐに実行された
- hook が先に許可を返すと、スマホの確認は消えてコマンドが実行された。端末には「Allowed by PermissionRequest hook」と表示された
- スマホで先に答えても、保留中の hook の HTTP リクエストは打ち切られなかった。時間切れで判断なしを返しても、何も起きなかった。接続が閉じられたのは、セッションのプロセスが終わったときだけだった
- 確認が出てから約6秒後に、`permission_prompt` の Notification が届いた
- 入力待ちの Notification（`idle_prompt`）は、対話モードでは応答の終わりから約60秒後に届いた。サーバーモードでは、約85秒待っても届かなかった
- 対話モードで確認が開いているあいだ、`claude agents --json` の状態は `waiting`、`waitingFor` は `permission prompt` になった

hook から拒否を返す動きは確かめていない。

## 検証3：Gasho が起動したセッションを操作できる

Ubuntu Server には tmux がなく、普段の `claude rc` は zellij（0.45.1）の中で動いていたので、zellij を使った。

- `zellij attach --create-background` と `zellij run` で `claude --remote-control` を起動でき、スマホのセッション一覧にも出た
- `zellij action paste` で文章を貼り付けてから Enter を送ると、発言として送信された。発言と応答はスマホにも表示された
- スマホから送った発言は、端末にも hooks にも届いた
- Esc で割り込めた。応答が始まる前に割り込むと、送った発言が入力欄に戻った。応答の途中で割り込むと、途中までの応答と `[Request interrupted by user]` がトランスクリプトに残った。どちらの場合も Stop は届かなかった
- 入力欄に戻った発言は、Ctrl+U と Backspace を交互に送ると消せた。Ctrl+U が画面上の1行を消し、Backspace がその前の改行を消す。長い文章を貼り付けたときは入力欄に `[Pasted text #2 +40 lines]` のようにまとめて表示され、Backspace 1回でまとめて消えた。空の入力欄に送っても何も起きなかった。Ctrl+C でも消せたが、`Press Ctrl-C again to exit` と表示され、続けて押すと Claude Code が終了するので使わない
- 応答のテキストは、ブロックが終わるまでトランスクリプトに書かれなかった。1から2000までの数字を書かせると、応答が始まってから約31秒後にまとめて書かれた。そのため Gasho の会話の表示では、長い応答は終わるまで出てこない
- 確認のダイアログが開いているときに文章を貼り付けて Enter を送ると、文章は捨てられ、Enter が選択中の「1. Yes」として扱われてコマンドが実行された
- 新しいフォルダーでは、最初に端末で信頼の確認に答える必要があった

zellij を操作するときは、`--session` で対象を必ず指定する。rc から起動されたセッションの環境変数には `ZELLIJ_SESSION_NAME=main` が入っていて、指定しないと普段使っている main セッションを操作してしまう。

## 検証4：モデルの切り替えと添付ファイル

2026年11月12日に、Gasho が起動したセッション（Claude Code 2.1.322）で確かめた。

- `/model sonnet` のように名前を付けて送ると、切り替えたうえで「新しいセッションの既定」として `~/.claude/settings.json` に保存された（`Set model to Sonnet 5.5 and saved as your default for new sessions`）。この検証で既定が変わったので、`model` の項目を消して元に戻した
- 名前を付けずに `/model` を送ると選択画面が開き、`Enter to set as default · s to use this session only · Esc to cancel` と表示された。矢印キーで移ってから「s」を押すと、そのセッションだけが切り替わり（`Set model to Haiku 5.5 for this session only`）、`settings.json` は変わらなかった
- 発言に `@絶対パス` を書くと、送信のときに Claude Code がそのファイルを読んだ。作業フォルダーの外にあるテキストも画像も、許可を求められずに読まれた
- 貼り付けた発言は、トランスクリプトに `<pasted_content id="…">…</pasted_content id="…">` で包まれて残る
- スラッシュコマンドは、`<command-name>` の付いたユーザーの発言と、出力の `<local-command-stdout>` として残る。選択画面を Esc で閉じたときのように、system の記録（subtype が `local_command`）として残ることもある
- 使ったモデルは、ターンの初めの `attachment` の記録（type が `model`）と、返答の `message.model` に残る
- まれに満足度のアンケート（`How is Claude doing this session?` と `1: Bad 2: Fine 3: Good 0: Dismiss`）が出る。モデルを切り替えた直後に出たとき、続けて貼り付けた発言が入力欄に入らず、送られなかった
- Node の組み込みの WebSocket は、14MB のメッセージを受け取れた

## 検証5：Effort と Ultracode

2026年11月12日に、Gasho が起動したセッション（Claude Code 2.1.322）で確かめた。設定ファイルの控えを取ってから試し、変わったものは元に戻した。

- `/effort high` は「新しいセッションの既定として保存」になり、`~/.claude/settings.json` に `modelSettings.<モデル>.effortLevel` が加わった。Gasho からは送らない
- `/effort ultracode on` と `/effort ultracode off` は、どちらも「このセッションだけ」で、設定ファイルは変わらなかった（`Ultracode on (this session only): …`、`Ultracode off. Effort stays high.`）
- `/model` の選択画面では、←→ で Effort が Low・Medium（既定）・High・xHigh・Max の順に変わり、端で止まる。「s」を押すと、モデルと Effort がそのセッションだけに適用された（`Set model to Sonnet 5.5 (default) for this session only with medium effort`）。設定ファイルは変わらなかった
- 選択画面の「Default (recommended)」が指すモデルは、時間とともに変わった（13時台の初めは Opus 5.5、30分後は Sonnet 5.5）。幅が狭いと、名前は `Default (recommend…` のように切れる
- 会話の途中でモデルを切り替えると、`… means the full history gets re-read.` と確認され、`1. Yes, switch to Haiku 5.5` と `2. No, go back` を選ぶ画面が出た。Enter で Yes を選ぶと、そのセッションだけ切り替わった
- 入力欄の上の `◐ medium · ultracode · /effort` は、変更のあとしばらくだけ出る。Ultracode がオンのあいだは、入力欄の上の罫線に `ultracode` と出続ける
- 入力欄には、次の発言の候補が薄い文字で出ることがある。Ctrl+U では消えない。`zellij action dump-screen --ansi` で見ると、候補は薄い文字（SGR 2）で描かれ、打った文字（SGR 22）と見分けられる
- Effort だけを変えて「s」を押したときも、`Set model to Haiku 5.5 for this session only with low effort` と出た
- 選択画面の枠の上端は `▔` の線で描かれ、入力欄の罫線（`─`）とは違う。選択画面と確認は、画面のいちばん下に出る
- 返答の記録には `"effort": "medium"` が残る。`claude agents --json` には、モデルも Effort も Ultracode も出ない
- CLI には `--effort <level>`（low・medium・high・xhigh・max）があり、`--effort ultracode` でも Ultracode が有効になる

## 検証6：フォーク、名前の変更、終了

2026年11月13日に、Claude Code 2.1.323 で確かめた。作業用の一時フォルダーで試し、試したあとで `claude purge` で消した。

- `claude --resume <ID> --fork-session` で起動すると、`claude agents --json` には、はじめから元と違う ID で出た。`--remote-control <名前>` と一緒に付けても起動し、Remote Control につながった
- フォークのトランスクリプトは、すぐには書かれなかった。`--name` を付けても同じだった。`/rename` を送ると、コピーした会話と一緒に書かれた
- コピーされた発言は、元と同じ uuid とタイムスタンプを持っていた。フォークは API を呼んでいないのに、終了したときの `cost-state` には元の会話の費用が入っていた
- 起動したときのレジストリ（`~/.claude/sessions/<pid>.json`）の名前は、`gasho-73` のような自動の名前（`nameSource` が `derived`）で、`--remote-control` に渡した名前とは別だった。`claude agents --json` の `name` も同じ
- `/rename <名前>`（別名 `/name`）を送ると、`Session renamed to: <名前>` と表示された。レジストリの名前（`nameSource` が `user` になる）と `claude agents --json` の名前が変わり、トランスクリプトに `custom-title` が記録された。入力欄の上の罫線にも名前が出る
- Claude Code のコードでは、`/rename` は、Remote Control のセッションがあるとその名前も変える。同じマシンで同じ名前のセッションが動いていると、別の名前を付ける。どちらも、画面ではまだ確かめていない
- SIGTERM を送ると、Claude Code は0.25秒以内に終了した。レジストリのファイルを消し、トランスクリプトの最後に `cost-state` を書いて、`claude --resume <ID>` で再開できると表示した。Remote Control につながっているセッションでは、1秒より長くかかった
- Claude Code のコードでは、前の発言から70分以上（`CLAUDE_CODE_RESUME_THRESHOLD_MINUTES`）たち、会話が10万トークン以上（`CLAUDE_CODE_RESUME_TOKEN_THRESHOLD`）あるセッションを再開すると、要約から始めるかを尋ねる。出るかどうかは、サーバー側の設定でも変わる。Esc で閉じると、何も保存せずにそのまま再開する。`Don't ask me again` を選ぶと、全体の設定（`resumeReturnDismissed`）に保存される。この問いも、画面ではまだ見ていない

## 検証7：zellij を使わずに Claude Code を動かす

2026年11月14日に、Claude Code 2.1.325 で確かめた。作業用の一時フォルダーで試し、試したあとで `claude purge` で消した。

- node-pty（`@lydell/node-pty` 1.1.0。node-pty のビルド済み版）で疑似端末を作り、出力を `@xterm/headless` 6.0.0 に読ませると、Claude Code の画面を読めた。信頼の確認は起動から約0.4秒で出て、`trustQuestion` などの画面を読む関数は、zellij の画面と同じように働いた
- xterm.js は、Claude Code の問い合わせのうち DA1 に答えた。kitty キーボードの問い合わせ（`CSI ? u`）には答えないので、Claude Code は従来のキーを使う。↓ ↑ Enter Esc Ctrl+U Backspace は、端末が送るのと同じバイト列で効いた
- 入力欄の薄い文字の候補（`Try "how does <filepath> work?"`）は、セルの属性（dim）で、打った文字と見分けられた。2行の日本語を bracketed paste で貼ると入力欄に入り、Enter を押さずに `clearPromptKeys` のキーで消せた
- 本家の node-pty 1.1.0 には Linux 用のビルド済みが入っておらず、コンパイラがないと入らない（この Ubuntu Server には gcc も make もない）。`@lydell/node-pty` は、プラットフォームごとのビルド済み（linux-x64 は約72KB）だけを入れ、install スクリプトもない
- 1セッション分の端末のプロセスは、メモリを約73MB 使った（zellij のサーバーは約74MB）
- systemd のユーザーサービスとして動く gasho-daemon が起動したプロセスは、サービスの cgroup に入る。KillMode の既定（control-group）では、サービスを動かし直すとそれらも止まる。`systemd-run --user --scope` で起動したプロセスは別のスコープに入り、サービスの外にいた。すでに動いているプロセスも、`StartTransientUnit` に PID を渡すとスコープへ移せた
- KillMode=process では直らない。npx で起動した gasho-daemon は `npm exec` → `sh -c` → `node` の形で動き、停止のときに sh は SIGTERM を node に渡さずに終わる。同じ形の一時的な unit で試すと、unit は止まったのに node が残った
- gasho-daemon の起動・入力・再起動・削除を、本物の Claude Code で通した（Remote Control・hooks・MCP は外した）。信頼の確認への回答を含めて起動は約2.4秒、`/rename` の入力は約0.6秒で済み、gasho-daemon を作り直しても端末を見つけてセッションを引き継ぎ、削除で Claude Code と端末が終わった

## 未確認の事項

- 名前の変更が、公式アプリのセッション名に反映されるか
- 古く長い会話を再開するときの問いの画面と、Esc で閉じたときの動き
- hook から拒否を返したときの動き
- Mac（launchd）での動き（端末の node-pty を含む）
- AskUserQuestion に hook で答える方法
- MessageDisplay が届く条件

## 参照したドキュメント

code.claude.com の次のページを、2026年11月11日に読んだ。

- Remote Control、Agent view
- Channels、Channels reference
- Hooks、Hooks guide
- Legal and compliance、Headless
- Agent SDK（overview、sessions、permissions、streaming input）
