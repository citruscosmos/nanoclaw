# NanoClaw フォーク設計概要

> NanoClaw v2 をベースに 6 つのアーキテクチャ変更を加えるフォークの全体設計。
> 各フェーズの詳細設計は個別ドキュメントを参照。

---

## 全体フェーズ構成

| フェーズ | 対象項目 | 目的 | 状態 |
|---|---|---|---|
| フェーズ1 | ① ③ | グループ単位設定 + Pi provider 追加 | 詳細設計済み |
| フェーズ2 | ② | Hermes メモリアーキテクチャ取り込み | 概要のみ |
| フェーズ3 | ④ ⑤ ⑥ | AMCP 組み込み | 概要のみ |

---

## フェーズ1: ① + ③（詳細設計）

### ① プロセス・フレーム：グループ単位でアクセス・ランナー・ツールを独立設定

**現状:** SDK 組み込みツールが全グループ共通 hardcode。runner は Claude のみ。

**変更:**
- **ランナー**: `container_configs.provider` = `claude` | `pi`。Pi Coding Agent を新 provider として追加。
  → 詳細: `docs/cc/DESIGN-phase1-pi-provider.md`
- **ツール**: `container_configs.tools_config` JSON 列を追加。`{ allowed: string[] }` で per-group の明示的 allowlist。
  → 詳細: `docs/cc/DESIGN-phase1-group-config.md`
- **アクセス**: `user_roles` / `agent_group_members` は変更なし（すでに per-group）。
- **引継ぎ**: なし（グループごとに独立設定）。

**Tool の統一概念:**
MCP ツール・SDK 組み込みツール・Pi ネイティブツール・サブエージェントツールをすべて `tools_config.allowed` の **Tool 名** で統一管理する。

```
Tool
├── SDK 組み込み: Bash, Read, Write, Task, ...       (Claude グループ)
├── MCP ツール: mcp__nanoclaw__*, mcp__<server>__*   (Claude / 将来 Pi)
├── Pi ネイティブ: bash, read, write, ...            (Pi グループ)
└── サブエージェント: Task / code_subagent / research_subagent
```

### ③ 能力：subagent・MCP をツール化

**実現方法:** allowlist に含めるだけで「ツールとして使える」状態になる。特別なフレームワークは不要。

| 要素 | Claude グループ | Pi グループ |
|---|---|---|
| MCP ツール | `mcp__nanoclaw__*` を allowlist に追加 | NanoClaw MCP ツールを AgentTool でラップ (§4) |
| サブエージェント | `Task`, `TaskOutput`, `TaskStop` を allowlist に追加 | `code_subagent`, `research_subagent` を allowlist に追加 (§5) |

### フェーズ1 ドキュメント索引

| ドキュメント | カバー範囲 |
|---|---|
| `DESIGN-phase1-pi-provider.md` | Pi runner 追加 (①ランナー、③Pi MCP/subagent 実装) |
| `DESIGN-phase1-group-config.md` | ツール allowlist 設計 (①ツール、③統一 Tool 概念) |

---

## フェーズ2: ② Hermes メモリアーキテクチャ（概要）

### 目的

現在の NanoClaw はセッション内の会話を `inbound.db` / `outbound.db` に保存するが、**セッションをまたぐ記憶がない**。Hermes Agent の設計を参考に、グループ単位の永続メモリ層を追加する。

参照: [Hermes Agent](https://github.com/nousresearch/hermes-agent)

### 主要コンポーネント（概要）

```
per-group memory.db (新規 3 本目 DB)
├── 短期: 会話要約 (直近セッション N 件の LLM 要約)
├── 長期: FTS5 全文検索インデックス付き記憶
└── ユーザーモデル: per-user プロファイル (Honcho dialectic)
```

**セッションライフサイクル:**
1. セッション開始時: `memory.db` から関連記憶を FTS5 検索し、システムプロンプトに注入
2. セッション中: `CLAUDE.local.md` への書き込み（現行）を継続
3. セッション終了時: LLM がセッション要約を生成し `memory.db` に書き込む

**writer/reader 分離:**
- `memory.db` の writer はエージェントランナーのみ（"exactly one writer per file" 不変条件を維持）
- host は `memory.db` を read しない（session DB との責務分離）

### 実装ポイント（フェーズ2 で詳細化）

- スキーマ: `memory_entries(id, content, summary, embedding?, created_at, session_id)`
- FTS5 仮想テーブル: `memory_fts(content)` — 高速キーワード検索
- セッション終了トリガー: `outbound.db` の `session_state` に `ended` が書かれたタイミング
- 記憶の鮮度管理: `created_at` + TTL or 容量上限（古い記憶の自動削除）

---

## フェーズ3: ④ ⑤ ⑥ AMCP 組み込み（概要）

### 前提: AMCP とは

AMCP (AI-Mediated Component Protocol) は MCP を拡張したエージェント間インターフェース。
参照: `amcp-whitepaper.md`, `amcp/docs/DESIGN.md`

**コアコンセプト:**
- **Actor**: エージェントグループが 1 つの Actor
- **IEDI レコード**: Intent / Evidence / Delta / Insight の 4 フィールドで全インタラクションを記録
- **5 フェーズ**: Discovery → Trust Verification → Agreement → Cooperative Execution → Recording & Closure

### ④ ライフサイクル：AMCP イベント駆動（概要）

**現状:** host は outbound.db をポーリングし、SIGTERM でコンテナを kill する。

**変更方向:**
- AMCP の `record_start` / `record_close` をコンテナライフサイクルイベントと紐付け
- `record_start` → セッション開始のトリガーになり得る
- `record_close` → セッション終了記録に IEDI を添付

実装ポイント: Pi の `beforeToolCall` / `afterToolCall` フック（`DESIGN-phase1-pi-provider.md` §6）が AMCP mediator の差し込み点。フェーズ1 でフックの空実装を確保することがフェーズ3 の前提。

### ⑤ コミュニケーション：グループ間は AMCP（概要）

**現状:** グループ間の直接通信なし。全メッセージはユーザー経由。

**変更方向:**
- 各エージェントグループが AMCP Actor として機能
- グループ間 AMCP メッセージは **必ず host 経由でルーティング**（P2P なし）
- host に AMCP Router を追加（`src/amcp-router.ts`）
- `v2.db` に Actor テーブル: `amcp_actors(group_id, capabilities, endpoint)`

**メッセージフロー（想定）:**
```
Group A (requester) → amcp_router (host) → Group B (provider)
                    ↑ IEDI 記録                ↑ IEDI 記録
```

Discovery: Group A が host の Actor Registry を参照し Group B の capabilities (= tools_config.allowed) を取得。

### ⑥ 評価・信頼：IEDI（概要）

**IEDI レコードの格納先:** `v2.db` (central DB) の新テーブル `iedi_records`

```sql
CREATE TABLE iedi_records (
  id TEXT PRIMARY KEY,           -- UUID
  requester_group_id TEXT,
  provider_group_id TEXT,        -- 自己起動タスクは requester = provider
  work_domain TEXT,              -- external_transaction | internal_task | decision | retrospective
  intent TEXT NOT NULL,          -- 事前宣言
  evidence TEXT,                 -- 実行ログ
  delta TEXT,                    -- 自然言語での差分 (intent vs evidence)
  insight TEXT,                  -- 学習・改善点
  prev_hash TEXT,                -- hash chain
  hash TEXT NOT NULL,
  created_at INTEGER,
  closed_at INTEGER
);
```

**二層学習モデル (DESIGN.md より):**
- Level 1 (オフラインバッチ): IEDI レコードを定期集計し、成功率パターンを抽出してシステムプロンプトを更新
- Level 2 (オンライン推定): `record_start` 時に類似 IEDI を FTS5 で検索し、実行モード (autonomous/cooperative/delegated) を動的決定

**実装順:** `v2.db` への `iedi_records` テーブル追加 → host 側 AMCP router での記録 → コンテナ側での IEDI ツール公開 → 学習ループ

---

## 設計判断サマリ

| 判断 | 決定内容 | 理由 |
|---|---|---|
| allowlist vs denylist | allowlist 制 | NanoClaw のコンテナ分離ポリシー：明示されたものだけアクセス可 |
| 引継ぎ設定 | なし | 変更の複雑度を下げ、独立設定を徹底する |
| グループ間通信 | 必ず host 経由 | host が信頼境界。P2P だと IEDI 記録とアクセス制御が困難 |
| IEDI 格納先 | central DB (v2.db) | 信頼・評判はグループレベル資産、全セッションで共有 |
| Pi MCP 方式 | AgentTool 直接ラップ | Pi は MCP クライアント非内蔵。関数レベル統合が唯一の正攻法 |

---

## 全ドキュメント索引

| ドキュメント | フェーズ | 内容 |
|---|---|---|
| `DESIGN-fork-overview.md` | 全体 | このドキュメント |
| `DESIGN-phase1-pi-provider.md` | 1 | Pi runner 追加設計 |
| `DESIGN-phase1-group-config.md` | 1 | per-group ツール allowlist 設計 |
| (フェーズ2) `DESIGN-phase2-hermes-memory.md` | 2 | Hermes メモリアーキテクチャ（未作成） |
| (フェーズ3) `DESIGN-phase3-amcp.md` | 3 | AMCP 組み込み設計（未作成） |
