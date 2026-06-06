# 設計ドキュメント: フェーズ1 グループ単位ツール設定 (tools_config)

> このドキュメントは NanoClaw フォーク フェーズ1 の ①「グループ単位ツール設定」と ③「subagent・MCPをツール化」をカバーする。
> ①の「ランナー（モデル）」部分は `docs/cc/DESIGN-pi-provider.md` が担当する。

---

## 0. ゴールと非ゴール

### ゴール

- グループごとに使用できるツールを **明示的な allowlist** で独立設定できるようにする。
- すべてのツール種別（SDK 組み込みツール・MCP ツール・Pi ネイティブツール・サブエージェントツール）を統一された **Tool** として扱う。
- ③「subagent・MCPをツール化」を、allowlist への追加という形で実現する。

### 設計原則

NanoClaw はコンテナ分離モデルを採用しており、エージェントがアクセスできるものは **明示的に許可されたものだけ** というポリシーを一貫させる。allowlist 制はこのポリシーと完全に一致する。

### 非ゴール（このドキュメントの範囲外）

- グループ間の引継ぎ・継承（意図的に除外）
- グループアクセス権 (`user_roles` / `agent_group_members`) の変更
- AMCP レイヤーでのツール制御（フェーズ3）
- Pi 固有のツール実体の実装（`docs/cc/DESIGN-pi-provider.md` §3-§5 が担当）

---

## 1. 背景: 現状のツール管理

現在 NanoClaw のツール管理は以下の 3 層に分散している。

| 層 | 実装場所 | per-group か |
|---|---|---|
| SDK 組み込みツール (Bash, Read, Task 等) | `claude.ts` の `TOOL_ALLOWLIST` / `SDK_DISALLOWED_TOOLS` | ❌ 全グループ共通 hardcode |
| MCP サーバー (= MCP ツール源) | `container_configs.mcp_servers` JSON 列 | ✅ グループ単位 |
| Pi ネイティブツール | `PiProvider` コンストラクタ内で `tools` 配列に直接登録 | ❌ provider コード内 hardcode |
| ncl アクセス範囲 | `container_configs.cli_scope` | ✅ グループ単位 |

**問題:** SDK 組み込みツールと Pi ネイティブツールがグループ単位で制御できない。また、subagent (Task / code_subagent) や MCP ツールが「ツール」という統一概念で管理されていない。

---

## 2. 設計: tools_config JSON 列

### 2.1 スキーマ定義

`container_configs` テーブルに `tools_config` JSON 列を追加する。

```json
{
  "allowed": ["ToolName1", "ToolName2", "mcp__server__*", ...]
}
```

| フィールド | 型 | 説明 |
|---|---|---|
| `allowed` | `string[]` | 許可するツール名またはワイルドカードパターンの配列 |

`tools_config` が `null` の場合は **後方互換のためのデフォルト動作** を使う（後述 §3）。

### 2.2 ツール名の規約

すべてのツールを名前で一意に識別する。名前規約は provider ごとに異なるが、グループの provider が固定されているため実行時に曖昧さはない。

**Claude provider グループ向けツール名:**

| カテゴリ | 名前例 |
|---|---|
| ファイル/シェル操作 | `Bash`, `Read`, `Write`, `Edit`, `Grep`, `Glob` |
| Web | `WebSearch`, `WebFetch` |
| サブエージェント | `Task`, `TaskOutput`, `TaskStop`, `TeamCreate`, `TeamDelete`, `SendMessage` |
| その他 SDK | `TodoWrite`, `Skill`, `ToolSearch`, `NotebookEdit` |
| MCP ツール（パターン） | `mcp__nanoclaw__*`, `mcp__<server>__<tool>` |

**Pi provider グループ向けツール名:**

| カテゴリ | 名前例 |
|---|---|
| ファイル/シェル操作 | `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls` |
| NanoClaw 組み込み (MCP → AgentTool ラップ) | `schedule_task`, `ask_user_question`, `send_message` |
| サブエージェント | `code_subagent`, `research_subagent` |

> **注意:** Pi のツール名は pi-coding-agent の `createXxxTool()` が返す `AgentTool.name` に従う。実装時に `createReadTool(cwd).name` 等で確認すること。

### 2.3 MCP ツールの扱い

MCP ツールは `mcp_servers` 列でサーバーを登録し、`tools_config.allowed` でツールの可視性を制御する。**二つは独立した責務**を持つ。

```
mcp_servers:  MCP サーバーを起動する（インフラ層）
tools_config: どのツールをエージェントが使えるか制御する（ポリシー層）
```

MCP サーバーが登録されていても、対応するパターンが `tools_config.allowed` になければエージェントはそのツールを呼べない。逆に、パターンはあってもサーバーが未登録なら、SDK はそのパターンを allowedTools に含めるが実際のツール呼び出しは SDK レイヤーで失敗する（ルーティング先がない）。どちらの不整合もユーザー操作ミスとして扱い、NanoClaw は検証エラーを出さない（起動時警告は将来検討）。この明示性が allowlist ポリシーの本質。

**SDK_DISALLOWED_TOOLS との優先順位:**
`claude.ts` の `SDK_DISALLOWED_TOOLS` (`CronCreate`, `AskUserQuestion` 等) は `tools_config.allowed` より**常に優先**する。これらを `allowed` に入れても preToolUseHook でブロックされる。`SDK_DISALLOWED_TOOLS` は NanoClaw の安全不変条件であり、グループ設定で上書きできない。ドキュメントやエラーメッセージでこれを明示すること。

### 2.4 デフォルト allowlist（新規グループ推奨値）

**Claude グループ:**
```json
{
  "allowed": [
    "Bash", "Read", "Write", "Edit", "Grep", "Glob",
    "WebSearch", "WebFetch",
    "Task", "TaskOutput", "TaskStop",
    "TodoWrite", "Skill", "ToolSearch", "NotebookEdit",
    "mcp__nanoclaw__*"
  ]
}
```

**Pi グループ:**
```json
{
  "allowed": [
    "bash", "read", "write", "edit", "grep", "find", "ls",
    "schedule_task", "ask_user_question",
    "code_subagent", "research_subagent"
  ]
}
```

> `send_message` は NanoClaw 組み込みツールだが、Pi グループでの実装はフェーズ1スコープ外。`DESIGN-pi-provider.md` §4 で確認されたツールのみをデフォルト allowlist に含める。

---

## 3. Provider 別の適用方法

### 3.1 Claude provider (`container/agent-runner/src/providers/claude.ts`)

現在の実装（変更前）:
```ts
// claude.ts
const TOOL_ALLOWLIST = ['Bash', 'Read', ...]; // hardcode
const allowedTools = [...TOOL_ALLOWLIST, ...Object.keys(mcpServers).map(mcpAllowPattern)];
```

変更後:
```ts
// claude.ts
// tools_config が設定されていればそれを使い、null の場合は従来の TOOL_ALLOWLIST + mcp_servers を使う（後方互換）
// 空配列 [] は「ツールなし（全拒否）」として扱う。null と [] は意味が異なる。
function buildAllowedTools(
  toolsConfig: { allowed: string[] } | null,
  mcpServers: Record<string, McpServerConfig>
): string[] {
  if (toolsConfig !== null) {
    // SDK_DISALLOWED_TOOLS はここで再フィルタしない。preToolUseHook が強制する。
    return toolsConfig.allowed; // 空配列 [] = 全ツール拒否（意図的）
  }
  // null = 後方互換デフォルト
  return [...TOOL_ALLOWLIST, ...Object.keys(mcpServers).map(mcpAllowPattern)];
}
```

`query()` 内で `allowedTools: buildAllowedTools(toolsConfig, mcpServers)` を SDK に渡す。

`toolsConfig` は `ProviderOptions` 経由で受け取る（後述 §3.4）。

> `SDK_DISALLOWED_TOOLS` は引き続き維持する（§2.3 参照）。`allowedTools` フィルタと `preToolUseHook` の二段構えで、SDK が新規ツールを追加したときの防御になる。

### 3.2 Pi provider (`container/agent-runner/src/providers/pi.ts`)

`PiProvider` 構築時に `toolsConfig` を受け取り、`AgentTool` リストをフィルタする。

```ts
// pi.ts
class PiProvider implements AgentProvider {
  constructor(opts: ProviderOptions) {
    const toolsConfig = opts.toolsConfig ?? null;
    const allTools: AgentTool[] = [
      createBashTool(opts.cwd),
      createReadTool(opts.cwd),
      // ... 全 AgentTool
      ...wrapNanoClawTools(opts),     // §4 NanoClaw 組み込みツールラップ（配列を spread）
      createCodeSubagentTool(opts),   // §5 code_subagent
      createResearchSubagentTool(opts), // §5 research_subagent
    ];

    this.tools = toolsConfig?.allowed
      ? allTools.filter(t => isToolAllowed(t.name, toolsConfig.allowed))
      : allTools; // null = 全ツール許可（開発時デフォルト）
  }
}

function isToolAllowed(toolName: string, allowed: string[]): boolean {
  // bare '*' は全許可（管理者が意図的に設定した場合は受け入れる）
  if (allowed.includes('*')) return true;
  return allowed.some(pattern =>
    pattern.endsWith('*')
      ? toolName.startsWith(pattern.slice(0, -1))
      : toolName === pattern
  );
}
```

### 3.3 container.json への書き出し

host 側 `src/container-config.ts` の `configFromDb()` と `ContainerConfig` 型に `toolsConfig` を追加する。

```ts
// src/container-config.ts

// ContainerConfig 型に追加:
export interface ContainerConfig {
  // ...既存フィールド...
  toolsConfig: { allowed: string[] } | null; // 追加
}

// configFromDb() 内に追加:
toolsConfig: row.tools_config ? JSON.parse(row.tools_config) : null,
```

`groups/<folder>/container.json` に `toolsConfig` フィールドが追記される。

### 3.4 ProviderOptions と index.ts

`toolsConfig` をコンテナ側で provider に届ける経路:

```
container.json (host 書き出し)
  → container/agent-runner/src/config.ts の loadConfig() で読み込み
  → ProviderOptions に追加
  → createProvider() で provider コンストラクタに渡す
```

**変更が必要なファイル:**

```ts
// container/agent-runner/src/config.ts
// RunnerConfig 型に追加:
export interface RunnerConfig {
  // ...既存フィールド...
  toolsConfig: { allowed: string[] } | null; // 追加
}
// loadConfig() の return に追加:
toolsConfig: raw.toolsConfig ?? null,

// container/agent-runner/src/providers/types.ts
// ProviderOptions に追加:
export interface ProviderOptions {
  // ...既存フィールド...
  toolsConfig: { allowed: string[] } | null; // 追加
}

// container/agent-runner/src/index.ts (または poll-loop.ts)
// createProvider() 呼び出し時に config.toolsConfig を渡す
```

> `poll-loop.ts` はコア（変更禁止）なので、`ProviderOptions` への追加は `index.ts` での `createProvider()` 呼び出し箇所で行う。`poll-loop.ts` の呼び出しシグネチャが変わらないように `ProviderOptions` に field を追加するだけで対応できる。

---

## 4. DB マイグレーション

### 4.1 マイグレーション SQL

`src/db/migrations/` に新規マイグレーションを追加:

```sql
-- migration: add tools_config to container_configs
ALTER TABLE container_configs ADD COLUMN tools_config TEXT; -- JSON, nullable
```

### 4.2 コード変更

`src/db/container-configs.ts`:
- `JSON_COLUMNS` set に `'tools_config'` を追加
- `updateContainerConfigJson()` の column union 型を拡張
- `ContainerConfigRow` 型に `tools_config?: string | null` を追加

```ts
// JSON_COLUMNS に追加:
const JSON_COLUMNS = new Set([
  'skills', 'mcp_servers', 'packages_apt', 'packages_npm',
  'additional_mounts',
  'tools_config', // 追加
]);

// updateContainerConfigJson の column union を拡張:
export function updateContainerConfigJson(
  groupId: string,
  column: 'skills' | 'mcp_servers' | 'packages_apt' | 'packages_npm' | 'additional_mounts' | 'tools_config', // 追加
  value: unknown
): void { ... }

// ContainerConfigRow 型に追加:
tools_config?: string | null;
```

### 4.3 既存グループへの影響

`tools_config = null` のグループは後方互換デフォルト動作を取る（Claude: 現行 TOOL_ALLOWLIST、Pi: 全 AgentTool）。**既存グループの動作変更なし。**

新規グループ作成時は §2.4 のデフォルト allowlist を推奨値として提示するが、初期値は `null`（DB INSERT 時のデフォルト）のまま。グループ作成フローで設定を促す UX 改善はオプション。

---

## 5. ncl CLI

### 5.1 CLI 変更が必要な箇所

`ncl groups config update` の現行実装はスカラー列のみを処理し (`updateContainerConfigScalars`)、JSON 列を直接 `--tools-config` フラグで渡す口がない。**`--tools-config` フラグを新たに追加する必要がある。**

```ts
// src/cli/resources/groups.ts（または dispatch.ts）の config update ハンドラに追加:
if (args['tools-config']) {
  const parsed = JSON.parse(args['tools-config'] as string);
  // 入力バリデーション: { allowed: string[] } の形式を強制する
  if (!parsed || !Array.isArray(parsed.allowed) || !parsed.allowed.every((t: unknown) => typeof t === 'string')) {
    throw new Error('--tools-config must be JSON with shape: { "allowed": string[] }');
  }
  updateContainerConfigJson(groupId, 'tools_config', parsed);
}
```

完成後の利用方法:
```bash
# 現在の設定を確認
ncl groups config get --id <group-id>

# tools_config を設定（JSON 全体を渡す）
ncl groups config update --id <group-id> --tools-config '{"allowed":["Bash","Read","mcp__nanoclaw__*"]}'
```

### 5.2 将来オプション（フェーズ1スコープ外）

使い勝手の向上として以下を将来検討できる:
- `ncl groups config add-tool --id <id> <tool-name>`
- `ncl groups config remove-tool --id <id> <tool-name>`
- `ncl groups config list-tools --id <id>` ── 現在許可されているツール一覧

---

## 6. ③「subagent・MCPをツール化」との関係

この設計において、subagent と MCP ツールは **他のツールと同列の Tool** として扱われる。

| ③ の要素 | 実現方法 |
|---|---|
| MCP ツールをツール化 | `mcp__nanoclaw__*` を allowlist に入れる。MCP サーバーは `mcp_servers` で登録。 |
| サブエージェント (Claude) をツール化 | `Task`, `TaskOutput`, `TaskStop` を allowlist に入れる。SDK の組み込み機能を活用。 |
| サブエージェント (Pi) をツール化 | `code_subagent`, `research_subagent` を allowlist に入れる。実装は `DESIGN-pi-provider.md` §5。 |

allowlist に含めることで「このグループはサブエージェントを使える」「このグループは使えない」をグループ単位で明示的に制御できる。

---

## 7. フェーズ3 (AMCP) への接続点

フェーズ3では AMCP の `beforeToolCall` / `afterToolCall` フックが全ツール呼び出しを横断する（`DESIGN-pi-provider.md` §6 参照）。この設計の allowlist は AMCP の「Discovery フェーズ」で公開する **capability リスト** と自然に対応する。

```
AMCP Discovery → "このアクター (グループ) が持つ Tool リスト" = tools_config.allowed
```

フェーズ3で AMCP actor として公開する際、`tools_config.allowed` をそのまま capability として提示できる設計になっている。

---

## 8. 実装順サマリ

```
1. DB マイグレーション: container_configs に tools_config 列を追加
2. src/db/container-configs.ts: JSON_COLUMNS 更新、union 型拡張、ContainerConfigRow 型追加
3. src/container-config.ts: ContainerConfig 型に toolsConfig 追加、configFromDb() を更新
4. container/agent-runner/src/config.ts: RunnerConfig に toolsConfig 追加、loadConfig() を更新
5. container/agent-runner/src/providers/types.ts: ProviderOptions に toolsConfig 追加
6. claude.ts: buildAllowedTools() 追加、allowedTools 生成ロジック変更
7. pi.ts: ProviderOptions 経由で toolsConfig 受け取り、AgentTool フィルタリング追加
   ※ pi.ts の骨格は DESIGN-pi-provider.md §3 に従って先に実装する
8. src/cli/resources/groups.ts: config update に --tools-config フラグ追加
9. 統合テスト: claude グループと pi グループを併存させ、tools_config あり/なしで動作確認
```

---

## 9. 触ってよい / 触ってはいけないファイル

### 変更対象
- `src/db/migrations/<next>.ts` — tools_config 列追加
- `src/db/container-configs.ts` — JSON_COLUMNS, union 型, ContainerConfigRow 型
- `src/container-config.ts` — ContainerConfig 型, configFromDb()
- `src/cli/resources/groups.ts` — config update に --tools-config フラグ
- `container/agent-runner/src/config.ts` — RunnerConfig 型, loadConfig()
- `container/agent-runner/src/providers/types.ts` — ProviderOptions に toolsConfig
- `container/agent-runner/src/providers/claude.ts` — `buildAllowedTools()` 追加
- `container/agent-runner/src/providers/pi.ts` — toolsConfig フィルタリング（新規作成）

### 参照のみ（変更しない）
- `container/agent-runner/src/providers/mock.ts` — ひな形参照用
- `container/agent-runner/src/poll-loop.ts` — コア（変更禁止）
- `container/agent-runner/src/mcp-tools/index.ts` — ラップ対象ツール実体（§4 参照用）

### 絶対に壊さない
- `claude` provider の既存動作（`tools_config = null` 時の後方互換デフォルト）
