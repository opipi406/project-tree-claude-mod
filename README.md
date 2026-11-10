# project-tree

VSCode-style file explorer pane for Claude Code.

Claude Code のターミナル画面に、最寄りの git リポジトリを起点にしたファイルツリーを表示する mod。

## Features

- `tree` コマンド風の罫線表示
- git の状態を色と記号で表示（`M` `A` `U` `D` `R` `!`）
- ファイル名のあいまい検索（ツリーに重なるポップアップ）
- 右クリックでパスをコピー（フルパス / 相対パス）
- vim 風のキー操作
- 選択中のファイルをペイン内でプレビュー（拡張子に応じたシンタックスハイライト）
- 選択中のファイルを既定のアプリで開く
- ファイル編集後に自動で更新

## Requirements

- Claude Code（ターミナル版。2.1.318 で動作確認）
- macOS（既定のアプリで開く・Finder で表示に必要）

## Installation

```
/plugin install project-tree --marketplace opipi406/project-tree-claude-mod
```

シェルから入れる場合：

```bash
claude plugin install project-tree --marketplace opipi406/project-tree-claude-mod --scope user
```

`--scope` は `user`（既定）/ `project` / `local`。

### From a local clone

```bash
git clone https://github.com/opipi406/project-tree-claude-mod.git
claude plugin marketplace add ./project-tree-claude-mod
claude plugin install project-tree@project-tree-claude-mod
```

編集後は `/reload-plugins` で反映。

## Usage

```
/project-tree
```

コマンドで開くたびに、プレビュー・検索・選択・スクロール位置を初期状態に戻す（フォルダの開閉は保持）。

`autoOpen` を有効にすると、セッション開始時に自動で開く。

### Mouse

| 操作           | 動作                                                                              |
| -------------- | --------------------------------------------------------------------------------- |
| クリック       | フォルダの開閉 / ファイルの選択                                                   |
| ダブルクリック | ファイルをプロンプトに `@` で挿入                                                 |
| 右クリック     | メニュー（パスのコピー、`@` 挿入、プレビュー、既定のアプリで開く、Finder で表示） |
| ホイール       | スクロール                                                                        |

### Keyboard

ツリーをクリックしてフォーカスしてから使う。

| キー                | 動作                                   |
| ------------------- | -------------------------------------- |
| `j` `k` / `↑` `↓`   | 上下に移動                             |
| `h` / `←`           | フォルダを閉じる・親へ                 |
| `l` / `→`           | フォルダを開く・子へ                   |
| `Enter`             | フォルダの開閉 / ファイルを `@` で挿入 |
| `gg` `G`            | 先頭 / 末尾                            |
| `Ctrl-d` `Ctrl-u`   | 半ページ移動                           |
| `zo` `zc`           | フォルダを開く / 閉じる                |
| `zR` `zM` / `x` `c` | すべて開く / すべて閉じる              |
| `p` `/`             | 検索                                   |
| `o`                 | プレビュー（もう一度押すと閉じる）     |
| `O`                 | 既定のアプリで開く                     |
| `r`                 | 更新                                   |

プレビュー中は `j` `k` / `↑` `↓`（1行）、`Ctrl-d` `Ctrl-u`（半ページ）、`gg` `G`、ホイールでスクロールし、`o` か `q` で閉じる。

### Pane width

境界をドラッグ、または `Ctrl-x ←` / `Ctrl-x →`。最大幅はターミナル幅の45%（Claude Code 本体の制限）。

## Configuration

インストール時の設定画面で選ぶ。

| 項目       | 値                                                       | 既定    |
| ---------- | -------------------------------------------------------- | ------- |
| `icons`    | `basic`（文字のラベル） / `nerd`（Nerd Font のアイコン） | `basic` |
| `autoOpen` | `true` / `false`（セッション開始時にペインを開く）       | `false` |

## Limitations

- `Cmd+P` はグローバルなショートカットとして登録できない。ツリーにフォーカスがあれば `p` / `/` で検索できる。
- 検索ポップアップは `Esc` では閉じない（「閉じる」かツリーをクリック）。
- 読み込むファイルは20,000件まで。git 管理外のディレクトリは深さ4階層まで。

## Development

```bash
claude --plugin-dir .      # インストールせずに起動
claude plugin validate .   # マニフェストと hooks の検証
claude plugin test .       # テストの実行
```

```
hooks/register.tsx   エントリポイント（コマンド・ペイン・イベント）
src/tree-view.tsx    ツリーの描画と入力（ターミナル）
src/tree.ts          ファイル一覧 → ツリー
src/git.ts           git の走査と状態
src/fuzzy.ts         あいまい検索
src/view.ts          行の書式
src/icons.ts         アイコンと色
types/index.d.ts     状態の型定義
```
