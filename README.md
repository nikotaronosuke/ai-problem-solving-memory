# AI Problem-Solving Memory

AIと一緒に開発していると、別プロジェクトで以前解決した問題にもう一度つまずくことがあります。

このプロジェクトは、Claude Code・Codex・ChatGPT・Claude.ai など複数のAIや複数のプロジェクトをまたいで、**過去の問題解決経験を再利用するためのユーザー所有Memory**を作る試みです。

## Concept

単に「前回の解決コード」を保存するのではなく、

- どんな症状だったか
- 何を疑ったか
- どの方向では進まなかったか
- どの調査方向で原因へ近づいたか
- 何によって解決を確認したか

を経験として残します。

過去のMemoryは現在の正解として盲信せず、現在の環境・バージョン・公式仕様を確認したうえで判断材料として使います。

## Goal

新しいリポジトリではコードがゼロから始まっても、**開発者の問題解決経験までゼロに戻らない状態**を目指します。

特に、別プロジェクトで起きた構造的に似た問題を自動で思い出し、過去の成功方向とdead-endの両方を次の調査に活かすことを重視します。

## Current status

実装 Phase 1（保存基盤）が完了しました。

現時点で動作するもの:

- TypeScript / Node.js のサービス基盤
- PostgreSQL への migration 基盤（ローカル開発は Supabase CLI + Docker）
- owner 単位の所有境界。すべてのデータが owner scope を持ち、他 owner のデータへは到達できません
- Project / Environment / Problem の保存
- Event の append-only 記録（HYPOTHESIS / ATTEMPT / DEAD_END / DISCOVERY / FIX / USER_CORRECTION）
- Verification を Event とは独立した検証記録として保存
- owner scope を固定した Repository 境界
- 上記を1本の流れとして通す統合テスト

実装 Phase 2 に入り、HTTP/JSON API の土台ができました。

- Fastify によるローカル HTTP サーバー（既定で `127.0.0.1` のみ）
- `/health` と、owner が確立していることを要求する `/v1/*`
- Project の作成・取得・一覧・更新、Environment の作成・取得・一覧
- Problem の作成・取得・一覧・部分更新
- Event の append と Problem 単位一覧（`client_event_id` による再送の冪等性つき）
- Verification の append と Problem 単位一覧（同じく冪等）
- Problem の状態遷移（専用 endpoint。`VERIFIED` には成功 Verification が必須）
- Problem 更新の楽観ロック（`expected_version` 必須。競合は 409 `VERSION_CONFLICT`）
- Relation による Problem 同士のリンク（project を跨げます。owner は跨げません）
- UsageLog による Memory 利用履歴（どの AI が何をどう使ったか。read の副作用では記録しません）
- ChangeLog による Problem 変更履歴（変更と同一 transaction で自動記録。自由記述の値は複製しません）
- Memory control（read / write / suppression / invalidate。4軸は互いに独立し、権限制御ではありません）
- リクエスト検証と、全エラー共通の JSON 形式

AI 連携はまだこれからです。

詳細な内部仕様は現時点では非公開です。

## Development

必要なもの:

- Node.js 22.12 以上
- npm
- Docker（ローカルの PostgreSQL をコンテナで動かすため）

```bash
npm install
```

`.env.example` を `.env` としてコピーします（Windows なら手動コピーでも構いません）。

```bash
cp .env.example .env
```

ローカルスタックを起動し、接続情報を確認します。

```bash
npm run supabase:start
npm run db:status
```

`db:status` が表示する DB URL を `.env` の `DATABASE_URL` に設定し、`MEMORY_OWNER_ID` には自分用の UUID を設定します。

```bash
npm run db:reset          # migration をクリーンな DB へ適用
npm run owner:bootstrap   # MEMORY_OWNER_ID の owner を作成
npm run check             # typecheck + lint + format + test
npm run dev               # サーバーを起動（既定 127.0.0.1:3000）
```

動作確認:

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/v1/me
```

使わないときは `npm run supabase:stop` で停止してください。

コマンド一覧・構成・規約は [docs/development.md](docs/development.md) を参照してください。
