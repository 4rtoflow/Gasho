# 🙏 Gasho

手を合わせるためだけの静的サイト。ビルドは無く、置いたファイルをそのまま Nakamaba で配信する。

## 構成

| ファイル | 役割 |
| --- | --- |
| `index.html` | ページ本体 |
| `css/style.css` | 見た目（白黒・ノイズ・各セクション） |
| `js/main.js` | 読み込みの順番と、毎フレームの制御 |
| `js/particles.js` | three.js のパーティクルと後処理（光のにじみ・残像・ノイズ） |
| `js/shapes.js` | 粒が集まる形（円相・合掌・🙏・銀河） |
| `js/ui.js` | ローダー・カーソル・スクロールに合わせた動き |
| `js/ritual.js` | 長押しで合掌する部分と、回数の記録（ブラウザの localStorage） |
| `js/audio.js` | 音（りんと、長押し中の低い音）。初期状態は OFF |
| `thumbnail.png` | Nakamaba のトップに出るカードの画像（16:10） |

three.js と Lenis（なめらかなスクロール）は jsDelivr から版を固定して読み込む。

## 下見

Nakamaba スキルの `nakamaba.mjs` で、公開後と同じ `/gasho/` の形で手元に開く。

```bash
node <nakamaba スキルのフォルダ>/scripts/nakamaba.mjs preview . --name gasho
```
