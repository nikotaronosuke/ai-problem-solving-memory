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

実装 Phase 1〜4 が完了しました。次は AI Adapter（Phase 5）です。

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
- Problem の close / review（結論・`fix_kind`・振り返りを1リクエスト1 transaction で記録。遷移規則と検証の要件は変わりません）
- リクエスト検証と、全エラー共通の JSON 形式
- `GET /openapi.json` による OpenAPI 3.1 契約（runtime の route schema から生成。手書きの複製はありません）

API の意味論は [`docs/api-contract.md`](docs/api-contract.md) にあります。

実装 Phase 3（機密除去・障害耐性）が完了しました。

- Memory 本文へ書き込む前の secret 検出。確定した credential は保存を拒否します
- 運用ログは閉じた値だけを出力し、Memory 本文を持ちません
- Memory Server 障害時に本作業を止めないための retry queue（interface と drain を提供し、scheduler は持ちません）
- Problem の物理削除と、owner Memory の export

実装 Phase 4（検索）が完了しました。別 Project の過去経験を、**技術名や文言が違っても問題構造の近さで**候補にできます。

- 元 Memory と、検索用に再生成可能な RetrievalArtifact の分離
- canonical Memory から artifact を生成する pipeline（要約・embedding・整合性つき書き込み）
- 全文検索と vector 検索のハイブリッド候補取得、rank fusion による統合
- 構造類似による再ランキング（最大5件へ。該当なしは0件で返します）
- suppression / freshness / confidence を反映する決定的な順位付け
- 各候補が返す判断材料:
  - 記録時の Environment と Verification 履歴、および再確認すべき4項目
  - 過去の dead-end（記録された Event そのまま。再試行の禁止ではありません）
  - 記録が裏づける成功方向（検証を経た派生材料。FIX Event を成功と断定しません）
  - 矛盾する Memory との比較材料（どちらが正しいかは決めません）
- 同一条件の短時間再検索を抑える cache（再ランキング結果のみ。判断材料は毎回読み直します）
- 検索が実際に提示した Memory の UsageLog 記録

検索の設計と、サーバーが**判断しないこと**は [`docs/retrieval.md`](docs/retrieval.md) にあります。

検索は現時点では内部 service であり、HTTP endpoint はまだ公開していません。embedding / 要約 / 再ランキングの具体的な provider も未接続です（いずれも交換可能な port として定義済み）。どちらも AI Adapter を作る次の段階で決めます。

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

`/v1` へのアクセスには credential が必要です。`MEMORY_OWNER_ID` を知っているだけではアクセスできません（owner id は credential ではありません）。発行はローカルコマンドで行い、token は発行時に一度だけ表示されます。サーバーは digest しか保存しないため、失った token は再発行するほかありません。

```bash
npm run credential:issue -- --label "local development"
```

動作確認:

```bash
curl http://127.0.0.1:3000/health
curl -H "Authorization: Bearer mem_..." http://127.0.0.1:3000/v1/me
```

credential の失効は id を指定します（token を指定しないのは、shell history に残さないためです）。

```bash
npm run credential:revoke -- --credential-id <uuid>
```

使わないときは `npm run supabase:stop` で停止してください。

コマンド一覧・構成・規約は [docs/development.md](docs/development.md) を参照してください。
