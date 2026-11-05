# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## コマンド

- テスト: `claude plugin test .`（`bun:test` ではなく `claude-code/testing` を使う）
- マニフェストと hooks の検証: `claude plugin validate .`
- 動作確認: `claude --plugin-dir .` で起動し、編集後は `/reload-plugins` で反映する
- 整形・lint: `npm run format` / `npm run format:check` / `npm run lint`（devDependencies は完全固定。初回は `npm install`）。編集時は `.claude/hooks/format.sh`、コミット時は husky + lint-staged が eslint --fix と prettier を自動で実行する

## 前提

- 実行環境は Claude Code のプラグインランタイム。import できる外部パッケージはホストが提供する `claude-code` と `claude-code/testing` だけで、npm の依存は開発用ツール（prettier・eslint）以外に足さない。
- `tsconfig.json` が継承する `.claude-plugin/types/` はホストが生成するもので、gitignore されている。

## コードスタイル（prettier で強制されない分）

- 相対 import に拡張子を付けない（`'../src/git'`）。型だけの import は `import type` で別の行に書く。
- 型は `type` で書く。`interface` は `declare module 'claude-code'` の拡張だけに使う。

## Git

- コミットは Conventional Commits の形式で、件名と本文を日本語で書く（例: `feat: 〜を追加`）。
- 作業は `develop/<slug>` ブランチで行い、main へは PR でマージする。main へ直接コミットしない。ブランチ名は `.claude/hooks/check-branch-name.sh`（PreToolUse hook）で強制し、main は GitHub のブランチ保護で PR 必須にしている。
