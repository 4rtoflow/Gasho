# iPhone で使う

Gasho の画面を、iPhone のホーム画面に追加した Web アプリとして使う。ブラウザの枠（アドレスバーやツールバー）が消えるので、画面を広く使える。この文書では、そのための用意と、これから作るものをまとめる。

## 方針

- iPhone 用のネイティブのアプリは作らない。いまの画面を、ホーム画面の Web アプリとして使う
- HTTPS は Tailscale Serve で用意する。ホーム画面の Web アプリで通知（Web Push）を受け取るには、HTTPS のページである必要がある。Tailscale なら、家の外からも同じ URL で使える
- 通知は Web Push で送る（まだ作っていない）

ネイティブのアプリ（画面を Swift で作るもの、または WKWebView でこの画面を表示する殻）を採らなかった理由は次のとおり。

- 自分の iPhone に入れるだけなら無料でもできるが、署名が7日で切れ、通知（APNs）も使えない。通知を使うには Apple Developer Program（年99米ドル）が要る
- 画面を Swift で作り直すと、web と2つを保守することになる
- ネイティブでしかできないのは、ロック画面の通知から直接「許可」「拒否」を押すことや、Live Activity くらいである。いまは、通知からアプリを開いて答えれば足りる。足りなくなったら、Developer Program に入って、WKWebView の殻に APNs の通知を足すことを考える

## 用意する

### Gasho サーバー

1. Tailscale を入れて、ログインする
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```
2. Tailscale の管理画面の DNS のページで、MagicDNS がオンになっているのを確かめ、HTTPS Certificates の「Enable HTTPS」を押す。マシン名と tailnet の名前は、証明書の公開ログ（Certificate Transparency）に載る。名前を変えるなら、この前に変える
3. Tailscale Serve で、Gasho サーバーの前に HTTPS の入り口を作る
   ```bash
   sudo tailscale serve --bg 7740
   ```
   `https://<マシン名>.<tailnet>.ts.net/` が Gasho の URL になる。`--bg` を付けると、再起動のあとも続く。設定は `tailscale serve status` で見られ、やめるときは `sudo tailscale serve reset` を実行する。証明書の取得と更新は Tailscale がする

### iPhone

1. Tailscale のアプリを入れ、同じアカウントでログインして、VPN をオンにする。オンのままにしておけば、再起動のあともつながる。ふだんはオフにしておきたいときは、アプリの設定の「VPN On Demand」で、`*.ts.net` を開いたときにつなぐようにもできる
2. Safari で Gasho の URL を開き、共有から「ホーム画面に追加」を選ぶ
3. ホーム画面のアイコンから開いて、登録コードを入れる。ホーム画面の Web アプリと Safari では Cookie が分かれていることがあるので、アプリの中で登録する

manifest やアイコンを変えたときは、ホーム画面から消して追加し直さないと反映されない。消すと登録も消えることがあるので、そのときは登録し直す。

### Tailscale Serve と Gasho サーバー

- Serve は、tailnet の端末から HTTPS で受けた通信を `http://127.0.0.1:7740` に渡す。Host をそのまま渡し、`X-Forwarded-Proto: https` を付けるので、同じオリジンかの確認と、Cookie の Secure はそのまま働く。WebSocket も通る
- Gasho サーバーからは、Serve を通る接続はどれも 127.0.0.1 から来たように見える。接続元を tailnet の端末に絞るのは、Serve の役目になる。登録コードの入力ミスの制限は、Serve を通る端末全体で1つになる
- そのため、`GASHO_ALLOW_NETS` は既定のままでよい。`tailscale` を加えると、HTTPS を通らない入り口（`http://100.x.y.z:7740`）も開く
- LAN の `http://<IP>:7740` も、これまでどおり使える。ただし、ホーム画面の Web アプリと通知は、HTTPS の URL でしか使えない

## 作るもの

### 1. ホーム画面向けの手直し

済んだもの：

- manifest（`display: standalone`）とアイコン（`apps/web/public/`）。アイコンは、Noto Emoji の 🙏 を画面の背景の色の上に置いた PNG（180・192・512 ピクセル）
- 画面に戻ったときと、ネットワークが戻ったときは、再接続の待ち時間（最大15秒）を待たずに、すぐつなぎ直す（`apps/web/src/lib/store.ts`）。iPhone は裏に回った Web アプリを止めるので、戻ったときには接続が切れていることが多い
- Gasho サーバーは、Vite がハッシュを付けて `assets/` に書き出すファイルだけを長くキャッシュさせ、ほかのファイル（index.html、manifest、アイコン、ライセンス）は毎回確かめさせる。名前の変わらないファイルを変えたときに、端末に古いものが残らないようにするためである
- スマホのセッション画面では、セッション名と状態を画面上部のバーに出し、セッションのヘッダーには出さない。ヘッダーを閉じたときの1行（約37px）がなくなり、会話がバーのすぐ下から始まる（`apps/web/src/App.tsx`、`apps/web/src/views/session.tsx`）

これから：

- スマホでパネル（ファイル、ブランチグラフ、Issue など）を開いたときは、まだ2段（画面上部のバーと、パネルの見出し）になっている。パネルの見出しの「セッションに戻る」と題名をバーに移せば、1段にできる
- 画面のいちばん上（時計の並ぶところ）まで背景を伸ばす（`apple-mobile-web-app-status-bar-style` と `env(safe-area-inset-top)`）。広さは変わらず、見た目だけが変わる

### 2. 通知（Web Push）

- web：Service Worker を足す。`push` で通知を出し、`notificationclick` でそのセッションを開くだけにして、ファイルはキャッシュしない（反映した版がすぐに出るように）。設定の画面に「この端末に通知する」と、通知の種類（完了・確認待ち・入力待ち・エラー）ごとの切り替えを置く。iOS では、通知の許可はボタンを押したときにしか求められない
- hub：VAPID の鍵と、端末ごとの購読の保存を足し、通知を作るところ（`apps/hub/src/hub.ts` で `notificationFor` を呼ぶところ）で送る。404・410 が返った購読は消す。Service Worker のファイルはキャッシュさせない
- 通知は Apple の push service（`web.push.apple.com`）を経由するので、Gasho サーバーから外へつながる必要がある。iPhone の Tailscale がオフでも通知は届くが、タップして開くには Tailscale が要る
- アイコンのバッジに、確認待ちのセッションの数を出す（Badging API）
- 決めること：ロック画面に出す文（会話の中身を出すか、セッションの名前と通知の種類だけにするか）、画面を開いている端末にも送るか、VAPID の `sub`（push service に伝える連絡先）に何を入れるか

### 3. 接続の見張り

- 画面に戻ったとき、実際には切れているのに、切れたことが分からない接続は、いまは見分けられない。Web Push で hub に手を入れるときに、ping と pong のメッセージを足し、応答がなければつなぎ直す

## 確かめたこと（2026年11月14日）

- Tailscale 1.104.7 の Serve で、`https://<マシン名>.<tailnet>.ts.net/` の Gasho を開けた。証明書は Let's Encrypt が出したもので、ISRG Root X1 につながる。同じオリジンかの確認、WebSocket（wss）、登録していない接続の切断（4401）は、Serve を通しても働いた
- iPhone は Tailscale で（中継なしで）直接つながり、この URL で登録して使えた
