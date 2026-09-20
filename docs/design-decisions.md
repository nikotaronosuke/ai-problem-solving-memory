# 設計判断

[English](design-decisions.en.md) | 日本語

この文書は2026-09-20に、既存のコミット履歴をもとに後から整理したものです。各判断の時期は、リンクした証拠コミットの日付を参照してください。

## 2026-08-12 — FIX と Verification を別物にした

AI が「直した」と書くことと、実際にテストが通ることは別です。

そのため FIX Event だけでは VERIFIED に進めず、Verification を独立した entity にしました。失敗した Verification も証拠として残します。

**Evidence:** [independent verification evidence](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/c21020b0d49ddd6586a3242fdd6461c3e8807cda)

## 2026-08-14 — send-first ではなく enqueue-before-send にした

Memory Server が書き込みを受け付けられないときでも本作業を止めないため、client-side の durable queue を追加しました。

その後、server が保存した直後に response timeout が起きるケースまで考えると、send-first には「失敗後、queueへ保存する前にprocessが落ちる」loss window が残ると分かりました。

そこで順序を **sanitize → durable queue → send** に変更し、再送でも同じ `client_event_id` を使うようにしました。

**Evidence:** [durable client-side queue](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/98312cfa839c48b4c24310e11c6baab44db4e0e3) / [enqueue before send](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/73550ac0a5dd6f1c8cdea5786de5ae91ce4241c7)

## 2026-08-19 — current project を startup 時の情報から決めるのをやめた

実ホストで、session開始時に得た project location が、同じsession内でrepositoryを移動した後も古い場所を指し続けることを確認しました。

そのため current project は per-call の host context から解決する形へ変更しました。利用できる location が無い場合は古い値へfallbackせず、誤ったprojectへ書くより明示的に拒否する方を選んでいます。

**Evidence:** [resolve project from current call context](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/4817b8cd0eef5bc591e6c1fdcbff569563bd8415)

## 2026-08-24 — Claude 用 / Codex 用で Memory を分けなかった

Claude Code が開始した Problem を、実際の Codex host から**同じ `problem_id`**で継続できることを確認しました。

host ごとに別の Memory を作らず、同じ MCP core と1つの Problem state を共有する構成を維持しています。

**Evidence:** [Codex continues the same Problem](https://github.com/nikotaronosuke/ai-problem-solving-memory/commit/4c00d57a4082cb5abf8d74a35ae8d31f8cb22ca0)
