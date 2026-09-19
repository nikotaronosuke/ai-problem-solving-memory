# Owner Decision Log

日本語 | [English](OWNER_DECISIONS.en.md)

ここでは「Memory に何を任せないか」を決めた中で、実装や検証結果によって境界が固まった4件だけ残します。

## 1. FIX と Verification を別物にした

AI が「直した」と書くことと、実際にテストが通ることは別です。

そのため FIX Event だけでは VERIFIED に進めず、Verification を独立した entity にしました。失敗した Verification も消しません。

**Evidence:** [independent verification evidence](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/c21020b0d49ddd6586a3242fdd6461c3e8807cda)

## 2. current project を startup 時の情報から決めるのをやめた

実ホストで、startup 時に取った location がその後の call context とずれるケースを確認しました。

そこで current project は per-call の host context から解決し、曖昧なら fail closed。古い binding は authority ではなく hint として再検証する形へ変更しました。

**Evidence:** [resolve project from current call context](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/4817b8cd0eef5bc591e6c1fdcbff569563bd8415)

## 3. send-first ではなく enqueue-before-send にした

Memory server が event を保存した直後に response timeout が起きると、client からは「保存されたか分からない」状態になります。

send-first だと、その後 process が落ちた場合に記録を失う window が残ります。

そのため **sanitize → durable queue → send** の順にし、再送でも同じ `client_event_id` を使うようにしました。

**Evidence:** [durable retry queue](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/98312cfa839c48b4c24310e11c6baab44db4e0e3) / [enqueue before send](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/73550ac0a5dd6f1c8cdea5786de5ae91ce4241c7)

## 4. Claude 用 / Codex 用の別 Memory を作らなかった

Claude Code が始めた Problem を Codex が**同じ `problem_id`** で継続できることを実ホストで確認しました。

host ごとに Memory を分けず、1つの Problem state と同じ MCP core を共有する方針を維持しています。

**Evidence:** [Codex continues the same Problem](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/4c00d57a4082cb5abf8d74a35ae8d31f8cb22ca0)
