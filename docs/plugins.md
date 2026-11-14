# Gasho のプラグイン（案）

Gasho のプラグインは、Gasho の画面の決まった場所に、項目・ページ・パネル・設定・タイルを足すための仕組みである。プラグインは、ブラウザーで動く「画面の部分」と、working server で gasho-daemon が動かす「daemon の部分」からなる。

プラグインは、GitHub のリポジトリ [4rtoflow/GashoPlugins](https://github.com/4rtoflow/GashoPlugins) に、プラグインごとのディレクトリとして並べる。利用者は、サイドバーの「プラグイン」から開く画面（プラグインの画面）で、GashoPlugins にあるプラグインから使うものを選んで追加する。動くのは、利用者が追加したプラグインだけである。

追加・更新・有効・無効・外すは、Gasho を動かしたまま反映する（ホットリロード）。開いている画面はページを読み込み直さずに、gasho-daemon は起動し直さずに、新しいプラグインで動く。Gasho サーバーも起動し直さない。いまセッション画面にある GitHub の Issues・Pull requests の機能は、GashoPlugins の最初のプラグインとして作り直す。このプラグインで、仕組みが足りることを確かめる。

この文書は、[Gasho 仕様（案）](spec.md) に足す、プラグインの仕様の案である。

## 用語

| 用語 | 指すもの |
|---|---|
| プラグイン（GashoPlugin） | Gasho の画面に部品を足し、必要なら working server で処理をするもの。`gasho-plugin.json` と、ビルドした画面の部分・daemon の部分のファイルからなる |
| GashoPlugins | プラグインを集めた GitHub の公開のリポジトリ（4rtoflow/GashoPlugins）。プラグインごとのディレクトリが並ぶ |
| カタログ | GashoPlugins のリリースに置く、プラグインの一覧（`catalog.json`）。プラグインの画面は、これを見て、追加できるプラグインを出す |
| プラグインの画面 | サイドバーの「プラグイン」から開くページ（`#/plugins`）。ホームや設定と同じく、メインの領域に出す。GashoPlugins のプラグインを追加・更新し、有効・無効を切り替え、外す |
| 画面の部分 | ブラウザーで動く ES モジュール（`web.js`）。拡張点に部品を足す |
| daemon の部分 | gasho-daemon が working server の子プロセスで動かす ES モジュール（`daemon.js`）。画面の部分から呼ばれて、コマンドを実行したりファイルを読んだりする |
| 拡張点 | プラグインが部品を足せる、画面の決まった場所。サイドバー、ページ、セッションのヘッダー、セッションのパネル、設定、ホームのタイル、会話の末尾、入力欄の下、worktree のタブの9つ |
| ホットリロード | 動いている Gasho で、プラグインを新しい版に入れ替えること。ページの読み込み直しも、Gasho サーバーと gasho-daemon の起動し直しも要らない |
| SDK | プラグインを書くための npm パッケージ。Gasho のリポジトリの `packages/plugin-sdk/` で作り、GitHub Packages に `@4rtoflow/gasho-plugin-sdk` として公開する。プラグインのコードでは `@gasho/plugin-sdk` の名前で使う |

## 前提

- プラグインは、利用者が自分で書くか Claude に書かせて、GashoPlugins に置く。ほかの人に配るためのマーケットプレイスや、その審査は作らない
- GashoPlugins のプラグインは、はじめはどれも入っていない。利用者が、プラグインの画面で使うものを選んで追加する
- プラグインのコードは信頼して動かす。画面の部分は、Gasho の画面と同じページで、同じ権限で動く。そのかわり、画面から追加できるのは、Gasho サーバーに設定したリポジトリ（GashoPlugins）のプラグインだけにする（「安全」）
- 追加・更新・有効・無効・外すと、開いている画面と gasho-daemon にすぐ反映する。プラグインを作っているあいだも、ソースを保存してビルドが終われば反映する（「ホットリロード」）
- プラグインは、Gasho の部品（ページとパネルの枠、タイル、Markdown の表示など）を SDK から使い、見た目と操作を Gasho のほかの画面とそろえる
- working server でコマンドを実行するのは、daemon の部分だけにする。画面の部分は、working server のフォルダーをパスで指さず、セッションの ID と、セッションのフォルダーの中のリポジトリのパスで指す。実際のフォルダーは gasho-daemon が決める。ブラウザーから来たパスを信用しない、いまの規則と同じである
- Gasho サーバーは、GashoPlugins を、Gasho サーバーのマシンの GitHub CLI（gh）のログインで読む。Gasho は GitHub のトークンを扱わない
- プラグインは、GitHub を読むことも変えることもできる。変える操作（assign、コメントなど）は、`kind` が `write` のメソッドの中で `ctx.github.write` で行い、操作のログに残す（「GitHub を読む・変える」）

## 機能

| 番号 | 機能 |
|---|---|
| P1 | サイドバーに項目を足す。押すと、そのプラグインのページに移る |
| P2 | プラグインのページ。ホームや設定と同じく、メインの領域いっぱいに出す |
| P3 | セッション画面のヘッダーの、リポジトリやブランチが並ぶ行に項目を足す。押すと、パネルかページかリンクを開くか、プラグインの処理を呼ぶ |
| P4 | セッションのパネル。PC ではセッションの右に並べ、スマホではセッションの代わりに出す |
| P5 | 設定画面に、プラグインごとの設定の項目を足す |
| P6 | ホームにタイルを足す |
| P7 | 画面の部分から、daemon の部分のメソッドを呼ぶ |
| P8 | daemon の部分から画面に、イベントで知らせる |
| P9 | プラグインの画面。サイドバーの「プラグイン」から開くページで、GashoPlugins のプラグインを一覧にして、追加・更新・有効・無効・外すを行う。daemon の部分を動かす working server も選ぶ |
| P10 | カタログ。GashoPlugins の GitHub Actions がプラグインをビルドしてリリースに置き、Gasho サーバーがそれを取ってきて入れる |
| P11 | ホットリロード。追加・更新・有効・無効・外すを、ページの読み込み直しも、Gasho サーバーと gasho-daemon の起動し直しもせずに反映する |
| P12 | 作っているプラグインを、Gasho サーバーのコマンドで、リンクして入れる |
| P13 | セッション画面の会話の末尾（最後の発言の下、入力欄の上）に部品を足す（API 1.2） |
| P14 | セッション画面で、入力欄の下の行（キーの案内と文字数の行）に部品を足す（API 1.4） |
| P15 | worktree のセッションのタブの行に、タブを足す。押すと、セッションと同じ場所にプラグインの画面を出す（API 1.5） |

P6 は、いまの GitHub の機能がホームにタイルを持っているので足した。P8 は GitHub では使わないが、working server の様子を監視するプラグインのために、API 1.5 で足した。P13 は、エージェントが作業しているあいだ、その様子を会話に出すプラグインのために、API 1.2 で足した。P14 は、セッションの Context Window の使用率と、Claude.ai のプランで決まっている使用量の上限を出すプラグインのために、API 1.4 で足した。P15 は、worktree の Issue と Pull request を、セッションと並んだタブで開くプラグイン（GashoPlugins の github-allmighty）のために、API 1.5 で足した。

## 構成

```
┌────────────────────────────────────────────────────────────────────┐
│ ブラウザー（gasho-web）                                            │
│                                                                    │
│   Gasho の画面（拡張点）              プラグインの画面の部分       │
│   ┌──────────────────────────┐        ┌─────────────────────────┐  │
│   │ サイドバー  ページ       │  部品  │ web.js                  │  │
│   │ ヘッダー    パネル       │◀───────│   definePlugin({...})   │  │
│   │ 設定        ホーム       │        │ web.css                 │  │
│   └────────────┬─────────────┘        └───────────▲─────────────┘  │
│                │ useRequest                       │ import()       │
└────────────────┼──────────────────────────────────┼────────────────┘
                 │ WebSocket                        │ HTTP
┌────────────────▼──────────────────────────────────┴────────────────┐
│ Gasho サーバー（gasho-hub）                                        │
│   ・GashoPlugins のカタログを読み、プラグインを入れる（gh）        │
│   ・入れたプラグイン、有効・無効、設定の値を持つ（SQLite）         │
│   ・プラグインのフォルダーを監視し、変わったらすぐ配り直す         │
│   ・web.js を配る（/plugins/<ID>/<ハッシュ>/web.js）               │
│   ・画面からの呼び出し（plugin.request）を中継する                 │
└────────────────┬──────────────────────────────────┬────────────────┘
                 │ plugin.request                   │ daemon.js
┌────────────────▼──────────────────────────────────▼────────────────┐
│ gasho-daemon（working server）                    │                │
│   セッションの ID をフォルダーに直す              │                │
│   gh を動かし、同じ問い合わせには記録を返す       │                │
│   ┌────────────▼──────────────────────────────────▼───────────┐    │
│   │ 子プロセス（プラグインごとに1つ）                         │    │
│   │ daemon.js：defineDaemonPlugin({ methods })                │    │
│   │ ctx.github で gh を、ctx.exec() で git を動かす           │    │
│   └───────────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────────┘
```

画面の部分は、拡張点に出す部品を Gasho の画面に渡し、daemon の部分の処理を SDK の `useRequest` で呼ぶ。呼び出しは Gasho サーバーが gasho-daemon に中継し、gasho-daemon がセッションの ID をフォルダーに直して、プラグインの子プロセスに渡す。`web.js` は、Gasho サーバーが HTTP でブラウザーに配る。`daemon.js` は、Gasho サーバーが WebSocket で gasho-daemon に渡す。GashoPlugins のカタログとプラグインは、Gasho サーバーが gh で取ってくる。

Gasho サーバーは、プラグインのコードを動かさない。Gasho サーバーで動く部分は、ブラウザーを開いていなくても続ける処理（GitHub を一定の間隔で読むなど）や、プラグインから Web Push を送るときに要る。これは今回は扱わない（「今回は扱わないこと」）。

## GashoPlugins の形

### リポジトリ

```
GashoPlugins/               https://github.com/4rtoflow/GashoPlugins
├─ package.json             ワークスペース。SDK を使う
├─ .github/workflows/       版の上がったプラグインをビルドして公開
├─ github/                  プラグイン1つ（ID は github）
│  ├─ gasho-plugin.json     ID、名前、版、API の版、メソッド、設定
│  ├─ src/web/index.tsx     画面の部分（definePlugin）
│  ├─ src/daemon/index.ts   daemon の部分（defineDaemonPlugin）
│  ├─ src/web/style.css     @gasho/plugin-sdk/plugin.css を読み込む
│  ├─ package.json          build は gasho-plugin build、dev は gasho-plugin build --watch
│  └─ dist/                 ビルドしたもの（リリースの tgz の中身）
│     ├─ gasho-plugin.json
│     ├─ web.js             ブラウザーで動く（react と SDK は入れない）
│     ├─ web.css            Gasho と同じテーマで作ったスタイル
│     └─ daemon.js          working server の子プロセスで動く
└─ <ほかのプラグイン>/      同じ形で並べる
```

プラグインは、GashoPlugins の直下に、ID と同じ名前のディレクトリとして置く。ソースは TypeScript と React で書き、SDK のビルドのコマンド `gasho-plugin build` で `dist/` にする。このコマンドは、中で Vite を使う。`web.js` と `daemon.js` は、使う npm パッケージを中に含めた1つのファイルにする。ただし、`web.js` には `react` などの共有するモジュールを入れない（「画面での読み込み」）。gasho-daemon は、node_modules なしで `daemon.js` を動かす。

GashoPlugins はワークスペースにして、SDK を `"@gasho/plugin-sdk": "npm:@4rtoflow/gasho-plugin-sdk@^1"` の別名で入れる。SDK は、画面の部分が使う `@gasho/plugin-sdk`、daemon の部分が使う `@gasho/plugin-sdk/daemon`、スタイルの `@gasho/plugin-sdk/plugin.css`、ビルドのコマンド `gasho-plugin` からなる。`plugin.css` は、Tailwind CSS のクラスを、Gasho と同じテーマの色と大きさで使えるようにする。SDK のメジャーは、プラグインの API のメジャーと同じにする。

### gasho-plugin.json

GitHub プラグインの場合は、次のようになる。

```json
{
  "id": "github",
  "name": "GitHub",
  "version": "1.0.0",
  "description": "セッションのリポジトリの、開いている Issue と Pull request を読む",
  "api": "1.0",
  "web": { "js": "web.js", "css": "web.css" },
  "daemon": { "js": "daemon.js" },
  "methods": {
    "list": { "kind": "read", "timeoutSeconds": 25 },
    "item": { "kind": "read", "timeoutSeconds": 25 }
  }
}
```

| 項目 | 内容 |
|---|---|
| `id` | 英小文字で始まり、英小文字・数字・`-` からなる2〜32文字。GashoPlugins のディレクトリの名前と同じにする。URL、保存のキー、操作のログに使う |
| `name`、`description` | 画面に出す名前（40文字まで）と説明 |
| `version` | プラグインの版（1.2.0 の形）。GashoPlugins に新しい版を出すときに上げる。プラグインの画面は、カタログの版が入れた版より新しいときに「更新」を出す。ホットリロードで入れ替えるかは、版ではなく中身のハッシュで判断する |
| `api` | プラグインが前提にする、プラグインの API の版。Gasho は、メジャーが同じで、マイナーが Gasho の対応する版以下のものだけを読み込む。daemon の部分は、マイナーがその gasho-daemon の版以下の working server でだけ使える（それより古い gasho-daemon は「古い」と出す）。拡張点を足すなど、前の版のプラグインがそのまま動く変更ではマイナーを上げ、動かなくなる変更ではメジャーを上げる。1.1 で、`session.launch`、`useLaunchSession`、`useNavigation` の `openSession`、daemon の部分の `ctx.folders()` と `ctx.dataDir` を足した。1.2 で、会話の末尾（P13、`conversationEnd`）と `useSessionActivity` を足した。1.3 で、daemon の部分の `ctx.github` を足した。1.4 で、入力欄の下（P14、`composerFooter`）、SDK の `Popover`、`SessionInfo` の `context` と `limits` を足し、プラグイン専用のフォルダーで動く Claude Code をセッションとして扱わないようにした。1.5 で、daemon の部分の `ctx.emit` と画面の部分の `useEvent`（P8）、worktree のタブ（P15、`worktreeTabs`・`worktreeViews`）、`useNavigation` の `worktreeHref`・`openWorktreeView` を足した |
| `web`、`daemon` | 画面の部分と daemon の部分のファイル。少なくともどちらか1つは要る |
| `methods` | 画面の部分から呼べる、daemon の部分のメソッド。`kind` は、読むだけのもの（`read`）か、何かを変えるもの（`write`）か。`write` の呼び出しは操作のログに残す。`timeoutSeconds` は待つ時間で、既定は15秒、長くても120秒まで |
| `permissions` | 読む・出す以外に、画面の部分がすること。`session.input`（セッションに発言を送る）と `session.launch`（セッションを起動する。API 1.1） |
| `settings` | 設定の項目（P5） |

## 拡張点

### 画面のどこに出るか

セッション画面では、サイドバーの項目（P1）、ヘッダーの項目（P3）、パネル（P4）、会話の末尾の部品（P13）、入力欄の下の部品（P14）、worktree のタブ（P15）が次の場所に出る。サイドバーの「プラグイン」は Gasho の項目で、プラグインの画面（P9）を開く。

```
┌────────────────┬───────────────────────────────────┬─────────────────┐
│ Gasho          │ * gasho-plugin  * api ＋ #30 ◀P15 │ Issues        x │
│                ├───────────────────────────────────┤ 4rtoflow/Gasho  │
│ ホーム         │ gasho-plugin               作業中 │                 │
│ リポジトリ ◀P1 │ Gasho main  Issues PRs ファイル   ├─────────────────┤
│ 端末           │             └── P3 ──┘            │ #12 仕様の案    │
│ プラグイン ◀P9 ├───────────────────────────────────┤ #11 読み込み    │
│ 設定           │                                   │                 │
│                │         会話                      │                 │
│ worktree    ＋ │ * 考え中... (12s)            ◀P13 │                 │
│ * main         │ ┌───────────────────────────────┐ │                 │
│   Gasho        │ │ Agent への指示を入力...       │ │  P4 のパネル    │
│ * feat/x       │ └───────────────────────────────┘ │                 │
│   Gasho        │  ↵ で送信     ◔ 36% 0/20000 ◀P14  │                 │
└────────────────┴───────────────────────────────────┴─────────────────┘

P1 サイドバーの項目 ─▶ P2 のページを開く（#/p/<ID>/<ページ>）
P3 ヘッダーの項目   ─▶ P4 のパネルを右に開く（スマホでは画面全体）
P13 会話の末尾      ─▶ 最後の発言の下に出し、会話と一緒にスクロールする
P14 入力欄の下      ─▶ 入力欄の下の行で、文字数の左に出す（スマホでも出す）
P15 worktree のタブ ─▶ タブの下に、セッションの代わりにプラグインの画面を出す
```

ホームのタイル（P6）と、設定画面のプラグインの区切り（P5）は、次の場所に出る。

```
ホーム（P6：プラグインのタイル）
┌─────────────┬─────────────┬─────────────┬─────────────┐
│ 作業中      │ 確認待ち    │ 待機中      │ 送った指示  │
├─────────────┴─────────────┴─────────────┼─────────────┤
│ セッション                              │ 通知        │
│                                         │             │
├─────────────┬───────────────────────────┤             │
│ トークン    │ トークンの内訳            │             │
├─────────────┴─────────────┬─────────────┼─────────────┤
│ 最近の操作                │ GitHub ◀P6  │ サーバー    │
│                           │ （small）   │             │
└───────────────────────────┴─────────────┴─────────────┘
```

```
設定（P5）
┌──────────────────────────────────────────────┐
│ 会話の文字の大きさ                           │
├──────────────────────────────────────────────┤
│ my-plugin（入れて有効にしたプラグイン）      │
│   読み直す間隔 [60] 秒                       │
│   下書きを出す  [x]                          │
└──────────────────────────────────────────────┘
```

### 部品の書き方

画面の部分は、拡張点ごとの部品をまとめたオブジェクトを、`definePlugin` で書き出す（`export default`）。GitHub プラグインの画面の部分は、次のようになる。

```tsx
import { CircleDot, FolderGit2, GitPullRequest } from "lucide-react";
import { definePlugin, githubRepos, type SessionContext } from "@gasho/plugin-sdk";
import { ItemPanel, ListPanel } from "./panels";
import { RepoCounts } from "./tile";

// セッションのフォルダーか、その中のリポジトリが GitHub にあり、daemon の部分を使えるときに出す
const onGitHub = (c: SessionContext) => c.daemon.ready && githubRepos(c.session).length > 0;

export default definePlugin({
  sessionHeader: [
    {
      id: "issues", label: "Issues", icon: CircleDot, title: "このリポジトリの Issue を開く",
      order: 300, when: onGitHub,
      panel: { id: "list", params: { kind: "issues" } },
      isOpen: (p) => p.params.kind === "issues",
    },
    {
      id: "pulls", label: "Pull requests", icon: GitPullRequest, title: "このリポジトリの Pull request を開く",
      order: 300, when: onGitHub,
      panel: { id: "list", params: { kind: "pulls" } },
      isOpen: (p) => p.params.kind === "pulls",
    },
  ],
  sessionPanels: { list: ListPanel, item: ItemPanel },
  homeTiles: [{ id: "repos", title: "GitHub", icon: FolderGit2, size: "small", after: "operations", component: RepoCounts }],
});
```

Gasho は、どの拡張点の部品も、プラグインごとに React の Error Boundary で囲んで描く。部品の中でエラーが起きたら、その場所に「<プラグインの名前> の表示でエラーが起きました」と「もう一度」を出し、Gasho のほかの部分はそのまま動かす。エラーは、プラグインの画面にも出す。`when` や `useBadge` がエラーになったときは、項目やバッジを出さず、同じくプラグインの画面に出す。部品の ID は、プラグインの中で拡張点ごとに重ならないものにし、Gasho は `<プラグインの ID>.<部品の ID>` で区別する。

### サイドバー（P1）

サイドバーのいちばん上の区切りは、ホーム、プラグインの項目、端末、プラグイン、設定の順に並べる。サイドバーの項目は、Gasho の項目もプラグインの項目も、押すとページに移る。右側のパネルは開かない。右側のパネルを開くのは、セッションのヘッダーの項目（P3）だけである。プラグインの項目どうしは、プラグインの画面の「入れたもの」と同じく、名前の順に並べる。項目は、名前、アイコン、開くページとその引数、バッジを持つ。

```tsx
sidebar: [{ id: "repos", label: "リポジトリ", icon: FolderGit2, page: { id: "repos" }, useBadge: useOpenPullCount }],
```

バッジは、ホームの未読の数と同じ形で出す数か短い文字で、React のフックとして呼ぶ関数（`useBadge`）が返す。フックにするのは、daemon の部分から読んだ結果やイベントを使って、数を出せるようにするためである。アイコンだけのサイドバーでは、ほかの項目と同じくアイコンだけを出す。いま開いているページの項目は、選んだ状態で出す。

### ページ（P2）

ページの URL は `#/p/<プラグインの ID>/<ページの ID>` で、引数はクエリにする（`#/p/github/repos?repo=4rtoflow%2FGasho`）。ページの部品は、引数を `params` で受け取る。

ページは、ホームや設定と同じく、メインの領域に出す。枠は SDK の `Page`（見出し、説明、右上のボタン）を使い、幅と余白をほかのページにそろえる。プラグインがまだ読み込まれていないあいだは「読み込み中…」を出す。プラグインが無効か、ないか、読み込めなかったときは、そのことと、プラグインの画面へのリンクを出す。

### セッションのヘッダー（P3）

項目は、セッション画面のヘッダーの2行目、いまの「Issues」や「ファイル」が並んでいる行に足し、同じくアイコンと文字のボタンにする。右上の、状態とヘッダーを隠すボタンのところには足さない。スマホではそこが画面上部のバーになり、幅が足りないためである。ヘッダーを隠しているあいだは、ほかの項目と同じく出さない。

並ぶ位置は、`order` の数で決める。Gasho の項目は、次の位置に置く。

| `order` | Gasho の項目 |
|---|---|
| 0 | 確認待ち |
| 100 | リポジトリ（「複数のリポジトリ…」） |
| 200 | ブランチ（「ブランチ…」） |
| 400 | ファイル |
| 800 | PR のリンク |
| 900 | 最終更新 |
| 1000 | 費用 |

プラグインの項目の既定は 500 にする。GitHub の Issues と Pull requests は 300 にして、いまと同じくブランチとファイルのあいだに出す。同じ数のものは、プラグインの順に、同じプラグインの中では書いた順に並べる。

項目を出すかは、`when` で決める。`when` は、そのセッション（`session`）と working server（`machine`）、このプラグインの daemon の部分をその working server で使えるか（`daemon.ready`）を受け取る。使えないときは、`daemon.reason` に理由が入る。daemon の部分を使う項目は、使えないときに出さないよう、プラグインが `when` で確かめる。

押したときにすることは、次のどれか1つにする。

- `panel`：このプラグインのパネルを開く（P4）
- `page`：このプラグインのページを開く（P2）
- `href`：GitHub のページなどを、新しいタブで開く。https の URL だけを受け付ける
- `onClick`：プラグインの処理を呼ぶ。終わるまで項目を押せなくし、失敗したときはヘッダーの下に理由を出す

`panel` の項目は、いまの Issues と同じく、そのパネルを開いているあいだ選んだ状態で出す。開いているかは `isOpen` で決める。`isOpen` がないときは、同じパネルで、項目に書いた引数がすべて同じなら開いているとみなす。GitHub の Issues は、一覧（`list`）でも、一覧から開いた1件（`item`）でも、`kind` が `issues` なら選んだ状態にする。

項目には、サイドバーと同じくバッジ（`useBadge`）を付けられる。

### セッションのパネル（P4）

パネルの URL は `#/s/<working server の ID>/<セッションの ID>/p/<プラグインの ID>/<パネルの ID>` で、引数はクエリにする（`…/p/github/item?kind=pulls&number=12&repo=app`）。

パネルの出し方は、ブランチグラフやファイルのパネルと同じにする。PC ではセッションの右に並べて、× か Esc で閉じる。スマホではセッションの代わりに出し、「セッションに戻る」で戻る。開くパネルは1つだけで、パネルを開いているときに別のパネルを開くと、ブラウザーの履歴を増やさずに入れ替える。閉じるボタンと「セッションに戻る」は Gasho が付ける。パネルの部品は、SDK の `Panel` に、見出し、副題、右上のボタン（再読み込み、GitHub で開くなど）と中身を渡す。

パネルの部品は、セッション（`session`）、working server（`machine`）、引数（`params`）を受け取る。パネルの中で別の表示に移るときは、SDK の `useNavigation` を使う。一覧から1件を開くときは `openPanel("item", { … })` で開き、1件から一覧に戻るときは `back(一覧)` で戻る。`back` は、その一覧から開いていたときはブラウザーの履歴で戻り、そうでないときは一覧に入れ替える。いまの Issues と Pull requests のパネルの動きと同じである。

セッションが見つからないときと、プラグインが無効か読み込めないときは、`Panel` の枠にそのことを出す。

### 設定（P5）

設定の項目は、`gasho-plugin.json` の `settings` に書く。Gasho は、これを見て、設定画面に入力欄を作る。

```json
"settings": {
  "refreshSeconds": {
    "type": "number", "scope": "browser", "default": 0, "min": 0, "max": 3600, "step": 10,
    "label": "パネルを開いているあいだ、読み込み直す間隔（秒）",
    "description": "0 のときは、開いたときと再読み込みを押したときだけ読む"
  }
}
```

| 項目 | 内容 |
|---|---|
| `type` | `boolean`（スイッチ）、`number`（数の入力。`min`、`max`、`step`）、`string`（1行の入力。`maxLength`）、`select`（`options` から1つ選ぶ） |
| `scope` | `browser` は、このブラウザーだけの設定で、会話の文字の大きさと同じく localStorage に覚える。`server` は、すべてのブラウザーで共通の設定で、Gasho サーバーに保存し、daemon の部分にも渡す |
| `label`、`description`、`default` | 入力欄の名前、説明、既定の値 |

設定画面では、いまの「会話の文字の大きさ」のあとに、入れて有効にしたプラグインごとの区切りを出す。区切りの見出しは、プラグインの名前にする。プラグインの画面の「設定」は、その区切りを開く。入力欄で表せない設定は、`definePlugin` の `settings` に部品を渡すと、入力欄の下に出る。値は、どちらからも SDK の `useSetting` で読み書きする。

`server` の値を変えると、Gasho サーバーは、`settings` に書いた型と範囲で確かめてから保存し、すべてのブラウザーと gasho-daemon に送る。変えたことは、操作のログに残す。

### ホームのタイル（P6）

タイルは、ID、見出し、アイコン、大きさ、置く場所、部品を持つ。大きさは、いまのタイルに合わせて次の4つから選ぶ。

| 大きさ | PC（4列） | スマホ（2列） | 同じ大きさのいまのタイル |
|---|---|---|---|
| `stat` | 1列 | 1列 | 作業中、確認待ち、待機中、送った指示 |
| `small` | 1列 | 2列 | トークン、GitHub、working server |
| `medium` | 2列 | 2列 | トークンの内訳、最近の操作 |
| `large` | 3列 | 2列 | セッション |

`tall: true` を付けると、PC では、通知のタイルと同じく2行分の高さにする。置く場所は、`after` に、そのあとに置くタイルの ID を書く。ID は、Gasho のタイルの ID か、`<プラグインの ID>.<タイルの ID>` である。書かないときは最後に置く。タイルは、ほかのタイルと同じくつまみで並べ替えられ、並びはブラウザーごとに覚える。覚えた並びにないタイルは、既定の並びで前にあるタイルのあとに入れる。これはいまのホームの決まりと同じである。

タイルの中身は、プラグインの部品が描く。枠には、SDK の `Tile`（見出しとアイコン）を使う。数とグラフを出す `StatCard` は、使うプラグインが出てきたら SDK に足す。

### 会話の末尾（P13）

部品は、セッション画面の会話の末尾に出す。最後の発言と送信中の発言の下、入力欄の上である（API 1.2）。部品は会話と一緒にスクロールする。利用者が会話のいちばん下を見ているあいだは、部品が出たり大きさが変わったりしても、入力欄の上に見えるようにスクロールする。部品が何も描かないあいだは、場所を取らない。エージェントが作業しているあいだの、作業の時間や動いているツールを出すのに使う。

```tsx
conversationEnd: [{ id: "spinner", when: (c) => c.machine.connected && c.session.status === "busy", component: Spinner }],
```

部品は、そのセッションと working server を `machine` と `session` で受け取る。`useSessionContext()` も使える。出すかどうかは、ヘッダーの項目と同じく `when` で決める。プラグインが複数あるときは `order`（既定は 500）の順に並べ、同じ数ならプラグインの順に並べる。

セッションが何をしているかは、SDK の `useSessionActivity(machine, sessionId)` で読む。返すのは、いまの作業を始めた時刻（`turnStartedAt`）と、動いているツール（`tool`）である。`tool` は、ツールの名前と、コマンドやファイルなどの要約を持つ。どちらも、gasho-daemon が中継する Claude Code のフック（UserPromptSubmit や PreToolUse など）と、読み込んだ会話から、Gasho の画面が計算する。

- 作業を始めた時刻は、利用者の最後の発言の時刻である。その発言の作業が終わったあとに、セッションが自分で作業を始めたとき（バックグラウンドで動かしたコマンドが終わったときなど）は、終わったあとで最初にツールを使った時刻にする
- 画面は、ページを開いたときに Gasho サーバーから新しいフックを200件受け取り、その後は300件まで覚える。どちらも、すべてのセッションを合わせた数である。そのため、作業が長いと、発言のフックが残っていないことがある。そのときは、会話に残った発言の時刻を使う。どちらからも分からないときは、`turnStartedAt` を返さない
- 同時に動いているツールは、名前と要約で区別する。いちばんあとに始めたものを返す
- 作業も確認待ちもしていないセッションでは、空のオブジェクトを返す

### 入力欄の下（P14）

部品は、セッション画面で、入力欄の下の行に出す。キーの案内（「↵ で送信」）と文字数（「0/20000」）が並ぶ行で、部品は文字数の左に並べる（API 1.4）。キーの案内は、幅が 640px 未満の画面とタッチ端末では隠れるが、部品は文字数と同じく、いつも出す。Gasho から入力できないセッション（`claude rc` が起動したもの）では、文字数のない行の右端に出す。行の高さは 1.5rem なので、部品はその中に収め、詳しい内容は SDK の `Popover` に出す。セッションの Context Window の使用率のような、セッションの様子を小さく出すのに使う。

```tsx
composerFooter: [{ id: "usage", when: (c) => c.session.context !== undefined, component: UsageRing }],
```

部品が受け取るものと、`when` と `order` の決まりは、会話の末尾（P13）と同じである。プラグインが複数あるときは、`order` の小さいものから左に並べる。部品がエラーを投げたときは、行が狭いので「もう一度」を出さず、部品を出さない。エラーは、プラグインの画面に出す。

Gasho から起動したセッションの `SessionInfo` には、Claude Code がステータスラインに渡す値が入る。入れるのは、プラグインの API 1.4 に対応した gasho-daemon である。

| フィールド | 中身 |
|---|---|
| `context` | Context Window。いま使っているトークン数（`used`）、大きさ（`size`）、使用率（`percent`、0〜100 の整数）と、Claude Code が知らせた時刻（`at`）。最初の返答の前はない |
| `limits` | Claude.ai のプランの使用量の上限。5時間の上限（`fiveHour`）と、すべてのモデルを合わせた週の上限（`sevenDay`）で、それぞれ使用率（`percent`）とリセットの時刻（`resetsAt`）を持つ。そのセッションの最後の返答の時点の値で、`at` はその時刻。最初の返答の前と、API キーで使っているセッションではない。5時間の上限は、プランによってない |

値は、Claude Code がステータスラインのコマンドに渡す JSON の `context_window` と `rate_limits` から、gasho-daemon が取る。gasho-daemon は、セッションを起動するとき（フォークを含む）、`--settings` で、ステータスラインのコマンドを gasho-daemon の中継のコマンド（`statusline-relay`）にする。中継のコマンドは、受け取った値を、hooks を受けているのと同じ 127.0.0.1 のポート（`/statusline`）に、hooks と同じ秘密の値を付けて送る。そして、利用者がそのフォルダーに設定していたステータスラインのコマンドを同じ JSON で実行し、その出力を返す。`--settings` は利用者とプロジェクトの設定より優先されるので、こうしないと、利用者のステータスラインが消える。`padding` と `refreshInterval` も引き継ぐ。値の変わらない報告では `at` を変えないので、`at` は、値が変わった返答の時刻になる。

`limits` は、Claude Code が API の返答のヘッダーから読む値で、モデルごとの週の上限（Fable など）は入らない。モデルごとの週の上限は、Claude Code の `/usage` が、Claude.ai の使用量のエンドポイントから読んでいる。プラグインで出すときは、daemon の部分で Claude Code を動かして読む（「プラグインが動かす Claude Code」）。

### worktree のタブ（P15）

タブは、セッション画面の上の、worktree のセッションが並ぶタブの行に足す（API 1.5）。セッションのタブと「＋」の後ろに、区切りの線を挟んで並べる。押すと、タブの下の、セッションを出している場所に、プラグインの画面を出す。セッションを開いているときも、セッションの無い worktree の画面でも、同じタブを出す。

```tsx
worktreeTabs: [{ id: "issue", useTabs: useIssueTab }],
worktreeViews: { issue: IssueView },
```

```tsx
// ブランチ名の番号の Issue（feat/17-… なら #17）を、タブにする。番号の無いブランチと GitHub にないリポジトリには出さない
function useIssueTab({ worktree, daemon }: WorktreeContext): WorktreeTab[] {
  const number = /^[a-z]+\/(\d+)-/.exec(worktree.branch ?? "")?.[1];
  if (!daemon.ready || !worktree.github || !number) return [];
  return [{ label: `#${number}`, icon: CircleDot, view: "issue", params: { number } }];
}
```

`worktreeTabs` の項目は、`useTabs` で、worktree ごとのタブの一覧を返す。`useTabs` は React のフックで、タブの行を描くたびに呼ぶ。返したタブだけを出し、空の一覧を返した worktree には、そのプラグインのタブを出さない。中で `useRequest` を使えば、daemon の部分から読んだ結果でタブの数や名前を変えられる。手で worktree に足した Issue を、1件ずつタブにするときに使う。

`useTabs` は、working server（`machine`）、worktree（`worktree`）、このプラグインの daemon の部分をその working server で使えるか（`daemon`）を受け取る。タブは、名前（`label`）、アイコン（`icon`）、ポインターを乗せたときの説明（`title`）、開く画面（`view`）とその引数（`params`）、バッジ（`badge`）を持つ。並ぶ位置は、項目の `order`（既定は500）の順で、同じ数ならプラグインの順、同じ項目の中では返した順にする。

押すと、`worktreeViews` の `view` の画面を出す。開いている画面と `view` が同じで、タブに書いた引数がすべて URL の引数と同じタブを、選んだ状態で出す。画面の URL は `#/w/<working server の ID>/<worktree のフォルダー>/p/<プラグインの ID>/<画面の ID>` で、引数はクエリにする（`#/w/mac/%2FUsers%2Fme%2Fapp/p/github-allmighty/issue?number=17`）。フォルダーは、`/` を含めて1つの区切りにする。URL は worktree ごとなので、同じ worktree のどのセッションのタブから開いても、同じ画面になる。

画面の部品は、working server（`machine`）、worktree（`worktree`）、引数（`params`）を受け取る。`worktree` は、サイドバーの worktree の一覧の1行と同じもので、次のものを持つ。

| 名前 | 中身 |
|---|---|
| `path` | worktree の最上位のフォルダー。リポジトリの外のフォルダーのセッションでは、そのフォルダー |
| `branch` | いまのブランチ。HEAD が detached のとき、リポジトリの外、worktree を調べない前の版の gasho-daemon では、ない |
| `repo` | リポジトリのフォルダー（main の worktree のフォルダーで、同じリポジトリの worktree はどれも同じ）。リポジトリの外では、ない |
| `github` | GitHub のリポジトリ。GitHub にないときは、ない |
| `sessions` | その worktree の Gasho のセッション。タブと同じ順 |

セッションが無くなってサイドバーに残した worktree では、`sessions` が空で、`branch` と `github` は、最後にセッションがあったときのものになる。

画面から daemon の部分のメソッドを呼ぶときは、セッションを指さなくてよい。GitHub の Issue や Pull request を読むだけなら、`worktree.github` と `worktree.branch` を引数で渡し、daemon の部分が `ctx.github.read` に `--repo` で渡す。worktree のフォルダーで git などを動かすときは、`worktree.sessions` のセッションを指して呼ぶ（daemon の部分の `ctx.session` になる）か、daemon の部分が `ctx.folders()` でフォルダーを確かめる。ブラウザーから来たパスを信用しないのは、ほかの呼び出しと同じである。

画面のあいだを移るときは、`useNavigation` の `openWorktreeView(画面, 引数)` を使う。セッションの中（ヘッダーの項目やパネル）から呼ぶと、そのセッションの worktree の画面を開く。ホームのタイルのように worktree の外からは、`at` に working server の ID と worktree のフォルダーを渡す。

プラグインがまだ読み込まれていないあいだは、画面の場所に「読み込み中…」を出す。無効か、ないか、読み込めなかったときと、`view` の画面がないときは、そのことを出す。`useTabs` がエラーになったときは、そのプラグインのタブを出さず、プラグインの画面にエラーを出す。

## 画面の部分から使えるもの

画面の部分は、Gasho の状態と操作を、SDK のフックと関数で使う。プラグインが SDK だけを使うようにするのは、Gasho の中を変えても、プラグインが壊れないようにするためである。

| 名前 | すること |
|---|---|
| `useMachines()` | working server とセッションの一覧。Gasho の画面と同じもので、読むだけ |
| `useSessionContext()` | ヘッダーの項目、パネル、会話の末尾の部品の中で、そのセッション、working server、daemon の部分を使えるか |
| `useDaemonReady(machine)` | その working server で、このプラグインの daemon の部分が動いているか。動いていないときは、その理由 |
| `useRequest(呼び出し, 指定)` | daemon の部分のメソッドを呼び、結果を覚えておく（P7） |
| `useCall()` | daemon の部分のメソッドを1回呼ぶ関数を返す。`write` のメソッドに使う。`summary` に書いたことは、操作のログに残る |
| `useEvent(topic, { machine })` | daemon の部分がその working server から送ったイベントの、最後のデータ。まだ届いていなければ `undefined`（P8、API 1.5） |
| `useSetting(key)` | 設定の値と、値を変える関数（P5） |
| `usePluginState(key, 初期値)` | ページを開いているあいだ Gasho が覚えておく値。ホットリロードで部品を作り直しても残り、ページを読み込み直すと消える |
| `useNavigation()` | このプラグインのページとパネルを開く・閉じる・戻る。ホームのタイルのようにセッションの外からは、セッションを指定してパネルを開く。`<a href>` に入れる URL も作る。`openSession(machine, sessionId)` と `sessionHref(…)` で、Gasho のセッションの画面に移る（API 1.1）。`openWorktreeView(画面, 引数, at)` と `worktreeHref(…)` で、worktree のタブの画面を開く（API 1.5、P15） |
| `useSendInput()` | セッションに発言を送る関数を返す。引数は `{ machine, sessionId, text }`。`permissions` に `session.input` が要る。入力欄から送ったときと同じく、会話の末尾にすぐ出し、操作のログに残す |
| `useLaunchSession()` | working server のフォルダーでセッションを起動する関数を返す（API 1.1）。引数は `{ machine, cwd, name, trust }`。`permissions` に `session.launch` が要る。「新しいセッション」と同じく起動し、操作のログに残す。Claude Code がフォルダーを信頼するかを聞いたときは起動せず、`needsTrust` を返す。利用者に確かめてから `trust: true` で呼び直す |
| `useSessionActivity(machine, sessionId)` | セッションがいまの作業を始めた時刻（`turnStartedAt`）と、動いているツール（`tool`）（API 1.2、P13） |
| `useNow(ミリ秒)` | 一定の間隔で変わる現在の時刻。「3分前」の表示を更新するために使う |
| `githubRepos(session)` | セッションのフォルダーか、その中のリポジトリのうち、GitHub にあるもの |
| `panelRepo(session, repo, fit)` | セッションのフォルダーの中のリポジトリのうち `fit` に合うものと、パネルで選んでいるもの（`repo`、なければ最初のもの） |
| `relativeTime(時刻, 現在)`、`cn(...)` | 「3分前」の文字列と、Gasho と同じクラス名のつなぎ方 |

部品は、次のものを使える。

| 名前 | 中身 |
|---|---|
| `Page`、`Panel` | ページとパネルの枠 |
| `PANEL_BUTTON` | パネルの見出しの右に置く小さいボタン（再読み込み、GitHub で開く）のクラス名 |
| `RepoTabs` | セッションのフォルダーの中のリポジトリを切り替えるタブ |
| `Tile` | ホームのタイルの枠 |
| `Markdown` | 会話と同じ Markdown の表示。HTML は出さず、画像は読み込まずにリンクにする |
| `RelativeTime` | 「3分前」の表示。ポインターを乗せると時刻を出す |
| `Popover` | ボタンから開く小さな画面（API 1.4）。開くボタン（`trigger`）、開く向き（`side`、`align`）、読み上げる名前（`label`）、クラス（`className`）を受け取る。開いているかをプラグインが持つときは、`open` と `onOpenChange` も渡す。Esc、外を押す、ボタンをもう一度押すと閉じる。モーダルにしないので、後ろの会話はスクロールできる。中身は、開いているあいだだけ描く |

型（`MachineInfo`、`SessionInfo`、`GitHubRepo` など）は、`@gasho/protocol` のものを SDK から使う。

## daemon の部分

プラグインに対応する gasho-daemon の版の番号は、公開するときに決める。Gasho サーバーは、版の番号ではなく、gasho-daemon が `plugin.status` を送ってくるかどうかで、プラグインに対応しているかを見分ける。

### 画面からの呼び出し（P7）

画面の部分は、daemon の部分のメソッドを、名前と引数（JSON）で呼ぶ。呼ぶときは、どの working server で動かすかと、どのセッションについての呼び出しかも指定する。セッションは指定しなくてもよい。GitHub のパネルが一覧を読むときは、次の順に進む。

```
   パネル          SDK        gasho-hub   gasho-daemon   子プロセス
      │             │             │             │             │
      │─────(1)────▶│             │             │             │
      │             │─────(2)────▶│             │             │
      │             │             │─────(3)────▶│             │
      │             │             │             │─────(4)────▶│
      │             │             │             │◀────(5)─────│
      │             │             │      (6) gh │             │
      │             │             │             │────────────▶│
      │             │             │             │◀────(7)─────│
      │             │             │◀────────────│             │
      │             │◀────────────│             │             │
      │◀────(8)─────│             │             │             │
      │             │             │             │             │
```

1. パネルが、`useRequest` で `list` を呼ぶ
2. SDK が、同じ呼び出しの結果を覚えていれば先に出し、Gasho サーバーに `plugin.request` を送る
3. Gasho サーバーが、呼び出しを確かめてから gasho-daemon に送る
4. gasho-daemon が、セッションの ID を、自分が見ているセッションのフォルダーに直し、プラグインの子プロセスに渡す
5. daemon の部分が、`ctx.github.read` で、gasho-daemon に `gh pr list` などを頼む
6. gasho-daemon が gh を実行し、出力を返す。同じ問い合わせの記録が新しければ、gh を実行せずに、記録した結果を返す（「GitHub を読む・変える」）
7. daemon の部分が、gh の出力から結果（JSON）を作って返す
8. 結果が同じ順に戻り、SDK が結果を覚えて、パネルを描き直す

3で Gasho サーバーが確かめるのは、次のことである。

- プラグインが入っていて、有効であること
- メソッドが `gasho-plugin.json` の `methods` にあること
- 引数が 64KB 以下であること
- working server がつながっていて、その gasho-daemon でこのプラグインの daemon の部分を使えること

結果は、Gasho サーバーと gasho-daemon のあいだの WebSocket の上限（16MB）に収まるようにする。大きくなりうるものは、いまの GitHub の本文とコメントと同じく、daemon の部分で切り詰める。`timeoutSeconds` を過ぎても答えがなければ、Gasho サーバーが「working server から応答がありません。」を返し、gasho-daemon は daemon の部分に中断を知らせる。gasho-daemon は、1つのプラグインの呼び出しを同時に8つまで動かし、それを超えた分は待たせる。

`useRequest` は、呼び出しの結果を、ページを開いているあいだ覚えておく。同じ working server、セッション、メソッド、引数の呼び出しは、1つの結果を共有する。ホームの GitHub のタイルとパネルが、同じ一覧を使えるようにするためである。読み込みに失敗したときは、前に読んだ結果を残したまま、エラーを添える。Gasho サーバーとの接続が切れたときは、つながり直したあとで、答えを待っていた呼び出しを送り直す。どれも、いまのブランチグラフや GitHub のパネルと同じ動きである。`staleSeconds` を指定すると、表示したときに結果がそれより古ければ読み直す。`refreshSeconds` を指定すると、表示していて、ページが画面に出ているあいだ、その間隔で読み直す。

`write` のメソッドを呼ぶと、操作のログ（ホームの「最近の操作」）に、端末、プラグイン、メソッドの名前と、画面の部分が添える要約（300文字まで）を残す。引数の中身は、Gasho サーバーには残さない。`read` の呼び出しは、ファイルを読むだけのときと同じく、ログに残さない。

### daemon の部分の書き方

daemon の部分は、メソッドをまとめたオブジェクトを、`defineDaemonPlugin` で書き出す。GitHub プラグインの一覧のメソッドは、次のようになる。

```ts
import { defineDaemonPlugin, PluginError } from "@gasho/plugin-sdk/daemon";
import { LIST_FIELDS, parseList } from "./gh";

export default defineDaemonPlugin({
  methods: {
    async list(params, ctx) {
      const { kind, repo } = params as { kind?: unknown; repo?: unknown };
      if (kind !== "issues" && kind !== "pulls") throw new PluginError("一覧の種類が正しくありません。");
      // セッションのフォルダーか、その中で gasho-daemon が見つけたリポジトリ（なければ PluginError）
      const where = ctx.session.repo(typeof repo === "string" ? repo : undefined);
      if (!where.github) throw new PluginError("このリポジトリは GitHub にありません。");
      const { stdout } = await ctx.github.read([
        kind === "issues" ? "issue" : "pr", "list",
        "--repo", `${where.github.owner}/${where.github.name}`,
        "--state", "open", "--limit", "51", "--json", LIST_FIELDS[kind],
      ], { timeoutMs: 20_000 });
      return parseList(stdout, where.github, kind);
    },
  },
});
```

メソッドは、引数と、呼び出しの文脈（`ctx`）を受け取る。

| 名前 | 中身 |
|---|---|
| `ctx.machine` | working server の ID と名前 |
| `ctx.session` | 呼び出しで指したセッション。gasho-daemon が見ているセッションだけで、ID、フォルダー、名前、GitHub のリポジトリ、フォルダーの中のリポジトリを持つ。`repo(パス)` は、セッションのフォルダー（パスを渡さないとき）か、gasho-daemon がその中で見つけたリポジトリのフォルダーを、その GitHub のリポジトリと一緒に返す |
| `ctx.settings` | Gasho サーバーに保存した設定の値（`scope: "server"`） |
| `ctx.folders()` | その working server で、Gasho がセッションを起動できるフォルダー（Claude Code が信頼しているフォルダーと、その親）。画面の `MachineInfo.folders` と同じもの。ブラウザーから来たパスで git などを動かす前に、この中にあるかを確かめるのに使う（API 1.1） |
| `ctx.dataDir` | その working server での、このプラグイン専用のフォルダー（`~/.local/share/gasho/plugin-data/<ID>/`）。呼び出しをまたいで覚えておくもの（選んだ項目など）を置く。プラグインを更新しても外しても残る（API 1.1）。この中で動く Claude Code は、gasho-daemon がセッションとして扱わない（「プラグインが動かす Claude Code」、API 1.4） |
| `ctx.signal` | 待つ時間を過ぎたときと、子プロセスを止めるときに、中断を知らせる AbortSignal |
| `ctx.exec(コマンド, 引数, 指定)` | コマンドを、シェルを通さず、制御端末なしで実行する。gh と git が入力を求めて止まらないよう、`GH_PROMPT_DISABLED=1` と `GIT_TERMINAL_PROMPT=0` を付け、待つ時間と出力の大きさに上限を付ける。待つ時間を過ぎたら、プロセスグループに SIGTERM を送る |
| `ctx.github` | working server の gh を、gasho-daemon に実行してもらう。`read(引数, 指定)` で読み、`write(引数, { repo })` で GitHub を変える。gh は `ctx.exec` ではなく、これで動かす（「GitHub を読む・変える」、API 1.3） |
| `ctx.emit(topic, data, 指定)` | 画面にイベントを送る。`start` からも送れる（P8、API 1.5） |
| `ctx.log(…)` | gasho-daemon のログに、プラグインの ID を付けて書く |

引数はブラウザーから来るので、daemon の部分が自分で確かめる。`PluginError` で投げたメッセージは、そのまま画面に出す。ほかのエラーは、画面には「処理に失敗しました」とだけ出し、中身は gasho-daemon のログに書く。

呼び出しがなくても続ける処理（ファイルの監視、一定の間隔の処理）は、`start(ctx)` で始め、`stop()` で止める。`start` は、子プロセスを起動したときに呼ぶ。`stop` は、プラグインを無効にしたとき、外したとき、ホットリロードで古い版を止めるとき、gasho-daemon が止まるときに呼ぶ。

### GitHub を読む・変える（API 1.3）

daemon の部分は、gh を `ctx.exec` で動かさず、`ctx.github` で gasho-daemon に頼む。GitHub の API は、1時間に使える量が決まっている（GraphQL は5000点）。プラグインが別々に gh で同じ Issue や Pull request を読むと、この量を早く使い切る。gasho-daemon がすべてのプラグインの gh をまとめて実行し、結果を記録しておけば、同じ問い合わせには gh を実行せずに答えられる。

```ts
// 読む：同じ引数で30秒以内に読んだ結果があれば、gh を実行せずにそれを返す
const { stdout } = await ctx.github.read(["pr", "list", "--repo", "4rtoflow/Gasho", "--state", "open", "--json", "number,title"]);
// 変える：kind が write のメソッドの中で。終わると、そのリポジトリの記録を消す
await ctx.github.write(["issue", "edit", "12", "--repo", "4rtoflow/Gasho", "--add-assignee", "@me"], { repo: "4rtoflow/Gasho" });
```

- 引数は gh の引数で、`gh` は付けない。gh は、gasho-daemon のフォルダーで、プラグインの環境変数なしで動くので、リポジトリは `--repo` で指す。出力と失敗は、`ctx.exec` と同じ形で返る（`stdout`、`stderr`、失敗したときの `code` と `killed`）
- `read` は、同じ引数の記録が `maxAgeSeconds`（既定は30秒、長くても600秒）より新しければ、gh を実行せずに、記録した結果を返す。同じ引数の `read` が gh の終わりを待っているあいだに来た `read` は、`timeoutMs` と `maxBuffer` も同じなら、その結果を一緒に受け取る。違えば、自分の上限で別に gh を実行する。`maxAgeSeconds: 0` では、記録を使わずに gh を実行する（「再読み込み」を押したときなど）。失敗した結果は記録しない
- 記録は、すべてのプラグインと、すべての画面からの呼び出しで共有する。引数が1つでも違えば、別の問い合わせとして gh を実行する。プラグインどうしで記録を使い合うには、同じ引数で読む
- `write` は、assign やコメントなど、GitHub を変える操作に使う。変えるリポジトリを `repo`（owner/name）に書く。gh が終わると、成功しても失敗しても、gasho-daemon はそのリポジトリの記録と、リポジトリの分からない記録を消す。そのあとの `read` は、gh を実行して読み直す。`write` のあいだに gh を実行していた `read` の結果も、記録しない
- `read` の記録がどのリポジトリのものかは、引数の `--repo`（`-R`）か、`gh api repos/<owner>/<name>/…` のパスで決める。ほかの形（`gh api graphql` など）では、`repo` に書く
- `write` は、`gasho-plugin.json` の `kind` が `write` のメソッドの中でだけ使える。ほかのメソッドと `start` から使うと、`PluginError` になる。GitHub を変えたことが、そのメソッドの呼び出しとして操作のログに残るようにするためである
- gasho-daemon は、gh を `GASHO_GH_BIN`（既定は `gh`）で実行し、gasho-daemon を動かしている人のログインを使う

### プラグインが動かす Claude Code（API 1.4）

daemon の部分は、Claude Code を `ctx.dataDir` の中で動かす。gasho-daemon は、このフォルダーの中で動いている Claude Code をセッションとして扱わず、Gasho のセッションの一覧に出さない。そのフックも無視する。Claude Code は、`-p` で動かしていても、動いているあいだは `claude agents --json` にふつうのセッションと同じ形で出る。gasho-daemon はこの一覧からセッションを見つけるので、ほかのフォルダーで動かすと、Gasho のセッションの一覧に出てしまう。

たとえば、Claude.ai のプランで決まっている、モデルごとの週の上限は、Agent SDK の制御リクエスト `get_usage` で読める。Claude Code を `-p --input-format stream-json --output-format stream-json` で動かし、`initialize` と `get_usage` を標準入力で渡す。発言は送らないので、モデルは呼ばない。`ctx.exec` は標準入力を渡せないので、`sh -c` の中で、決まった文字列をパイプで渡す。`get_usage` は試験中の制御リクエストで、返す形が変わるかもしれない。

### daemon の部分を動かす場所

daemon の部分は、プラグインごとの子プロセス（`node daemon.js`）で動かす。gasho-daemon とは、Node.js の IPC でやりとりする。子プロセスにするのは、2つの理由による。1つは、プラグインのエラーや重い処理で、gasho-daemon ごと止まらないようにするためである。gasho-daemon は、セッションの端末とのやりとりと hooks の受け取りを、止めずに続ける必要がある。もう1つは、ホットリロードで、新しい版のプロセスに入れ替えられるようにするためである。

子プロセスは、プラグインが有効で、その working server で動かすことになったときに起動する。落ちたときは、1秒から倍ずつ延ばして最大60秒待ってから起動し直す。10分間に5回落ちたら起動し直すのをやめ、プラグインの画面に「失敗」と出す。プラグインを更新するか、有効にし直すまで、その状態のままにする。子プロセスの出力は、gasho-daemon のログに書く。子プロセスは、セッションの端末とは違ってスコープの外に出さず、gasho-daemon のサービスの中で動かすので、gasho-daemon と一緒に止まる。

Gasho サーバーは、`daemon.js` を、gasho-daemon に WebSocket で渡す。working server ごとにプラグインを入れなくてよく、画面の部分と daemon の部分の版もずれない。GitHub プラグインを直したときも、gasho-daemon の新しい版を公開しなくてよい。gasho-daemon は、受け取ったファイルを `~/.cache/gasho/daemon-plugins/<ID>/<ハッシュ>/daemon.mjs` に置き、Gasho サーバーが知らせたハッシュと同じときだけ動かす。拡張子を `.mjs` にするのは、そばに package.json がなくても、Node.js が ES モジュールとして読むようにするためである。

daemon の部分をどの working server で動かすかは、プラグインを追加するときに選ぶ（P9）。「すべて」を選ぶと、あとから登録した working server でも動かす。「選んだものだけ」を選ぶと、選んだ working server でだけ動かす。既定は「すべて」で、あとからプラグインの画面で変えられる。変えたことは、操作のログに残す。gasho-daemon を `GASHO_PLUGINS=none` で動かすと、その working server では、どのプラグインの daemon の部分も動かさない。

プラグインに対応した gasho-daemon は、対応するプラグインの API の版を、Gasho サーバーに知らせる。古い gasho-daemon の working server では、daemon の部分を使えない。Gasho サーバーは、そこへの呼び出しに「この working server の gasho-daemon は古いため、プラグインを使えません。gasho-daemon を更新してください。」と返す。画面の部分には、`daemon.ready` が false で届く。

### イベント（P8、API 1.5）

daemon の部分は、`ctx.emit(topic, data)` で、画面にイベントを送れる。Gasho サーバーは、イベントをすべてのブラウザーに送る。画面の部分は、`useEvent(topic, { machine })` で、その working server から届いた最後のデータを読む。`retain: true` を付けたイベントは、Gasho サーバーが、プラグイン・working server・topic ごとに最後のものを覚えておき、あとからつないだブラウザーにも送る。長い処理の進み具合や、監視しているものの状態を、ブラウザーから一定の間隔で呼び出さなくても画面に出せるようにするためのものである。

```ts
// daemon の部分：監視しているものの状態。あとからつないだブラウザーにも届くように retain を付ける
ctx.emit("state", { running: 3 }, { retain: true });

// 画面の部分：その working server から届いた最後のデータ（まだ届いていなければ undefined）
const state = useEvent<{ running: number }>("state", { machine: machine.id });
```

- topic は、100文字までの文字列にする。制御文字は使えない。data は JSON にできる値にし、JSON にして 256KB までにする。どちらかが正しくないと、`ctx.emit` が `PluginError` を投げ、イベントは送らない
- 同じ topic のイベントは、gasho-daemon が Gasho サーバーに1秒に1回まで送る。1秒のあいだに続けて送ったものは、最後のものだけを、前のイベントから1秒たったときに送る。topic が違えば待たない
- `start` からも送れる。ホットリロードで新しい版に入れ替えるあいだは、新しい版のイベントだけを送り、入れ替わる古い版のイベントは送らない。プラグインが止まると、まだ送っていないイベントは捨てる
- Gasho サーバーは、そのプラグインが有効で、その working server で daemon の部分を動かすことになっているときだけ、イベントを受け取る
- Gasho サーバーは、`retain` のイベントを、プラグインと working server ごとに、新しいほうから32の topic まで覚える。覚えたイベントは、プラグインを無効にしたとき、外したとき、その working server で動かさなくなったとき、新しい版に入れ替わったときに消す。working server との接続が切れても消さない。新しい版の daemon の部分は、`start` で状態を送り直す
- 画面は、プラグイン・working server・topic ごとに、最後のイベントだけを覚える。Gasho サーバーにつなぎ直すと、Gasho サーバーが覚えている `retain` のイベントから始め直す。プラグインを無効にしたとき、外したとき、新しい版に入れ替わったときは、そのプラグインのイベントを忘れる
- イベントは、すべてのブラウザーに同じものを送る。開いているパネルごとに違うものや、1秒に何度も届けたいもの（コマンドの出力など）は、呼び出し（P7）で読む

## プラグインの画面（P9）

サイドバーの「プラグイン」（端末と設定のあいだ）を押すと、プラグインの画面（`#/plugins`）に移る。プラグインの画面は、ホームや設定と同じく、メインの領域いっぱいに出すページである。右側のパネルでは開かない。スマホでも、ほかのページと同じく画面全体に出す。プラグインの画面を開いているあいだは、サイドバーの「プラグイン」を選んだ状態で出す。

```
┌────────────────┬─────────────────────────────────────────────────────┐
│ Gasho          │ プラグイン                             [再読み込み] │
│                │ 4rtoflow/GashoPlugins の一覧（3分前に確認）         │
│ ホーム         │                                                     │
│ リポジトリ     │ 入れたもの                                          │
│ 端末           │ ┌─────────────────────────────────────────────────┐ │
│ プラグイン ◀   │ │ GitHub  1.2.0                  [設定]  [x] 有効 │ │
│ 設定           │ │ my-plugin  0.3.0               [更新]  [ ] 有効 │ │
│                │ └─────────────────────────────────────────────────┘ │
│ worktree    ＋ │ GashoPlugins にあるもの                             │
│ * main         │ ┌─────────────────────────────────────────────────┐ │
│   Gasho        │ │ plugin-b  0.1.0                          [追加] │ │
│ * feat/x       │ └─────────────────────────────────────────────────┘ │
│   Gasho        │                                                     │
└────────────────┴─────────────────────────────────────────────────────┘
```

上に、読んでいるリポジトリと、カタログを読んだ時刻を出し、その下に「入れたもの」と「GashoPlugins にあるもの」を並べる。それぞれの行は、次のようになる。

```
プラグイン                                                [再読み込み]
4rtoflow/GashoPlugins の一覧（3分前に確認）

入れたもの
┌────────────────────────────────────────────────────────────────────┐
│ GitHub  1.2.0                                     [設定]  [x] 有効 │
│ セッションのリポジトリの Issue と Pull request を読む              │
│ daemon の部分：すべての working server                             │
├────────────────────────────────────────────────────────────────────┤
│ my-plugin  0.3.0（0.4.0 に更新できる）            [更新]  [ ] 有効 │
│ daemon の部分：ubuntu だけ                                         │
└────────────────────────────────────────────────────────────────────┘

GashoPlugins にあるもの
┌────────────────────────────────────────────────────────────────────┐
│ plugin-b  0.1.0  plugin-b の説明                            [追加] │
│ plugin-c  0.2.0  この Gasho では使えない（API 1.6 が要る）         │
└────────────────────────────────────────────────────────────────────┘
```

「入れたもの」には、入れたプラグインを名前の順に並べ、プラグインごとに次のものを出す。

- 名前、版、説明、宣言している権限（「セッションに発言を送る」など）
- 状態（有効、無効、開発中、読み込めない、新しい版に問題がある）と、その理由
- daemon の部分があれば、動かす working server と、working server ごとの状態（動いている、動かさない、gasho-daemon が古い、失敗、オフライン）
- 操作：有効・無効の切り替え、「設定」（設定画面のそのプラグインの区切りを開く）、「更新」（カタログに新しい版があるとき）、daemon の部分を動かす working server の変更、「外す」

「GashoPlugins にあるもの」には、カタログにあって、まだ入れていないプラグインを出す。押すと、次の確認を出し、「追加して有効にする」で入れる。`api` の版にこの Gasho が対応していないプラグインは、理由を出して「追加」を押せなくする。

```
┌─ plugin-b を追加 ──────────────────────────────────┐
│ 0.1.0  plugin-b の説明                             │
│ 権限：セッションに発言を送る                       │
│                                                    │
│ daemon の部分を動かす working server               │
│   (x) すべて（あとから登録したものも）             │
│   ( ) 選んだものだけ  [x] ubuntu  [ ] mac          │
│                                                    │
│                   [やめる]  [追加して有効にする]   │
└────────────────────────────────────────────────────┘
```

「外す」は、確かめてから、プラグインのファイルと、Gasho サーバーに保存した設定を消す。配るために写しておいた版（`~/.cache/gasho/hub-plugins/<ID>/`）も消す。ブラウザーに覚えた設定（`scope: "browser"`）は、それぞれのブラウザーに残る。開発中のプラグイン（P12 でリンクしたもの）は、カタログから更新しない。外すと、リンクだけを消す。

サイドバーの「プラグイン」には、更新できるプラグインの数をバッジで出す。追加、更新、外す、有効・無効の切り替えは、操作のログに残す。どれも、ホットリロードで、開いている画面と gasho-daemon にすぐ反映する。

## カタログ（P10）

GashoPlugins のプラグインは、GitHub Actions がビルドして、GitHub のリリースに置く。Gasho サーバーは、そのリリースから、カタログとプラグインを gh で取ってくる。Gasho サーバーのマシンにある GashoPlugins の作業コピーから、ビルドした `dist/` を直接読む形も考えた。しかし、プラグインを使う前に作業コピーを最新にしてビルドしておく必要があるので採らなかった。

```
GashoPlugins（GitHub）
  github/  <ほかのプラグイン>/ ...
    │ main に push する
    ▼
GitHub Actions：版の上がったプラグインだけをビルドする
    ├─▶ リリース github-v1.2.0：github-1.2.0.tgz
    └─▶ リリース catalog      ：catalog.json（最新の版の一覧）
            │
            │ Gasho サーバーが gh で読む
            ▼
プラグインの画面：一覧を出す ─▶ 利用者が「追加」を押す
            │
            ▼
Gasho サーバー：tgz を取ってきてハッシュを確かめ、
               ~/.local/share/gasho/plugins/<ID>/ に展開する
            │
            ▼
ホットリロード：画面と gasho-daemon が読み込む
```

### GashoPlugins で公開する

GashoPlugins の GitHub Actions は、main に push されたとき、`gasho-plugin.json` の `version` のリリースがまだないプラグインをビルドする。ビルドした `dist/` の中身は、`<ID>-<版>.tgz` にまとめて、`<ID>-v<版>` のリリースに置く。そのあとで、`catalog` のリリースの `catalog.json` を作り直す。前の版のリリースは消さずに残す。

`catalog.json` には、プラグインごとの最新の版を並べる。

```json
{
  "repo": "4rtoflow/GashoPlugins",
  "updatedAt": "2026-11-14T09:00:00Z",
  "plugins": [
    {
      "id": "github",
      "name": "GitHub",
      "version": "1.2.0",
      "description": "セッションのリポジトリの、開いている Issue と Pull request を読む",
      "api": "1.0",
      "permissions": [],
      "daemon": true,
      "release": "github-v1.2.0",
      "file": "github-1.2.0.tgz",
      "sha256": "…",
      "size": 48213
    }
  ]
}
```

### Gasho サーバーが読む

Gasho サーバーは、`GASHO_PLUGIN_REPO`（既定は `4rtoflow/GashoPlugins`）のリポジトリから、`gh release download catalog --pattern catalog.json` でカタログを読む。gh は、Gasho サーバーのマシンでログインしておく。gh は `GASHO_GH_BIN` で変えられる（gasho-daemon と同じ）。カタログを読むのは、Gasho サーバーを起動したとき、プラグインの画面を開いたとき（前に読んでから10分たっていれば）、「再読み込み」を押したとき、6時間ごとである。読めなかったときは、前に読んだカタログを出し、理由を添える。読めなかったあとは、1分たっていれば、プラグインの画面を開いたときに読み直す。読んだカタログは、開いているすべての画面に送る。サイドバーの「プラグイン」のバッジは、これを見て数える。

カタログの項目のうち、形の正しくないもの（`id` や `version` の形、`sha256` が64桁の16進数でないものなど）は出さず、Gasho サーバーのログに書く。`release` と `file` は、`<ID>-v<版>` と `<ID>-<版>.tgz` でなければならない。gh に渡す名前を、GashoPlugins の GitHub Actions が作る形に限るためである。

プラグインを追加・更新するときは、Gasho サーバーが次の順に入れる。

1. カタログにある `<ID>-<版>.tgz` を、`gh release download` で取ってくる。2分たっても終わらなければやめる
2. ファイルの SHA-256 が、カタログの `sha256` と同じかを確かめる
3. 一時フォルダーに展開する。絶対パス、`..`、リンク、ふつうのファイルとフォルダーでないものを含むアーカイブは展開しない。展開したものは、合わせて 20MB までにする
4. 展開した `gasho-plugin.json` の ID と版が、カタログと同じかを確かめる
5. `~/.local/share/gasho/plugins/<ID>/` を、展開したものに入れ替える。入れ替えるまでは前の版を残すので、途中の状態のプラグインを読み込むことはない
6. ホットリロードと同じ手順で、画面と gasho-daemon に反映する

展開するのは、`~/.local/share/gasho/plugins/` の中の、名前が「.」で始まるフォルダーである。Gasho サーバーは、そうした名前をプラグインとして読まない。同じディスクの中なので、5の入れ替えはフォルダーの名前の変更で済む。追加のときは、ファイルを置く前に、有効にすることと daemon の部分を動かす working server を保存する。daemon の部分が、選んでいない working server で一度でも動き出さないようにするためである。どこかで失敗したときは、保存したものを消し、展開したものも消す。同じプラグインの追加・更新・外すは、1つずつ行う。

更新は自動ではしない。カタログの版が入れた版より新しいときに、プラグインの画面に「更新」を出し、利用者が押したときに入れ替える。

## ホットリロード（P11）

Gasho サーバーは、プラグインのフォルダーの中身から SHA-256 のハッシュを計算し、これをプラグインの版として扱う。ファイルが1つでも変わればハッシュが変わり、ブラウザーと gasho-daemon は、ハッシュが変わったプラグインを入れ替える。プラグインを作っているあいだに保存したときと、プラグインの画面で追加・更新したときは、次の順に入れ替わる。

```
  開発中：ソースを保存する            画面で「追加」「更新」を押す
      │                                   │
      ▼                                   ▼
  vite build --watch が               <ID>-<版>.tgz を取ってきて
  dist/ を書き直す                    展開する
      │                                   │
┌─────▼───── Gasho サーバー ──────────────▼───────────────────────────┐
│ 1. プラグインのフォルダーの変化に気づき、0.3 秒待ってまとめる       │
│ 2. gasho-plugin.json とファイルを確かめ、中身のハッシュを計算する   │
│ 3. 確かめた中身を、ハッシュごとの置き場にコピーする                 │
│ 4. ブラウザーと gasho-daemon に、新しいハッシュを知らせる           │
└─────────────────────────┬─────────────────────────────────┬─────────┘
                          │                                 │
┌─ ブラウザー（すべて） ──▼──────┐   ┌─ gasho-daemon ───────▼─────────┐
│ 1. 新しい web.css を読み込む   │   │ 1. 新しい daemon.js を受け取る │
│ 2. 新しい web.js を import()   │   │ 2. 子プロセスを起動して start  │
│ 3. 部品を入れ替えて描き直す    │   │ 3. 呼び出しを新しいほうへ送る  │
│ 4. 古い web.css を外す         │   │ 4. 古いほうを stop して止める  │
└────────────────────────────────┘   └────────────────────────────────┘

  新しい版を読み込めなかったときは、どちらも前の版のまま動かし、
  プラグインの画面に理由を出す
```

### Gasho サーバーですること

Gasho サーバーは、入れたプラグインを置くフォルダーを監視する。このフォルダーは `GASHO_PLUGINS_DIR` で決め、既定は `~/.local/share/gasho/plugins` である。ここには、カタログから入れたプラグインと、開発中のプラグインへのリンク（P12）が並ぶ。

```
~/.local/share/gasho/plugins/<ID>/    入れたプラグイン（開発中はリンク）
    │
    │ Gasho サーバーが監視し、変わったら確かめる
    ▼
~/.cache/gasho/hub-plugins/<ID>/<ハッシュ>/
    │ 確かめた中身を、版ごとにコピーしておく
    ├─▶ ブラウザーに web.js を配る（/plugins/<ID>/<ハッシュ>/web.js）
    └─▶ gasho-daemon に daemon.js を渡す（plugin.code）
```

ビルドは複数のファイルを続けて書くので、最後の変化から0.3秒待ってから、まとめて確かめる。`gasho-plugin.json` の項目と `api` の版、書いてあるファイルがあることを確かめ、よければ中身をハッシュごとの置き場（`~/.cache/gasho/hub-plugins/<ID>/<ハッシュ>/`）にコピーして、新しいハッシュをブラウザーと gasho-daemon に知らせる。

ファイルは、プラグインのフォルダーからではなく、この置き場から配る。ビルドの途中のファイルを配らず、確かめた中身だけを配るためである。すでに読み込んだ画面が、あとからその版の残りのファイル（分けて書き出したチャンク）を読めるように、版はプラグインごとに新しいほうから5つ残す。確かめて問題があったときは、前の版を配り続け、プラグインの画面に「新しい版に問題があります」と理由を出す。

`methods` と `settings` は、新しい版のものを使う。保存してある設定の値が、新しい `settings` の型や範囲に合わないときは、既定の値として扱う。保存してある値そのものは消さない。

### 画面ですること

開いている画面は、新しいハッシュを受け取ると、そのプラグインを次の順に入れ替える。

1. 新しい `web.css` を読み込む
2. 新しい `web.js` を `import()` で読み込み、`api` の版と `export default` を確かめる
3. そのプラグインの部品を、新しい版の部品に入れ替えて描き直す
4. 古い `web.css` を外す

1か2で失敗したときは、前の版を動かし続け、プラグインの画面に理由を出す。入れ替えのあいだも、Gasho のほかの部分と、ほかのプラグインはそのまま動く。

入れ替えると、そのプラグインの部品は作り直すので、部品が自分で持っていた値は消える。Gasho が持っている値は残る。

| 残るもの（Gasho が持っている） | 作り直すもの（プラグインが持っている） |
|---|---|
| 開いているページとパネル（URL と引数） | 部品（React のコンポーネント） |
| `useRequest` の結果と、答えを待っている呼び出し | 部品の中の `useState` の値 |
| 設定の値（`useSetting`） | モジュールの中の変数 |
| `usePluginState` の値 | |

新しい版に、開いているページやパネルの ID がなくなったときは、その枠に「このページはありません」と出す。読み込んだモジュールはページから消せないので、古い版のコードは、ページを閉じるまでメモリーに残る。何度も入れ替えたページは、ときどき読み込み直すとよい。

### gasho-daemon ですること

daemon の部分を動かしている gasho-daemon は、新しいハッシュを受け取ると、次の順に入れ替える。

1. 新しい `daemon.js` を、Gasho サーバーから受け取る
2. 新しい子プロセスを起動し、`start` を呼ぶ。10秒以内に動き始めなければ失敗とする
3. それからの呼び出しを、新しい子プロセスに送る。入れ替えのあいだに来た呼び出しは、新しい子プロセスが動き始めるまで待たせる
4. 古い子プロセスは、受けていた呼び出しが終わってから `stop` を呼んで止める。5秒たっても終わらなければ SIGTERM を送り、さらに5秒たてば SIGKILL を送る

2で失敗したときは、古い子プロセスを動かし続け、プラグインの画面に理由を出す。子プロセスが持っていた値は、入れ替えると消える。

### つなぎ直したとき、有効・無効を切り替えたとき

しばらく接続が切れていたブラウザー（スマホなど）や gasho-daemon は、つなぎ直したときにプラグインの一覧を受け取る。一覧のハッシュが、動かしている版と違うプラグインは、同じ手順で入れ替える。有効にする・無効にする・外すも、同じ仕組みで反映する。有効にしたときは読み込み、無効にしたときと外したときは、部品を外し、`web.css` を外し、子プロセスを止める。

### ホットリロードできるように書く

プラグインは、次のことを守って書く。守らないと、入れ替えたあとも古い版が動き続ける。

- モジュールのいちばん外側で、タイマー、イベントリスナー、DOM の書き換えを始めない。続けて動くものは、部品の中（`useEffect`）で始め、片付けも書く。部品を外せば止まるので、入れ替えたときに古い版が残らない
- 入れ替えたあとも残したい値は、URL の引数、`useRequest`、`useSetting`、`usePluginState` に置く
- daemon の部分は、`stop` で、開いたファイルや起動したプロセスを片付ける。新しい版の `start` は、古い版の `stop` が終わる前に呼ばれることがある

ホットリロードするのはプラグインだけである。gasho-web 自身を更新したときは、これまでどおりページを読み込み直す。

## 開発中のプラグインを入れる（P12）

プラグインを作っているあいだは、GashoPlugins の作業コピーでビルドした `dist/` を、Gasho サーバーのコマンドでリンクして入れる。

```bash
npm run hub:plugin -- add --link ~/repos/GashoPlugins/github/dist   # 最初に1回。コピーせずにリンクを置く
cd ~/repos/GashoPlugins && npm run dev -w github                    # gasho-plugin build --watch。保存するたびに dist/ を書き直す
npm run hub:plugin -- list
npm run hub:plugin -- remove github                                 # 外す（リンクのときはリンクだけを消す）
```

保存してビルドが終わると、開いている Gasho の画面と gasho-daemon が新しい版に入れ替わる。リンクしたプラグインは、プラグインの画面に「開発中」と出し、カタログからは更新しない。でき上がったら、`version` を上げて GashoPlugins の main に push する。リンクを外せば、プラグインの画面から、カタログの版を入れ直せる。

`add` に `--link` を付けないと、フォルダーの中身をコピーして入れる。カタログを使わずに入れるときに使う。どちらも、`gasho-plugin.json` の項目、`api` の版、書いてあるファイルがあることを確かめてから入れる。

## 画面での読み込み

画面は、Gasho サーバーにつないだときに受け取る最初の状態（`snapshot`）で、入れたプラグインの一覧を受け取る。一覧には、プラグインごとの状態と、設定の項目と値、ファイルの URL（`/plugins/<ID>/<ハッシュ>/web.js`）が入る。

画面は、有効なプラグインの `web.js` を `import()` で読み込み、`web.css` を読んでページに足す。Gasho の画面は、プラグインの読み込みを待たずに出し、プラグインの部品は、読み込めたものから出す。プラグインのページやパネルの URL を開いたときは、読み込みが終わるまで「読み込み中…」を出し、15秒たっても読み込めなければ、読み込めないことを出す。Vite の開発サーバー（`npm run web:dev`）は、`/ws` と `/api` と同じく、`/plugins` も Gasho サーバーに中継する。

`web.js` には、`react`、`react-dom`、`react/jsx-runtime`、`@gasho/plugin-sdk` を入れず、Gasho が持っているものを使う。React が1つのページに2つあるとフックが動かず、SDK のフックは Gasho の状態を読む必要があるからである。Gasho は、プラグインを読み込む前に、これらを1つのオブジェクトにまとめて `globalThis` に置く。SDK のビルドのコマンドは、プラグインのコードにあるこれらの import を、そのオブジェクトから読む小さなモジュールに置き換える。アイコンなど、ほかのパッケージは `web.js` の中に入れる。

Gasho の CSS（Tailwind CSS）には、Gasho のコードが使うクラスしか入っていない。そのため、プラグインは自分の CSS（`web.css`）を持つ。プラグインの CSS は SDK の `plugin.css` を読み込み、SDK のビルドのコマンドが、プラグインのコードから、Gasho と同じテーマで CSS を作る。テーマは、`bg-surface-raised` や `text-muted-foreground` などの色と、角の丸みである。ブラウザーの既定のスタイルを打ち消す部分（preflight）は、Gasho の CSS がすでに持っているので入れない。テーマは SDK の `theme.css` に置き、Gasho 自身の `index.css` もこのファイルを読み込んで、両方の色をそろえる。

プラグインの CSS は、そのプラグインの部品の中にだけ当てる。プラグインのクラスは、Gasho のクラスと同じ Tailwind CSS の層に入り、Gasho の CSS より後にあるので、そのまま足すと Gasho の要素にも当たる。たとえば、プラグインの `.flex` が、Gasho のヘッダーの `md:hidden` を上書きし、広い画面でもスマホ用のヘッダーが出る。ほかのプラグインの部品にも同じことが起きる。そこで画面は、`web.css` のスタイルの規則を、部品を包む要素（`data-gasho-plugin="<ID>"`）の中だけに当たるように書き換えてから足す。テーマの変数（`theme` の層）、`@property`、`@keyframes` は、ページ全体に当てる。

- 当たるのは、ページ、セッションのパネル、ホームのタイル、設定、会話の末尾、入力欄の下の部品、worktree のタブの画面と、SDK の `Popover` の中。セッションのヘッダー、サイドバーの項目、worktree のタブは Gasho が描くので、プラグインの CSS は当たらない
- 部品の外（`document.body` など）に要素を出すときは、`data-gasho-plugin="<ID>"` を付けた要素で包む。SDK の `Popover` は、中身をこの要素で包んでページの末尾に出すので、プラグインの CSS が当たる

次のときは、プラグインの画面にそのプラグインを「読み込めない」と理由つきで出し、Gasho のほかの部分はそのまま動かす。

- `web.js` を読み込めなかったとき
- 読み込むときにエラーになったとき
- `api` の版に Gasho が対応していないとき
- `export default` がプラグインでないとき

プラグインのファイルは、`/plugins/<ID>/<ハッシュ>/<ファイル>` で、登録したブラウザーにだけ配る。配るのは、その版の置き場にあるファイルだけである。URL にハッシュが入っているので、ブラウザーには長くキャッシュさせる。

## 通信

`packages/protocol` に、次のメッセージを足す。`machine` は、いまと同じく working server の ID である。追加・更新・外す・有効・無効・許可・設定は、いまの操作と同じく、requestId を付けて送り、`command.result` で結果を受け取る。

| 向き | 種類 | 中身 |
|---|---|---|
| ブラウザー → Gasho サーバー | `plugin.catalog.get` | カタログを読む（古ければ、Gasho サーバーが読み直す） |
| Gasho サーバー → ブラウザー | `plugin.catalog` | リポジトリ、読んだ時刻、カタログのプラグイン、読めなかったときの理由 |
| ブラウザー → Gasho サーバー | `plugin.install` | プラグインの ID、daemon の部分を動かす working server（すべてか、選んだもの） |
| ブラウザー → Gasho サーバー | `plugin.update`、`plugin.remove` | プラグインの ID |
| ブラウザー → Gasho サーバー | `plugin.enable` | プラグイン、有効にするか |
| ブラウザー → Gasho サーバー | `plugin.allow` | プラグイン、daemon の部分を動かす working server（すべてか、選んだもの） |
| ブラウザー → Gasho サーバー | `plugin.setting` | プラグイン、設定の名前、値（`scope: "server"` のもの） |
| ブラウザー → Gasho サーバー | `plugin.request` | requestId、プラグイン、working server、セッション（なくてもよい）、メソッド、引数、ログに残す要約（`write` のとき） |
| Gasho サーバー → ブラウザー | `plugin.response` | requestId、結果かエラー |
| Gasho サーバー → ブラウザー | `snapshot` の `plugins`、`plugins` | 入れたプラグインの一覧。状態、ハッシュ、ファイルの URL、設定の項目と値、working server ごとの daemon の部分の状態。一覧が変わるたびに送る |
| Gasho サーバー → ブラウザー | `plugin.event` | プラグイン、working server、topic、data |
| Gasho サーバー → ブラウザー | `snapshot` の `pluginEvents` | Gasho サーバーが覚えている `retain` のイベント |
| Gasho サーバー → gasho-daemon | `plugins` | 有効なプラグインの ID、`daemon.js` のハッシュ、設定の値、この working server で動かすか。つないだときと、変わったときに送る |
| Gasho サーバー → gasho-daemon | `plugin.request` | requestId、プラグイン、セッション、メソッド、引数、`write` のメソッドか（`ctx.github.write` を使えるか） |
| Gasho サーバー → gasho-daemon | `plugin.code` | `daemon.js` の中身。gasho-daemon が求めたときに送る |
| gasho-daemon → Gasho サーバー | `plugin.response` | requestId、結果かエラー |
| gasho-daemon → Gasho サーバー | `plugin.status` | 対応するプラグインの API の版と、プラグインごとの状態（動いている版のハッシュ、止まっている、動かさない、失敗） |
| gasho-daemon → Gasho サーバー | `plugin.code.get` | 持っていない `daemon.js` の ID とハッシュ |
| gasho-daemon → Gasho サーバー | `plugin.event` | プラグイン、topic、data、retain |

`useSendInput` の関数は、いまの `session.input` に、送ったプラグインの ID（`via`）を足して送る。Gasho サーバーは、操作のログの「(by <端末>)」に、プラグインの ID も添える。

## 安全

ブラウザーの中では、プラグインの画面の部分は、Gasho の画面と同じ権限で動く。画面からできることは、どれもプラグインからできる。セッションへの発言（「!」で始まるシェルのコマンドを含む）や、権限の確認への許可もできる。`permissions` の宣言は、そのプラグインが何をするつもりかをプラグインの画面で示し、SDK の関数をうっかり使うのを防ぐためのもので、悪意のあるコードを止めるものではない。プラグインを追加することが、そのコードを信頼するという判断になる。

プラグインは、サンドボックス（別の iframe の中で動かすこと）には入れない。iframe に入れると、プラグインのコードを Gasho の画面から切り離せる。そのかわり、プラグインは Gasho の部品とテーマを使えず、サイドバーやヘッダーの項目も、プラグインが描くのではなく、データとして渡して Gasho が描く形になる。プラグインは利用者が自分で GashoPlugins に置くコードなので、この案では iframe には入れず、次のように守る。

- 画面から追加できるのは、Gasho サーバーに設定したリポジトリ（`GASHO_PLUGIN_REPO`）のカタログにあるプラグインだけにする。リポジトリは、画面からは変えられない。登録した端末の1台（なくしたスマホなど）からでも、そのリポジトリにないコードは入れられない
- GashoPlugins に push できる人と、そのリリースを書き換えられる人は、Gasho のすべてのブラウザーと working server で動くコードを書ける。GashoPlugins の書き込みの権限は、Gasho のリポジトリと同じ人だけに与える
- GashoPlugins は公開のリポジトリなので、プラグインのソースとリリースは誰でも読める。プラグインには、秘密の値を書かない
- Gasho サーバーが `sha256` を確かめるのは、壊れたファイルや、カタログと食い違ったファイルを入れないためである。リリースを書き換えられる人が、カタログも一緒に書き換えたものは防げない
- アーカイブは、絶対パス、`..`、リンク、ふつうのファイルとフォルダーでないものを含むものを展開しない。展開したものの大きさにも上限を付ける
- Gasho サーバーは、GashoPlugins を gh のログインで読み、トークンを保存しない
- プラグインのファイルは、登録したブラウザーにだけ配る
- daemon の部分は、gasho-daemon と同じ OS のユーザーで動き、そのユーザーのファイルを読み書きし、コマンドを実行できる。daemon の部分は、選んだ working server でだけ動かす
- gasho-daemon は、daemon の部分に、自分が見ているセッションのフォルダーと、その中で見つけたリポジトリのフォルダーだけを渡す。引数はブラウザーから来るので、daemon の部分が確かめる
- 次のことは、端末とプラグインの ID とともに操作のログに残す。プラグインを追加・更新・外したこと、有効・無効にしたこと、daemon の部分を動かす working server を変えたこと、`scope: "server"` の設定を変えたこと、`write` のメソッドを呼んだこと、`useSendInput` で発言を送ったことである。`read` の呼び出しは残さない
- GitHub のコメントのように外から来た文は、SDK の `Markdown` で出す。会話と同じく、HTML は出さず、画像は読み込まない
- Gasho は、プラグインのための秘密の値（トークンなど）を保存しない。外のサービスにログインが要るプラグインは、gh と同じく、working server の CLI のログインを使う

## GitHub の機能をプラグインに移す

いまの GitHub の機能は、ほかのプラグインと同じく、GashoPlugins の `github/` に移す。Gasho 本体の `plugins/` に置き、はじめから入っているプラグインにする形も考えたが、プラグインの置き場が2つになるので採らなかった。

| いま | プラグインにしたあと |
|---|---|
| ヘッダーの「Issues」「Pull requests」（gasho-daemon 0.7.0 以上のとき） | GitHub プラグインのヘッダーの項目（`order` は 300）。セッションのフォルダーか、その中のリポジトリが GitHub にあり、daemon の部分を使えるときに出す |
| Issues と Pull requests のパネル（`views/github-list.tsx`、`views/github-item.tsx`） | GitHub プラグインのパネル `list` と `item` |
| ホームの GitHub のタイル（`views/home.tsx` の `GitHubCounts`） | GitHub プラグインのタイル `repos`（`small`、最近の操作のあと） |
| `github.list.get` と `github.item.get` の通信（protocol、hub、`lib/store.ts`） | `plugin.request` での `list` と `item` の呼び出しと、SDK の `useRequest` |
| gasho-daemon の `github.ts`（`gh issue list`、`gh pr list`、`gh issue view`、`gh pr view`） | GitHub プラグインの daemon の部分。Gasho サーバーから gasho-daemon に渡す |
| URL の `…/issues`、`…/pulls`、`…/issue/<番号>`、`…/pull/<番号>`（後ろにリポジトリ） | `…/p/github/list?kind=issues`、`…/p/github/item?kind=pulls&number=12`（リポジトリは `&repo=…`）。古い URL を開いたときは、新しい URL に置き換える |

セッションの GitHub のリポジトリを見つけること（`SessionInfo.github`、`repos[].github`）は、Gasho の本体に残す。ヘッダーのリポジトリのリンクと、ブランチの GitHub のリンクにも使うためである。トランスクリプトから読む PR のリンク（G4）、ブランチグラフ（G1、G3）、ファイルのパネルも、本体に残す。

移すことで、次の点が変わる。

- GitHub プラグインを追加するまで、Issues と Pull requests の項目とパネル、ホームの GitHub のタイルは出ない。Gasho を更新するときの手順に、GitHub プラグインを追加することを書く
- GitHub の項目とパネルを使うには、プラグインに対応した gasho-daemon が要る。古い gasho-daemon の working server では、いまの 0.7.0 より前と同じく、ヘッダーの項目を出さない。プラグインの画面には「gasho-daemon が古い」と出す。移行のあいだだけ、Gasho サーバーが GitHub プラグインの呼び出しを古い `github.list.get` と `github.item.get` に置き換えて送る形も考えた。しかし、古い通信を Gasho サーバーに残すことになるので採らなかった
- GitHub の処理は gasho-daemon から出ていくので、GitHub プラグインを直しても、gasho-daemon の新しい版を公開しなくてよい。直したものは、GashoPlugins に出してプラグインの画面で更新するか、開発中ならホットリロードで、画面と gasho-daemon に届く
- ホームのタイルの ID が `github` から `github.repos` に変わる。ブラウザーが覚えている並びの `github` は `github.repos` として読み、並べた位置を保つ
- そのほかの見た目と動きは変えない

次のものは、移したあとで、プラグインの拡張点を使って足せる。今回の移行には含めない。

- Issue と Pull request のパネルを開いているあいだ、一定の間隔で読み直す設定（P5）。仕様の H1〜H3 にある「60秒ごとに取得し、間隔は設定で変えられるようにする」にあたる
- Actions の実行の一覧（H3）と、仕様の画面の表にある「リポジトリ」の画面（P1、P2）
- Issue の内容を、そのセッションへの発言として Claude に渡すボタン（P3、`useSendInput`）

## 実装の順序

```
┌─ 段階1：動かす仕組みと GitHub ───┐     ┌─ 段階2：カタログから入れる ─┐
│ 画面    読み込み、ホットリロード │     │ GashoPlugins の公開（CI）   │
│         拡張点、プラグインの画面 │     │ catalog.json を読む         │
│ hub     一覧、監視、配る、中継   │ ──▶ │ 画面で追加・更新・外す      │
│ daemon  子プロセス、入れ替え     │     │ イベント（P8）              │
│ SDK     GitHub Packages に公開   │     │ ほかのプラグイン            │
│ GitHub  GashoPlugins に移す      │     │                             │
└──────────────────────────────────┘     └─────────────────────────────┘
```

1. 動かす仕組みと GitHub：Gasho サーバーのプラグインの一覧・監視・配布・中継、画面での読み込みとホットリロード、拡張点（P1〜P7）、gasho-daemon の子プロセスでの実行と入れ替え、P12 のコマンドを作る。プラグインの画面は、入れたものの一覧、有効・無効、daemon の部分を動かす working server の変更までを作る。SDK は GitHub Packages に公開する。GashoPlugins を作って GitHub を移し、P12 のコマンドで入れる。プラグインに対応した gasho-daemon を出す
2. カタログから入れる：GashoPlugins の GitHub Actions で、プラグインのリリースと `catalog.json` を作る。Gasho サーバーがカタログを読み、プラグインの画面で追加・更新・外すをできるようにする。P8（イベント）と、ほかのプラグインを作る

1では、カタログがなくても、コマンドで入れた GitHub プラグインで、拡張点とホットリロードを確かめられる。2で、GashoPlugins のプラグインを、画面から選んで入れられるようにする。

## 今回は扱わないこと

- Gasho サーバーで動く部分。ブラウザーを開いていなくても続ける処理（GitHub を一定の間隔で読んで変化を知らせるなど）、プラグインからの Web Push、GitHub の Webhook の受け取りに要る。要るプラグインが出てきたときに考える
- gasho-web 自身のホットリロード
- プラグインのための秘密の値の保存
- リリースの署名の確認、前の版に戻すこと、自動の更新
- GashoPlugins 以外のリポジトリからの追加、ほかの人に配るためのマーケットプレイス、信頼しないプラグインを iframe に入れて動かすこと
- ほかの拡張点。セッションのタブのメニュー、入力欄のボタン、会話の中のツールの表示、ホームの通知、コマンドの一覧（Command Menu）などが考えられる。要るプラグインが出てきたときに、API のマイナーを上げて足す
