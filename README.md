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
- `g` でコミットグラフ・変更ファイル・選択中のファイルの差分をまとめて表示
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
| `Ctrl-d` `Ctrl-u`   | 半ページ移動                           |
| `zo` `zc`           | フォルダを開く / 閉じる                |
| `zR` `zM` / `x` `c` | すべて開く / すべて閉じる              |
| `p` `/`             | 検索                                   |
| `o`                 | プレビュー（もう一度押すと閉じる）     |
| `O`                 | 既定のアプリで開く                     |
| `r`                 | 更新                                   |
| `g`                 | Git ビューを開く / 閉じる              |

プレビュー中は `j` `k` / `↑` `↓`（1行）、`Ctrl-d` `Ctrl-u`（半ページ）、ホイールでスクロールし、`o` か `q` で閉じる。

### Git

`g` で開き、もう一度 `g` で Explorer に戻る。上から、全ブランチのコミットグラフ（最新 500 件）、選択中のコミットの変更ファイル（追加・削除の行数）、一覧で選択中のファイルの差分を並べて表示する。マージコミットは first parent との差分を表示する。コミットされていない変更があるときは、HEAD からグレーの点線で伸びた `working` の行として先頭に表示し、HEAD との差分（未追跡ファイルを含む）を見られる。ペインがプロンプトの上に置かれたときや高さが足りないときは差分を並べず、変更ファイルで `Space` を押すとペイン全体に表示する。差分の長い行は折り返す。幅が狭いときはコミットの日時とブランチ名を省く。

| キー              | 動作                                                                           |
| ----------------- | ------------------------------------------------------------------------------ |
| `Tab`             | フォーカスをグラフ → 変更ファイル → 差分の順に移す                             |
| `j` `k` / `↑` `↓` | フォーカス中の欄で移動（差分ではスクロール）                                   |
| `Ctrl-d` `Ctrl-u` | 半ページ移動                                                                   |
| `Space`           | グラフでは変更ファイルへ、変更ファイル・差分では差分をペイン全体に広げる／戻す |
| `n` `p`           | 次 / 前のファイル                                                              |
| `J` `K`           | 次 / 前のコミット                                                              |
| `q`               | 広げた差分を戻す / Explorer に戻る                                             |
| `r`               | 更新                                                                           |

クリックでもコミット・ファイルを選択でき、差分の見出しをクリックすると差分を広げる。

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
src/highlight.ts     プレビューのシンタックスハイライト
src/gitlog.ts        git log・変更ファイル・差分の解析
src/git-view.ts      Git タブの行の書式
src/view.ts          行の書式
src/icons.ts         アイコンと色
types/index.d.ts     状態の型定義
```
