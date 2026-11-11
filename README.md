# Gasho

Mac と Ubuntu Server で動く Claude Code（Remote Control）のセッションと、その作業対象のリポジトリの Git・GitHub の状況を、1つのブラウザ画面で見るためのダッシュボード。

- 仕様の案：[docs/spec.md](docs/spec.md)
- 調査と検証の記録：[docs/research.md](docs/research.md)

## nakamaba/

`nakamaba/` には、Nakamaba で配信している「🙏 Gasho」のサイトがある。ダッシュボードとは別のもので、公開・更新は `nakamaba/` フォルダを指定して行う。

```bash
node <nakamaba スキルのフォルダ>/scripts/nakamaba.mjs publish nakamaba
```
