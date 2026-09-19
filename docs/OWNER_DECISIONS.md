# Owner Decision Log

AI Problem-Solving Memory は、AIに「何でも覚えさせる」ための汎用Memoryではありません。

このプロジェクトでは、複数のAIが同じ問題を引き継げるようにしつつ、**Memory自身が勝手に判断したり、成功を断定したり、ユーザーの本作業を止めたりしないこと**を重視して設計しています。

この文書では実装の全履歴ではなく、プロジェクトオーナーとして「何を正本にし、何をMemoryへ任せず、どの失敗を許容したか」が分かる判断だけをまとめます。

---

## 1. 会話ではなく「Problem」を共有単位にした

### 課題

AIを変えたり、翌日に別セッションで作業したりすると、会話履歴だけでは次の問題が起きます。

- どの症状に対して何を試したのかが埋もれる
- 失敗した方向を別のAIが繰り返す
- 「直った」という文章と、実際の検証結果が混ざる
- 別プロジェクトで似た問題が起きても、過去の経験を再利用しにくい

### 判断

保存の中心を transcript や chat message ではなく、**Problem identity** にしました。

同じ Problem の下に、

- Environment
- HYPOTHESIS
- ATTEMPT
- DEAD_END
- DISCOVERY
- FIX
- Verification

を積みます。

AIが変わっても、会話全文をコピーするのではなく、同じ `problem_id` の正規状態と証拠を引き継ぐ形です。

この考え方により、Claude Code が開始した Problem を Codex が同じ `problem_id` で継続する実利用まで確認しています。

**Evidence:** [Codex continues the same Problem](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/4c00d57a4082cb5abf8d74a35ae8d31f8cb22ca0)

---

## 2. 「AIがそう言った」ではなく、サーバー側のProblem状態を正本にした

### 課題

AI自身に

> 「今はこのProblemを作業中です」

と自己申告させるだけでは、古い情報・別projectの情報・誤った推測をそのまま採用する可能性があります。

ローカルbindingも同じで、前回正しかったからといって今も正しいとは限りません。

### 判断

**Problem identity と状態の権威はサーバー側**に置きました。

ローカルbindingは高速化のための hint として使っても、毎回server stateと照合します。

Projectも同様で、候補が複数あるときは自動で1つを選ばず、候補と理由を返します。
ユーザーまたはsemantic layerが選んだ後も、その選択が現在のsessionにまだ適用できるかを再確認します。

### Fail closed を選んだ例

実際のhost計測で、sessionが別repositoryへ移動してもstartup時のproject rootは古いまま残ることが分かりました。

そのため現在位置はstartup値ではなく、**各tool call時にhostが渡す現在location**を使います。
現在位置が確実に分からない場合、古いprojectへ自信満々に書くよりcallを拒否する方を選びました。

**Evidence:** [take current project location from the call](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/4817b8cd0eef5bc591e6c1fdcbff569563bd8415)

---

## 3. FIXとVerificationを別の記録にした

### 課題

「修正コードを書いた」と「その修正が本当に効いた」は別の事実です。

FIX Event自体を成功証拠にすると、

> AIが「直しました」と書いた  
> → VERIFIED扱い

という、避けたかった状態になります。

### 判断

**VerificationをEventとは独立したentity**にしました。

Verificationは、

- 実際に何かを確認した
- 成功 / 失敗の結果を持つ
- 何で確認したかを記録できる

という証拠です。

FIX Eventが存在しても、それだけではProblemをVERIFIEDへ進めません。
成功したVerificationが存在することを状態遷移側が機械的に確認します。

failed Verificationも削除しません。失敗した確認も次のAIが知るべき証拠だからです。

**Evidence:** [establish independent verification evidence](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/c21020b0d49ddd6586a3242fdd6461c3e8807cda)

---

## 4. 実行できないVerificationをremote AIに書かせない

### 課題

remote hostは、手元のterminalやtest runnerへ接地していない場合があります。

そのhostが

> tests passed

というVerificationを書けると、Memoryに「実行されていない検証」が正式な証拠として残ります。

### 判断

**hostが実行できない種類のVerificationは、remote edgeで明示的に拒否**します。

local / remoteでVerificationの門を変えて緩めるのではなく、
そのhostが本当に観測できる種類だけを記録可能にしました。

人間による確認は、実際にユーザー確認があった場合のみ別種のVerificationとして記録できます。

「remoteだから仕方ない」で証拠の定義を弱めない判断です。

**Evidence:** [refuse checks remote sessions cannot have run](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/f862b67ab2b6e131d0f495f82085347458dcce07)

---

## 5. Memory自身に「似た経験を使うべきか」を自動判断させなかった

### 課題

過去Memoryを自動で検索し続けると便利に見えますが、次の問題があります。

- いつ検索するかというsemantic judgementをMemory側へ隠してしまう
- 不要なprovider callや検索が増える
- 古いMemoryを現在の正解として過信しやすくなる
- 「検索した結果」と「その経験を採用すべき」という判断が混ざる

### 判断

`recall_similar_experience` は **AIが明示的に呼ぶtool** にしました。

Memoryは候補・過去のdead-end・Verification履歴などを返しますが、
「この過去解が今回も正しい」とは決めません。

同じProblem・同じrequestを繰り返す場合はdigestで重複検索を抑えますが、
それもcacheであってlockやauthorityにはしません。

自動trigger / oracleは現時点では実装していません。

**Evidence:** [add explicit recall tool](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/8e45544179448daf671538bf5f1e79a86049cdb3)

---

## 6. RetrievalのCoreを有料AI providerなしで成立させた

### 課題

類似Memory検索を最初からembeddingやLLM reranker必須にすると、

- credentialがないとMemory自体が使えない
- provider障害がCore障害になる
- 小さなローカルMemoryにも外部依存が必須になる
- 検索の正本とprovider由来の判断が混ざる

という問題があります。

### 判断

**Tier 0はdeterministicなlexical retrievalだけで成立**させました。

canonical Memoryから検索用artifactを決定的に生成し、全文検索で候補を出します。

意味検索や構造rerankはoptionalです。

providerが無い / 落ちている場合は、そのstageだけをtyped degradationとして無効にし、
canonical MemoryとTier 0検索は維持します。

厳密lexical queryで0件だった場合のみ、一度だけ条件を緩める設計も追加しました。
最初から曖昧検索へ倒すのではなく、「strictで何も無かった」という条件をgateにしています。

**Evidence:** [deterministic Tier 0 retrieval](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/c08824ead613b7b5d345f8d42de8c2dd87739ef9) / [relax lexical query only after zero results](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/7ba143a38702be7d9a21854215d6604a9588e385)

---

## 7. Memory Server障害で本作業を止めない

### 課題

Memoryは補助システムです。

Memory Serverが落ちたからといって、
ユーザーが本来やっていたコーディングや調査まで失敗させるのは役割が逆です。

一方で、単にerrorを握りつぶすと、重要なEventやVerificationを静かに失います。

### 判断

**本作業は続行し、Memory writeだけをdurable queueへ退避**する設計にしました。

queueをserver内部には置いていません。
serverが到達不能なときにrequestを受け取れないので、障害回避先として同じfailure domainへ置く意味がないからです。

client側で、

1. sanitize
2. queueへ永続化
3. 外部送信を試す

という順番にしています。

送信してからfailure時にqueueへ入れる方式は、failureとprocess終了が重なったときにEventを完全に失うwindowがあるため却下しました。

**Evidence:** [client-side durable queue](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/98312cfa839c48b4c24310e11c6baab44db4e0e3) / [enqueue before send](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/73550ac0a5dd6f1c8cdea5786de5ae91ce4241c7)

---

## 8. Retryの「少なくとも一回」と、Memory上の「一行だけ」を分けた

### 課題

network timeoutは、

> server側では保存済み  
> client側ではresponseを受け取れなかった

という状態を作れます。

このときretryで新しいIDを振ると、同じEventが2行になります。

### 判断

logical writeごとに `client_event_id` を一度だけ発行し、
queue / retryでも同じIDを使い続けます。

transportとしてはat-least-onceでも、
server側では同じ `client_event_id` のeffectを一度にします。

このため、retry queueが新しいIDを作ることは禁止しました。

「通信が一度」と「Memoryへの効果が一度」を同じ意味にしない判断です。

**Evidence:** [enqueue before send, keep one client_event_id](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/73550ac0a5dd6f1c8cdea5786de5ae91ce4241c7)

---

## 9. AIごとに別Memoryを作らない

### 課題

Claude用、Codex用、remote AI用とhost別Memoryを作ると、
同じProblemが複数の正本へ分裂します。

### 判断

**同じMemory core / 同じProblem identity / 同じtool contract** を複数hostから使います。

Claude Codeから開始したProblemをCodexが継続するときも、
別形式へexport/importするのではなく、同じserver stateへ接続します。

remote host向けにも第二のMemory contractを作らず、
同じMCP coreの上へ薄いtransport edgeを置く方針にしました。

hostによって能力差はありますが、
Problem truthまでhostごとに分岐させない判断です。

**Evidence:** [Codex continues the same Problem](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/4c00d57a4082cb5abf8d74a35ae8d31f8cb22ca0) / [serve one MCP core to remote hosts](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/33f23eabb389dde8fb2c12f9deb04b7c9431d2ed)

---

## 10. Problem ControlをAgent Runtimeへ膨らませなかった

このプロジェクトの目的は、

> AIを自動で起動し、仕事を割り振り、workflow全体を管理すること

ではありません。

Memoryが持つ責務は、

- Problem identity
- 状態
- typed evidence
- Verification
- retrieval material
- consistency

です。

「どのAIを次に動かすか」「どのtaskをclaimさせるか」「workflowをどう進めるか」は別の問題として扱います。

過去の設計検討でも、Claude → Codex handoffを自動化する場合に、
いきなりagent orchestratorまでMemoryへ取り込む案は避け、
まず**人間がhostを切り替えても同じProblemを継続できること**を基礎にしました。

これは機能不足ではなく、Problemの正本と実行runtimeを混ぜないための境界です。

---

## このプロジェクトで優先したもの

AI Problem-Solving Memoryでは、便利そうな自動化より次を優先しています。

- 会話ではなくProblemを正本にする
- modelの自己申告よりserver stateを優先する
- FIXとVerificationを混同しない
- 実行していない検証を証拠にしない
- Memoryに最終判断をさせすぎない
- providerがなくてもCoreが動く
- Memory障害で本作業を止めない
- retryしてもMemory上の効果は一度にする
- hostが変わってもProblem truthを分裂させない
- Problem ControlとAgent Runtimeを分ける

AIを使って実装していますが、
このリポジトリで重要なのはコード量ではなく、**どこまでをMemoryに任せ、どこから先を任せなかったか**です。
