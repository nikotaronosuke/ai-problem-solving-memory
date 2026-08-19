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

## What works today

### 保存基盤

- TypeScript / Node.js のサービス基盤
- PostgreSQL への migration 基盤（ローカル開発は Supabase CLI + Docker）
- owner 単位の所有境界。すべてのデータが owner scope を持ち、他 owner のデータへは到達できません
- Project / Environment / Problem の保存
- Event の append-only 記録（HYPOTHESIS / ATTEMPT / DEAD_END / DISCOVERY / FIX / USER_CORRECTION）
- Verification を Event とは独立した検証記録として保存
- owner scope を固定した Repository 境界
- 上記を1本の流れとして通す統合テスト

### HTTP/JSON API

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

### 機密除去・障害耐性

- Memory 本文へ書き込む前の secret 検出。確定した credential は保存を拒否します
- 運用ログは閉じた値だけを出力し、Memory 本文を持ちません
- Memory Server 障害時に本作業を止めないための retry queue（interface と drain を提供し、scheduler は持ちません）
- Problem の物理削除と、owner Memory の export

### 検索

別 Project の過去経験を、**技術名や文言が違っても問題構造の近さで**候補にできます。

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

### AI から Memory へ到達する経路

- 具体的な provider（要約・embedding・再ランキング）の構成が composition edge に存在します。credential がなければその機能だけが無効になり、記録と読み出しは今までどおり動きます
- artifact の自動保守。canonical な書き込み後の通知と、起動時および定期の照合で、検索用の rendering を作り直します
- `POST /v1/problems/:problem_id/search`。検索は HTTP から使えます
- provider に到達できないときは、型のついた degradation として返します（検索が落ちるのではなく、使えたチャネルだけで答えます）
- 共通 Memory API クライアントの `search(problemId, request)`

- `packages/claude-code-adapter` の Project 自動判定。git remote から Project 同一性を導き、確信が持てないときは推測せず候補と理由を返します

まだないもの: 検索を AI が自分で呼ぶ判断の自動化・Event の自動記録。

## Claude Code へのインストール

Claude Code plugin として配布しています。checkout も build も不要です。

```bash
claude plugin marketplace add nikotaronosuke/ai-problem-solving-memory
claude plugin install problem-solving-memory@ai-problem-solving-memory
```

インストール後、main session で次の 5 つが使えます。

| Tool               | 何をするか                                                   |
| ------------------ | ------------------------------------------------------------ |
| `current_problem`  | この session がどの Problem に取り組んでいるか、あるいは先に何を決める必要があるか |
| `continue_problem` | すでに開いている Problem の続きに入る                        |
| `resume_problem`   | 一時停止していた Problem を作業状態に戻す                    |
| `start_problem`    | まだ開いていない困りごとを新しい Problem として始める        |
| `recall_similar_experience` | いま取り組んでいる Problem について、過去の問題解決が何を知っているかを引く |

前の 4 つが Problem への入口で、最後の 1 つは入ったあとに使うものです。どの Project・どの
Problem を対象にするかは host の call context から決まり、model が指定することはできません。
model が渡すのは、いま何が起きていると理解しているかを自分の言葉で書いたものだけです。

`recall_similar_experience` は **AI が自分で呼ぶ tool** です。「似た経験がありそうだ」と判断して
呼び出す仕組み自体はまだありません。今は明示的に依頼したときに呼ばれます。同じ Problem に
ついて同じ内容を二度引いたときは検索せずその旨だけを返すので、繰り返し呼んでも Memory を
無駄に読みません。

必要なもの:

- 到達可能な Memory service（この repository の server。ローカルでもリモートでも構いません）
- `MEMORY_API_TOKEN` を環境変数として渡すこと。plugin は自分で credential を作りません
- `MEMORY_API_URL` は共通 client の設定契約に従います（未設定ならその既定）

token は環境から渡すだけにしてください。commit してはいけません。credential の発行と失効は
`docs/development.md` の Credentials を参照してください。

Memory が設定されていない場合、5 つの tool はすべて `MEMORY_NOT_CONFIGURED` を返して止まります。
壊れた状態で先に進むことはありません。

現時点の plugin が持っているのは、Problem の入口と継続、そして明示的な過去経験の引き出しです。
検索を AI が自分で呼ぶ判断の自動化と、Event の自動記録はまだありません。

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
curl -H "Authorization: Bearer mem_<lookup>.<secret>" http://127.0.0.1:3000/v1/me
```

credential の失効は id を指定します（token を指定しないのは、shell history に残さないためです）。

```bash
npm run credential:revoke -- --credential-id <uuid>
```

使わないときは `npm run supabase:stop` で停止してください。

コマンド一覧・構成・規約は [docs/development.md](docs/development.md) を参照してください。
