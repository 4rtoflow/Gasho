# Claude Code の Remote Control と連携するための調査と検証

Gasho を、Mac と Ubuntu Server で動いている `claude rc` のセッションのクライアントにできるかを、2026年11月11日に調べた。実機での確認は Ubuntu Server で行い、Claude Code は 2.1.318 を使った。検証の途中で自動更新が入ったため、サーバーモードの子プロセスだけは 2.1.322 で動いた。仕様の案は [spec.md](spec.md) にまとめている。

## 結論

- rc の通信は、ローカルの子プロセスと Anthropic の API のあいだで直接行われる。第三者のクライアントが加わるための公開 API はなく、ローカルの認証情報で非公開の API を呼ぶことは規約で禁じられている
- 同じマシンの上なら、`claude agents --json`、トランスクリプト、hooks を使って、セッションの状態と履歴を取得し、権限の確認に答えられる。rc のサーバーモードで起動したセッションでも動くことを確かめた
- Gasho が zellij 上で `claude --remote-control` を起動したセッションには、発言の送信、割り込み、新規作成もできる。同じセッションを公式アプリからも操作できる

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
- 確認のダイアログが開いているときに文章を貼り付けて Enter を送ると、文章は捨てられ、Enter が選択中の「1. Yes」として扱われてコマンドが実行された
- 新しいフォルダーでは、最初に端末で信頼の確認に答える必要があった

zellij を操作するときは、`--session` で対象を必ず指定する。rc から起動されたセッションの環境変数には `ZELLIJ_SESSION_NAME=main` が入っていて、指定しないと普段使っている main セッションを操作してしまう。

## 未確認の事項

- hook から拒否を返したときの動き
- 割り込みで入力欄に戻った発言を消す方法
- Mac（launchd、zellij）での動き
- AskUserQuestion に hook で答える方法
- MessageDisplay が届く条件

## 参照したドキュメント

code.claude.com の次のページを、2026年11月11日に読んだ。

- Remote Control、Agent view
- Channels、Channels reference
- Hooks、Hooks guide
- Legal and compliance、Headless
- Agent SDK（overview、sessions、permissions、streaming input）
