# AI Problem-Solving Memory

複数のAIが**同じ「問題」を、状態と証拠ごと安全に引き継ぐ**ための Problem Control / Consistency Layer です。会話を保存する汎用AI Memoryではありません。

```text
Claude Code   問題を開始。仮説を試し、行き詰まり(DEAD_END)を記録
   ↓ 同じ problem_id
別のAI        同じ Problem をサーバー経由で正規に継続。
(例: Codex)   過去の似た経験を明示的に引き、DISCOVERY を記録
   ↓ 同じ problem_id
Claude Code   修正を実装し、実際に走らせたテストを Verification として記録
   ↓
VERIFIED      成功した Verification があるときだけ、この状態へ進める
```

この「同じ problem_id を引き継ぐ」流れは、Claude Code ↔ Codex と、Claude Code → Claude.ai(remote MCP)の組み合わせで、同じ Problem を継続できることをそれぞれ実環境で確認しています。AI同士が会話履歴を自動で共有したり、勝手に何でも覚えたりする仕組みではありません。**記録は明示的で、状態遷移はサーバーが守ります。**

## 何を解決するのか

AIと開発していると、こうなりがちです。

- 昨日のセッションで何を試して何がダメだったか、今日のAIは知らない
- 別プロジェクトで一度解決した問題に、別のAIがもう一度はまる
- 前のAIが「直りました」と言ったので直ったことにしていたが、検証は走っていなかった

このプロジェクトは「解決コードの保存」ではなく、**問題そのもの**を管理単位にします。どんな症状だったか・何を疑ったか・どの方向が行き止まりだったか・何を発見したか・何で解決を確認したか、を同じ Problem identity の下に typed な記録として積み、次のAI(または明日の同じAI)がそこから続けられるようにします。

過去のMemoryは現在の正解として盲信せず、現在の環境・バージョン・公式仕様を確認したうえで判断材料として使う、という前提で設計されています。

## 普通のAI Memoryとの違い

「昨日のAIが『直った』と言ったから直ったことにする」という運用をしません。それを気合いではなく仕組みで守ります。

- **Problem identity はサーバーが権威**: どの Problem に取り組んでいるかは、AIの自己申告ではなくサーバーの再検証で決まります。古いローカルbinding(stale binding)はヒント扱いで、毎回検証されます
- **状態機械**: Problem は INVESTIGATING → FIX_CANDIDATE → VERIFIED 等の遷移規則を持ち、**成功した Verification がない Problem は VERIFIED にできません**。モデルの成功宣言は Verification ではありません
- **typed Event / Verification**: 記録は自由文のメモではなく、HYPOTHESIS / ATTEMPT / DEAD_END / DISCOVERY / FIX などの型を持ちます。検証は Event と独立した記録です
- **楽観ロック**: 同じ Problem への並行更新は `expected_version` で守られ、静かな上書きは起きません(競合は 409)
- **冪等な追記**: `client_event_id` により、再送しても同じ記録は一度しか入りません

## 現在確認できている接続先

| Host | 経路 | 状態 |
| --- | --- | --- |
| **Claude Code** | local MCP plugin | 実利用・受け入れ済み |
| **Codex** | 同じ MCP core(同じ plugin) | 実 installed host で受け入れ済み。Claude Code が開始した Problem を同じ `problem_id` で継続できます |
| **Claude.ai** | remote MCP(Streamable HTTP + bearer) | 実ホストで受け入れ済み。remote からはテスト実行等に接地した Verification を記録できず、その種別は明示的に拒否されます(下記 limitations) |
| **ChatGPT** | remote MCP(互換設計) | full-write の受け入れは**未完了 / deferred**。対応済みとは主張しません |

local / remote の接続経路はいずれも同じ 9-tool contract を使い、第二のcontractやホスト別Memoryはありません。

## Quick Start(Claude Code で使う)

2つの部品が要ります: **① plugin(AI側)** と **② Memory service(サーバー側)** です。plugin を入れるだけでは動きません。

**① plugin をインストール**(checkout も build も不要):

```bash
claude plugin marketplace add nikotaronosuke/ai-problem-solving-memory
claude plugin install problem-solving-memory@ai-problem-solving-memory
```

**② Memory service を動かす**: この repository のサーバーを自分で動かします(常設のhostedサービスは提供していません)。ローカルでの起動・owner作成・credential発行は下の [Development](#development) と [docs/development.md](docs/development.md) にあります。

**③ plugin へ接続情報を渡す**:

- `MEMORY_API_TOKEN` — 発行した credential を環境変数で渡します。plugin は自分で credential を作りません。commit してはいけません
- `MEMORY_API_URL` — 未設定ならローカル既定(共通clientの設定契約に従います)

Memory が設定されていない場合、9 つの tool はすべて `MEMORY_NOT_CONFIGURED` を返して止まります。壊れた状態で先に進むことはありません。

## 9 MCP tools

| Tool               | 何をするか                                                   |
| ------------------ | ------------------------------------------------------------ |
| `current_problem`  | この session がどの Problem に取り組んでいるか、あるいは先に何を決める必要があるか |
| `continue_problem` | すでに開いている Problem の続きに入る                        |
| `resume_problem`   | 一時停止していた Problem を作業状態に戻す                    |
| `start_problem`    | まだ開いていない困りごとを新しい Problem として始める        |
| `recall_similar_experience` | いま取り組んでいる Problem について、過去の問題解決が何を知っているかを引く |
| `add_event` | 現在の Problem に HYPOTHESIS / ATTEMPT / DEAD_END / DISCOVERY / FIX / USER_CORRECTION を記録する |
| `add_verification` | 現在の Problem に、実際に行った検証と成否を記録する |
| `mark_fix_candidate` | 現在の INVESTIGATING Problem を、検証待ちの FIX_CANDIDATE へ進める |
| `close_problem` | 現在の Problem を成功Verification要件と楽観ロックを保ったまま結論または一時停止へ進める |

前の 4 つが Problem への入口で、残りは入ったあとに使います。`recall_similar_experience`
とcurrent-Problem actionでは、どの Project・どの Problem を対象にするかはhostのcall contextと
サーバー再検証から決まり、modelが指定することはできません。Event / Verification の
`client_event_id` は論理的な1回の追記につき一度だけ発行し、応答不明時の再試行では同じ値を使います。

`recall_similar_experience` は **AI が自分で呼ぶ tool** です。「似た経験がありそうだ」と判断して
自動で呼ぶ仕組みはありません。同じ Problem について同じ内容を二度引いたときは検索せず
その旨だけを返すので、繰り返し呼んでも Memory を無駄に読みません。

## Retrieval — 無料で成立する部分と、optional な部分

**Core(Tier 0)は有料のAI APIなしで成立します。**embedding や外部 provider は必須ではありません。

- **Tier 0(provider 不要・常時有効)**: canonical な Memory から検索用の RetrievalArtifact を決定的に生成し、全文検索(lexical)で別 Project の過去経験を候補化します。語彙が完全一致しない場合は、厳密検索がゼロ件のときに限り一度だけ条件を緩めて探します。別ドメイン・別語彙のプロジェクトの経験が候補になることを実運転で確認しています
- **Optional(provider を設定した場合のみ)**: 意味ベースの embedding 検索と構造再ランキングが候補取得に加わります。provider が無い・落ちている場合はその機能だけが型のついた degradation として無効になり、**canonical Memory と Tier 0 の検索は失われません**

各候補が返す判断材料(どちらのTierでも):

- 記録時の Environment と Verification 履歴、および再確認すべき4項目
- 過去の dead-end(記録された Event そのまま。再試行の禁止ではありません)
- 記録が裏づける成功方向(検証を経た派生材料。FIX Event を成功と断定しません)
- 矛盾する Memory との比較材料(どちらが正しいかは決めません)

検索の設計と、サーバーが**判断しないこと**は [`docs/retrieval.md`](docs/retrieval.md) にあります。

## 仕組み

### 保存基盤

- TypeScript / Node.js のサービス基盤
- PostgreSQL への migration 基盤(ローカル開発は Supabase CLI + Docker)
- owner 単位の所有境界。すべてのデータが owner scope を持ち、他 owner のデータへは到達できません
- Project / Environment / Problem の保存
- Event の append-only 記録(HYPOTHESIS / ATTEMPT / DEAD_END / DISCOVERY / FIX / USER_CORRECTION)
- Verification を Event とは独立した検証記録として保存
- owner scope を固定した Repository 境界と、全体を1本の流れとして通す統合テスト

### HTTP/JSON API

- Fastify によるローカル HTTP サーバー(既定で `127.0.0.1` のみ)
- `/health` と、owner が確立していることを要求する `/v1/*`
- Project / Environment / Problem の作成・取得・一覧・更新
- Event / Verification の append と Problem 単位一覧(`client_event_id` による再送の冪等性つき)
- Problem の状態遷移(専用 endpoint。`VERIFIED` には成功 Verification が必須)
- Problem 更新の楽観ロック(`expected_version` 必須。競合は 409 `VERSION_CONFLICT`)
- Relation による Problem 同士のリンク(project を跨げます。owner は跨げません)
- UsageLog による Memory 利用履歴 / ChangeLog による Problem 変更履歴(変更と同一 transaction で自動記録)
- Memory control(read / write / suppression / invalidate。4軸は互いに独立し、権限制御ではありません)
- Problem の close / review(結論・`fix_kind`・振り返りを1リクエスト1 transaction で記録)
- `GET /openapi.json` による OpenAPI 3.1 契約(runtime の route schema から生成。手書きの複製はありません)
- `POST /v1/problems/:problem_id/search` — 検索は HTTP からも使えます

API の意味論は [`docs/api-contract.md`](docs/api-contract.md) にあります。

### AI から Memory へ到達する経路

- Claude Code / Codex は同じ配布 plugin の local MCP で接続します。`packages/claude-code-adapter` が git remote から Project 同一性を導き、確信が持てないときは推測せず候補と理由を返します
- remote host 向けには、同じ MCP core の上に薄い Streamable HTTP entry point があります。認証は owner credential の bearer(Authorization header のみ)で、`source_ai` などの出所はモデルではなくサーバー側が固定します
- 具体的な provider(要約・embedding・再ランキング)の構成は composition edge にあります。credential がなければその機能だけが無効になり、記録と読み出しは今までどおり動きます
- artifact の自動保守。canonical な書き込み後の通知と、起動時および定期の照合で、検索用 rendering を作り直します

## Safety / consistency guarantees

- Memory 本文へ書き込む前の secret 検出。確定した credential は保存を拒否します
- 運用ログは閉じた値だけを出力し、Memory 本文を持ちません
- Memory Server 障害時に本作業を止めないための typed degradation と retry queue(冪等な再同期)
- remote host では、そのホストが実行できない種別の Verification(テスト実行等)を **記録せず明示的に拒否**します。検証の門はどのホストからも緩みません
- Problem の物理削除と、owner Memory の export

## Development

必要なもの:

- Node.js 22.12 以上
- npm
- Docker(ローカルの PostgreSQL をコンテナで動かすため)

```bash
npm install
```

`.env.example` を `.env` としてコピーします(Windows なら手動コピーでも構いません)。

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
npm run dev               # サーバーを起動(既定 127.0.0.1:3000)
```

`/v1` へのアクセスには credential が必要です。`MEMORY_OWNER_ID` を知っているだけではアクセスできません(owner id は credential ではありません)。発行はローカルコマンドで行い、token は発行時に一度だけ表示されます。サーバーは digest しか保存しないため、失った token は再発行するほかありません。

```bash
npm run credential:issue -- --label "local development"
```

動作確認:

```bash
curl http://127.0.0.1:3000/health
curl -H "Authorization: Bearer mem_<lookup>.<secret>" http://127.0.0.1:3000/v1/me
```

credential の失効は id を指定します(token を指定しないのは、shell history に残さないためです)。

```bash
npm run credential:revoke -- --credential-id <uuid>
```

使わないときは `npm run supabase:stop` で停止してください。

## 詳細ドキュメント

- [docs/development.md](docs/development.md) — コマンド一覧・構成・規約・credential
- [docs/api-contract.md](docs/api-contract.md) — HTTP API の意味論
- [docs/retrieval.md](docs/retrieval.md) — 検索の設計と、サーバーが判断しないこと

## Current limitations

誤解を避けるため、いま無いものを書いておきます。

- 「似た経験がありそう」と意味を判断して自動で検索する oracle / trigger はありません。`recall_similar_experience` は明示的に呼びます
- 意味・構造ベースの類似検索(embedding / 構造再ランキング)は optional 機能で、その正式な受け入れは完了していません。Core は Tier 0 の lexical 検索で成立します
- remote host(例: Claude.ai)からは、テスト実行など実行環境に接地した Verification を記録できません(該当種別は記録せず拒否されます。ユーザー確認としての Verification は、実際に人間による確認があった場合に限り記録できます)
- ChatGPT からの full-write remote 利用の受け入れは未完了 / deferred です
- 常設の hosted service は提供していません。Memory service は自分で動かします
