# 設計ドキュメント: NanoClaw への Pi provider 追加

> このドキュメントは、**通常の NanoClaw(Claude provider, Anthropic Agent SDK)上で動く Claude Code** に渡して、自己改善的に実装を進めるための設計仕様である。実装エージェントはこのドキュメントを単一の参照点として作業してよい。前提知識(NanoClaw / Pi の構造)は本文に埋め込んである。

---

## 0. ゴールと非ゴール

### ゴール
NanoClaw の agent runtime を、既存の Anthropic Agent SDK(`claude` provider)に加えて **Pi Agent Framework(`@mariozechner/pi-*`)** でも動かせるようにする。group 単位で provider を切り替えられる状態(`claude` と `pi` の併存)を最終形とする。

**運用上の最終形(モデル構成)**: メインのパーソナル AI とサブエージェントの**両方を `pi` provider で動かす**。pi-ai のマルチプロバイダ性を使い、役割ごとに別モデルへ振り分ける(§5.5):
- メイン(パーソナル AI): **Claude Sonnet**(pi-ai の `anthropic` プロバイダ経由)
- コーディング サブエージェント: **local LLM**(Qwen3 等、OpenAI 互換エンドポイント)
- リサーチ サブエージェント: **DeepSeek**(pi-ai の `deepseek` プロバイダ経由、API)

ただし**いつでも `claude` provider に戻せる退避路を常に維持する**(§8 の退避路 = group の provider 名を `claude` に戻すと素の Anthropic SDK 構成に即復帰)。これは二段構え: (a) pi provider 自体が壊れたら provider 名を `claude` に戻す、(b) Pi 経由 Sonnet に不満が出ても provider 名を `claude` にすれば SDK ネイティブ Sonnet に戻る。

### フェーズ
- **フェーズ1**: `pi` provider を新設し、`claude` と `pi` の両方が選べる状態にする。Pi 側のツールは coding-agent から **必要最小限を cherry-pick** する。最小動作(ファイル/シェル操作 + NanoClaw 組み込みツール)が回ることをもって完了とする。
- **フェーズ1-2**: フェーズ1で後送りにした **WebSearch / WebFetch** と **Task(サブエージェント)** を `pi` provider 上でも使えるようにする。あわせて**役割別モデル振り分け**(メイン Sonnet / コーディング local LLM / リサーチ DeepSeek、§5.5)を実現する。

### 非ゴール(このドキュメントの範囲外)
- `claude` provider の挙動変更。既存の `claude` 経路は一切壊さないこと。
- 外部 MCP サーバを Pi に橋渡しする汎用ブリッジ(`@modelcontextprotocol/sdk` 経由)。これはフェーズ2以降の別タスク。本ドキュメントは「NanoClaw 自前ツールを Pi ネイティブツールとして直接ラップする」ところまでを扱う。
- AMCP mediator 層の実装。ただし**実装ポイントだけは確保**する(後述 §6)。

---

## 1. 背景: 差し替えの切れ目はどこにあるか

NanoClaw は最初から provider 差し替えを想定して作られている。SDK 依存は `container/agent-runner/src/providers/claude.ts` の **1ファイルに完全に閉じ込められている**。コア(`index.ts` → `poll-loop.ts`)は抽象 `AgentProvider` しか参照しない。

### provider が満たすべきインターフェース
`container/agent-runner/src/providers/types.ts` の `AgentProvider`:

```ts
export interface AgentProvider {
  readonly supportsNativeSlashCommands: boolean;
  query(input: QueryInput): AgentQuery;
  isSessionInvalid(err: unknown): boolean;
  maybeRotateContinuation?(continuation: string, cwd: string): string | null; // optional
}
```

- `QueryInput`: `{ prompt, continuation?, cwd, systemContext?: { instructions? } }`
- `AgentQuery`: `{ push(message), end(), events: AsyncIterable<ProviderEvent>, abort() }`
- `ProviderEvent`(出力の正規化済みユニオン):
  - `{ type: 'init'; continuation: string }`
  - `{ type: 'result'; text: string | null }`
  - `{ type: 'error'; message: string; retryable: boolean; classification? }`
  - `{ type: 'progress'; message: string }`
  - `{ type: 'activity' }` ← **重要**。下記 §3 の継ぎ目2を必ず守ること。

### provider の登録方法(自己登録レジストリ)
`container/agent-runner/src/providers/provider-registry.ts` の `registerProvider(name, factory)` を呼ぶだけ。`providers/index.ts`(barrel)が各 provider モジュールを副作用 import する。新 provider 追加は **コアにも既存 provider にも一切触らない**:

1. `container/agent-runner/src/providers/pi.ts` を新規作成し、末尾で `registerProvider('pi', (opts) => new PiProvider(opts))` を呼ぶ。
2. `container/agent-runner/src/providers/index.ts` に `import './pi.js';` を1行追記する。

### host(gateway)側の provider 選択
provider 名は DB 解決される: `sessions.agent_provider`(per-session)→ `container_configs.provider`(per-group)。
- host 側で追加マウント/env が必要な provider だけ `src/providers/provider-container-registry.ts` の `registerProviderContainerConfig(name, fn)` に登録する。
- `claude` と `mock` は host 側に登録不要(デフォルトのマウント/env で動く)。**Pi も、追加マウント/env が不要なら host 側登録は不要**。まずは不要側で進め、必要が判明した時点で `src/providers/pi.ts`(host側)を足す。

### 最小実装の参照(重要: 実在の手本がある)
NanoClaw の **`providers` ブランチ**に、`AgentProvider` を実装した実在の provider が複数ある(`codex`, `opencode`, `ollama`)。`/add-codex` `/add-opencode` `/add-ollama-provider` は公式の provider 追加 skill で、いずれも本ドキュメント §1 と同じ作法(host/container 両側にファイル + barrel に1行 import + コア不変)を取る。**Pi provider の追加はこれらと同一カテゴリの作業**であり、方式は公式作法と一致している。

手本の優先順位:
1. **`opencode.ts`(container 側、`providers` ブランチ)を主たる手本とする**。`query()` 内の continuation→session・`init` yield・push/end/abort の内部キュー駆動(`kick()`)・event ループ・`activity` 発火・エラーの throw→外側 catch まで、§3 の4つの継ぎ目が動くコードとして揃っている。取得: `git fetch origin providers` 後に `git show origin/providers:container/agent-runner/src/providers/opencode.ts`。host 側は `src/providers/opencode.ts`。
2. `mock.ts`(trunk)は最小構造の確認用(約70行)。配線(factory/barrel/DB 解決)を最初に通す段階で使う。
3. `claude.ts`(trunk)は SDK 固有実装の対比用(**変更禁止**)。

> **ただし方式が1点だけ異なる(§3・§4 参照)**: opencode/codex は外部 CLI を**子プロセス**で起動する方式。Pi は npm ライブラリなので **同一プロセス内でライブラリ直 import** する方式を取る。骨格(継ぎ目の埋め方)は opencode を真似てよいが、ランタイム起動方法と MCP の扱いは Pi 固有になる。

---

## 2. Pi 側の構造(取り込む対象)

Pi は3層の monorepo。バージョンは `0.73.1` で確認済み。

| パッケージ | 役割 | 依存の重さ |
|---|---|---|
| `@mariozechner/pi-ai` | マルチプロバイダ LLM API(Anthropic/OpenAI/Google/Bedrock/Mistral + ローカル) | 中(undici, proxy-agent ほか) |
| `@mariozechner/pi-agent-core` | **エージェントループ本体**。ツール実行・イベント・会話管理・before/afterToolCall フック | **軽い(依存は pi-ai と typebox のみ)** |
| `@mariozechner/pi-coding-agent` | ツール実体(Bash/Read/Write/Edit/Grep/Find/Ls)・compaction・skills・session 永続化・CLI/TUI | 重い(photon-node 等の native 依存込み) |

### 重要な事実(調査で確定済み)
- **pi-agent-core は組み込みツールを一つも持たない**。エンジンだけ。
- ファイル/シェル系ツール・compaction・skills・SessionManager は **すべて coding-agent 側**にある。
- したがって本方針は **agent-core をエンジンに据え、coding-agent からツール関数だけ cherry-pick** する。
- coding-agent のツールは agent-core の `AgentTool` 型に変換済みで個別 export されている。例:
  - `createReadTool(cwd, options?): AgentTool` ← agent-core 形(これを使う)
  - `createReadToolDefinition(cwd, options?): ToolDefinition` ← coding-agent の拡張形
  - 同様に `createBashTool` / `createEditTool` / `createWriteTool` / `createGrepTool` / `createFindTool` / `createLsTool`、まとめて `createCodingTools` / `createReadOnlyTools`。
- **CLI/TUI/InteractiveMode は import しないこと**。`createBashTool` などツール関数のみを named import すれば、重い UI 依存は引き込まない(tree-shaking + 明示 import)。

### Pi のエージェント API(agent-core)
- `Agent` クラス(`@mariozechner/pi-agent-core`):
  - 構築: `new Agent({ initialState: { systemPrompt, model, tools, messages }, sessionId?, beforeToolCall?, afterToolCall?, transformContext?, shouldStopAfterTurn?, getApiKey? })`
  - 実行: `prompt(text | messages)`, `continue()`
  - 制御: `abort()`, `steer(msg)`(現ターン後に注入), `followUp(msg)`(停止しかけたら継続), `waitForIdle()`, `reset()`
  - 購読: `subscribe((event: AgentEvent, signal) => ...)` → 返り値は unsubscribe 関数
- `AgentEvent` のユニオン: `agent_start | turn_start | message_start | message_update | message_end | turn_end | tool_execution_start | tool_execution_update | tool_execution_end | agent_end`
- ツール定義: `AgentTool`(`@mariozechner/pi-agent-core`)/ `defineTool`(coding-agent の `core/extensions`)。`execute(toolCallId, params, signal?, onUpdate?): Promise<AgentToolResult>` を実装する。

---

## 3. フェーズ1: 4つの継ぎ目の実装仕様

`PiProvider implements AgentProvider` を `container/agent-runner/src/providers/pi.ts` に実装する。`mock.ts` の構造(push/end/abort と AsyncIterable events)を踏襲する。内部で Pi の `Agent` を1つ持ち、`subscribe` を AsyncIterable に変換する。

### 継ぎ目1: continuation ↔ Pi session
- `QueryInput.continuation` は **opaque token**。Pi の `sessionId` をここに載せる。
- `query()` 開始時:
  - `continuation` があれば `new Agent({ sessionId: continuation, ... })` で再開、なければ新規 `sessionId` を生成。
  - `agent_start` を受けたら最初に `{ type: 'init', continuation: <sessionId> }` を yield する。
- セッションの永続化は **フェーズ1では NanoClaw 側の session DB に寄せる**(coding-agent の SessionManager は導入しない)。会話履歴は agent-core の `state.messages` を保持/復元する形にする。最小実装では「再開しない(毎回新規)」でも動作確認は可能だが、`init` の continuation 往復は必ず通すこと。

### 継ぎ目2: AgentEvent → ProviderEvent 変換(最重要)
- **`subscribe` で受けるすべての Pi イベントごとに、まず `{ type: 'activity' }` を yield すること。** これを怠ると host の idle タイマーがコンテナを kill する(長いツール実行中に応答前に殺される)。`tool_execution_update` / `message_update` が逐次来るので、それらを activity に落とせば liveness は維持できる。
- マッピング:
  | Pi AgentEvent | ProviderEvent |
  |---|---|
  | `agent_start` | `{ type: 'init', continuation }`(初回のみ) |
  | `message_update` / `tool_execution_*` / `turn_*` | `{ type: 'activity' }`(必ず) |
  | 最終アシスタントテキスト(`agent_end` または最後の `message_end` のテキスト) | `{ type: 'result', text }` |
  | ストリーム上のエラー(`stopReason: 'error' \| 'aborted'` + `errorMessage`) | `{ type: 'error', message, retryable }` |
  | 進捗的な通知(任意) | `{ type: 'progress', message }` |
- Pi の `StreamFn` 契約上、**リクエスト/モデル/ランタイム失敗は throw されず、ストリーム内の protocol event と最終 AssistantMessage(`stopReason: 'error'`)で表現される**。エラーは例外ではなくイベントとして拾うこと。

### 継ぎ目3: isSessionInvalid
- `claude` 実装は正規表現でエラーテキストを判定していた。Pi では **SessionManager がセッションを見つけられなかったケース**(フェーズ1で SessionManager 未導入なら、NanoClaw session DB に該当 continuation が無いケース)を `true` 判定にする。
- フェーズ1で再開を実装しない場合でも、メソッドは実装し `false` 固定でも可(mock と同じ)。ただし将来の再開実装時にここを埋める前提でコメントを残すこと。

### 継ぎ目4: push/end/abort ↔ steer/followUp/abort
- `AgentQuery.push(message)` → Pi の `steer(message)`(実行中ターンへ注入)または `followUp(message)`(停止後に継続)。**まずは `followUp` 寄せで実装**(NanoClaw のメッセージは「次の発話」に近い)。挙動を見て必要なら `steer` に切替。
- `AgentQuery.end()` → これ以上の入力なし。Pi 側は `waitForIdle()` の完了を待って events を閉じる。
- `AgentQuery.abort()` → Pi の `abort()`。
- `events` → `subscribe` を push 型 AsyncIterable に変換するアダプタ(`mock.ts` の events 実装と同じ要領で、内部キュー + waiting resolver を使う)。
- `supportsNativeSlashCommands`: フェーズ1は **`false`** にしておく(NanoClaw 側でスラッシュコマンドを通常メッセージとして整形させる)。coding-agent のスラッシュ機構を使う段階で再検討。

### ランタイム起動方式: ライブラリ直 import(opencode/codex とは異なる)
- opencode は `opencode serve` を、codex は `codex app-server` を **子プロセスで spawn し、HTTP/JSON-RPC + event subscribe** で話す。これらは外部 CLI だからその方式を取る。
- **Pi は npm ライブラリ(`@mariozechner/pi-agent-core`)なので、子プロセスを立てず、`PiProvider` の中で `Agent` を直接 `new` してライブラリ呼び出しで使う**。子プロセス管理・ポート・HTTP 往復は不要。`subscribe` を直接 AsyncIterable に変換すればよい。これは opencode 方式より単純で、本構成の利点。
- したがって opencode.ts の「spawn / ensureSharedRuntime / killProcessTree / HTTP client」まわりは**真似しない**。真似るのは query() 内の継ぎ目の埋め方(continuation 処理・init yield・activity 発火・push/end/abort 駆動・エラー throw→外側 catch)。

### idle-timeout 防御パターン(opencode から移植する価値あり)
- opencode は query 内で「最終イベント受信時刻」を監視し、一定時間(既定 300s)イベントが来なければ session をクリアして runtime を破棄する `setInterval` を回している。これは §3 継ぎ目2の activity による liveness 維持を**補完**する防御(イベント自体が止まった場合の保険)。
- Pi はライブラリ直なので runtime 破棄は不要だが、「Pi のストリームが無音のまま固まった場合に検知して `abort()` し `error` を返す」防御として、同等の idle 監視を入れておくと host kill 前に自分で畳める。フェーズ1では必須ではないが、長時間ツール実行を回し始めたら導入を検討する。


`createProvider` に渡される `ProviderOptions`(`cwd` は `QueryInput.cwd` で受ける)を使い、以下を `Agent` の `tools` に登録する:

1. coding-agent から: `createReadTool(cwd)`, `createWriteTool(cwd)`, `createEditTool(cwd)`, `createBashTool({ cwd, ... })`, `createGrepTool(cwd)`, `createFindTool(cwd)`, `createLsTool(cwd)` のうち**最小限**。最小動作の目安は **Read / Write / Edit / Bash + Grep/Ls** 程度。`createCodingTools(cwd)` で一括取得もできるが、入る範囲を把握するため個別 import を推奨。
2. NanoClaw 組み込みツール(下記 §4)を Pi ネイティブツールとしてラップしたもの。

> WebSearch / WebFetch / Task は **フェーズ1では入れない**(§5 で対応)。

---

## 4. NanoClaw 組み込みツールの Pi ネイティブ化(フェーズ1の中核作業)

### 問題
NanoClaw は組み込みツール(`schedule_task`, `ask_user_question` など)を `mcp__nanoclaw__*` という **MCP サーバ**(`container/agent-runner/src/mcp-tools/index.ts` を bun で起動)として agent に渡し、Claude SDK の `mcpServers` 経由で接続していた。

**Pi(agent-core / coding-agent)は MCP クライアントを持たない**(調査で確定。`@modelcontextprotocol/sdk` 非依存)。したがって `mcpServers` を渡す口が無い。

### 重要: opencode/codex の MCP 方式は Pi には使えない
- `providers` ブランチに `mcp-to-opencode.ts` という実在のブリッジがある。だがこれは **NanoClaw の MCP サーバ定義(command/args/env)を opencode の config 形式に「翻訳するだけ」の十数行**にすぎない。opencode と codex は **MCP クライアントを内蔵**しているので、定義さえ渡せばツールの起動・実行は外部 CLI 側が引き受ける。
- **Pi は MCP クライアントを内蔵しない**(調査で確定、`@modelcontextprotocol/sdk` 非依存)。したがって `mcp-to-opencode.ts` 方式(定義翻訳)は **Pi には適用できない**。実装エージェントが opencode を手本にする際、この MCP ブリッジだけは真似てはいけない。
- Pi では下記のとおり「ツールの**実体(関数)**を Pi の `AgentTool` としてラップする」関数レベルの統合が必要。opencode/codex が定義翻訳で済むのに対し、**Pi は MCP に関して最も手のかかる provider**になる(その代わり、ツール実行が自プロセス内の関数呼び出しになるため §6 の before/afterToolCall フックで完全に介在できる ── AMCP mediator を差し込めるのはこの構造ゆえ)。

### 解決(本命)
MCP ツールの**実体は各ツールモジュール内の TS 関数**。Pi では MCP stdio 往復を一切挟まず、**直接 Pi の `AgentTool` / `defineTool` でラップする(インプロセス直呼び)**。OpenClaw 自身も「MCP ツールを Pi のネイティブツールとして動的登録する」方式を取っており、これはアンチパターンではなく正攻法。インプロセス直呼びなので OpenClaw より一段シンプルかつ高速。

> **注意**: Claude グループでは `mcp-tools/index.ts` が **サブプロセス**として起動され(Claude SDK が `mcpServers` config を受け取り MCP stdio 経由で繋ぐ)、ツールはそのサブプロセス内で実行される。Pi ではサブプロセスを立てない ── 個別ツールモジュールを**同一プロセス内で直接インポートし**、ハンドラを Pi の AgentTool として登録する。

### 前提: `server.ts` に `getRegisteredTools()` を追加する
`mcp-tools/server.ts` の `toolMap` / `allTools` は非 export のモジュールローカル変数。Pi からアクセスするには、`server.ts` に以下を **追記**する(既存の `registerTools` / `startMcpServer` は変更しない):

```ts
// mcp-tools/server.ts に追記
export function getRegisteredTools(): readonly McpToolDefinition[] {
  return allTools;
}
```

`mcp-tools/index.ts` は**インポートしてはならない** ── 副作用として MCP stdio server が起動してしまう。

### 作業
1. 個別ツールモジュールを Pi provider の初期化時にインポートし `registerTools()` の副作用を発火させる:
   ```ts
   import '../mcp-tools/core.js';
   import '../mcp-tools/scheduling.js';
   import '../mcp-tools/interactive.js';
   import '../mcp-tools/agents.js';
   // self-mod.ts は必要に応じて追加
   ```
2. `getRegisteredTools()` で登録済み定義一覧を取得する:
   ```ts
   import { getRegisteredTools } from '../mcp-tools/server.js';
   const nanoDefinitions = getRegisteredTools(); // McpToolDefinition[]
   ```
3. それぞれを Pi の `AgentTool` に変換する薄いアダプタを書く:
   - `name`(`schedule_task` 等。Pi 側では `mcp__` プレフィックス不要)
   - 入力スキーマ(`McpToolDefinition.tool.inputSchema`)→ Pi の `Tool<TParameters>` に合わせる
   - `execute(toolCallId, params, signal?, onUpdate?)` の中で **`McpToolDefinition.handler(params)` を直接呼ぶ**
   - 戻り値(`CallToolResult`)を `AgentToolResult`(`content: (Text|Image)[]`, `details`)に詰める
4. ラップしたツール群を `Agent` の `tools` に追加する。
5. **`toolsConfig.allowed` によるフィルタリング**を忘れずに行う。Pi ではネイティブツール + ラップ済み NanoClaw ツールの全リストを `toolsConfig` で絞り込む(フィルタリング実装の詳細: `DESIGN-phase1-group-config.md` §3 の `isToolAllowed` 関数を参照)。
6. **注意**: `ask_user_question` は NanoClaw 側で「質問を永続化し実際の返信をブロック待ちする」MCP ツールだった(SDK の `AskUserQuestion` を置換していた)。Pi 化でもこのブロッキング挙動(返信が来るまで待つ)を保つこと。`schedule_task` は NanoClaw の durable scheduling に繋がっている。これらの host 連携(session DB / outbox)は維持する。

### Claude 実装で無効化していたツールの扱い
`claude.ts` の `SDK_DISALLOWED_TOOLS`(`CronCreate`, `AskUserQuestion`, `EnterPlanMode` 等)は **Claude SDK 固有の組み込みツールを止めるためのもの**。Pi には対応する組み込みツールが無いため、この allowlist/disallowlist 機構は **Pi 側では不要**。Pi では「登録したツールだけが存在する」ので、必要なツールを足すだけでよい。

---

## 5. フェーズ1-2: WebSearch / WebFetch と Task(サブエージェント)

フェーズ1完了後、`pi` provider に以下を追加する。いずれも `claude` provider が SDK 経由で持っていたが Pi にはない機能。**Pi の `AgentTool` として自前実装し、`tools` に足す**形を基本とする。

### WebSearch / WebFetch

**設計方針: クライアントサイド実装が必須の理由**

Anthropic は `web_search_20260209` / `web_fetch_20260209` というサーバーサイドツールを提供するが、Pi provider が扱う他のプロバイダはこれに相当する仕組みを持たないか、対応状況が一様でない(DeepSeek は一部バージョンでサーバーサイド対応があるが、ローカル LLM 等は未対応)。プロバイダ間で一貫した動作を保証するため、**`AgentTool` としてクライアントサイドで実装する**。これにより:

- どのモデル(メイン Sonnet / コーディング local LLM / リサーチ DeepSeek)でも同一のツール実装が使える
- プロバイダ固有のサーバーサイドツール対応状況に左右されない
- 将来プロバイダを追加しても、ツール層の変更が不要

なお `claude` provider では引き続き Anthropic のサーバーサイドツールが使われる(退避路としての `claude` 経路は変更しない)。Pi provider 上でのみ本クライアントサイド実装が使われる。

**実装**:
- coding-agent のツール一覧(bash/edit/find/grep/ls/read/write)にも**含まれない**。Pi 側にネイティブ実装は無い。
- 自前で `AgentTool` を実装する:
  - `web_search`: 検索 API(Brave Search / Tavily / SerpAPI 等、任意のプロバイダ)を叩き、結果を `content` に整形して返す。
  - `web_fetch`: URL を取得し本文抽出して返す。
- host 連携が要る場合(APIキーの注入など)は、`ProviderOptions.env` 経由で鍵を渡し、必要なら host 側 `provider-container-registry.ts` に env passthrough を登録する。

### Task(サブエージェント)
- NanoClaw の allowlist にあった `Task` / `TaskOutput` / `TaskStop` / `TeamCreate` / `SendMessage` は **Anthropic SDK 固有のサブエージェント/チーム機構**。Pi 標準には直接対応物が無い。
- Pi 上での実装方針: **「サブエージェント起動」ツールを `AgentTool` として実装し、その execute 内で `Agent` を子インスタンスとして new し、別 sessionId で `prompt()` を回して結果を集約する**。親の `Agent` から見れば1つのツール呼び出し。
  - 並行制御は agent-core の `toolExecution: 'sequential' | 'parallel'` と整合させる。
  - 子の進捗は親ツールの `onUpdate`(`AgentToolUpdateCallback`)経由で `tool_execution_update` に流し、§3 継ぎ目2の activity マッピングで liveness を維持する。
- **役割別にモデルを変える(本構成の要点)**: 子 `Agent` は**インスタンスごとに異なる `Model` を渡せる**(§5.5)。したがって単一の `Task` ツールではなく、**役割ごとに別モデルの子 Agent を起動するツールを用意する**:
  - `code_subagent`: 子 Agent を **local LLM(Qwen3 等)** の `Model` で new(コーディング用ツール = Read/Write/Edit/Bash/Grep を付与)
  - `research_subagent`: 子 Agent を **DeepSeek** の `Model` で new(リサーチ用ツール = `web_search`/`web_fetch` を付与)
- まずは2種(code/research)から実装し、`Team`/`SendMessage`(複数エージェント協調)は必要になってから拡張する。

#### サブエージェント起動ツールの設計指針(自動振り分けの精度を決める)
- **デフォルトモデル + オプション上書き**: 各サブエージェント起動ツールは**役割に適したモデルをデフォルトで内蔵**する(`code_subagent` → local LLM、`research_subagent` → DeepSeek)。モデルは**省略可能なオプション引数**として受け取り、**省略時はデフォルトを使う**。
  - 理由: 引数を必須にするとメイン Agent が毎回「どのモデルか」まで判断させられ、選択負荷とブレが増える。通常はデフォルトに任せ、ユーザ/メインが明示したときだけ上書きが効く形にする(例: 「重い調査なので上位モデルで」)。
  - 上書き値が許可モデル集合に入るか execute 内で検証し、不正なら既定にフォールバックするか `isError` を返す。
- **description に「いつ呼ぶ / いつ呼ばない」を明記する**: メイン Agent が正しいサブを選べるかは、ほぼツールの `description` の質に依存する(モデル性能の問題ではなくツール設計の問題)。各ツールの description に、適したタスクの例・**適さないタスクの例(他方のサブやメイン直処理に回すべきケース)**・複合タスクの分解方針(例: 「原因調査→修正」は research→code の順で2回呼ぶ)まで書く。
- **自動振り分けの観測と改善(beforeToolCall ログ)**: メインがどのサブエージェントをどのモデルで呼んだかは §6 の `beforeToolCall` フックを通る。**最初からこのフックで「呼ばれたサブ名・モデル・引数・呼び出し理由」をログする**。自動振り分けは一度書いて終わりではなく、ログを見て「意図と違うサブが選ばれている / サブを呼ばず直処理している」ケースを見つけ、description を磨いて精度を上げる**調整サイクル**を回す(本プロジェクトの自己改善方針に合致)。このフックは将来 AMCP mediator の差し込み点(§6)と同一なので、観測のための配線がそのまま mediator の土台になる。

---

## 5.5 モデル構成: メイン Sonnet + サブ(local / DeepSeek)の振り分け

> **前提(調査で確定済み)**: pi-ai の `KnownProvider` には `anthropic` と `deepseek` が**組み込みで存在**する。`models.generated` に DeepSeek 系・Qwen 系モデルが多数登録済み。さらに `Provider = KnownProvider | string` で**型が任意文字列も許容**し、`registerApiProvider(...)` で OpenAI 互換の独自エンドポイント(手元の Ollama/vLLM 等)を登録できる。3モデル構成は **pi-ai 標準機能だけで成立**し、新規の大きな設計は不要。

### モデル解決の仕組み(pi-ai)
- モデルは `Model` 型(`{ provider, baseUrl, ... }`)で表現。取得は `getModel(provider, modelId)`。
- API キーは `Agent` 構築時の `getApiKey(provider)` コールバックで provider 名から解決する(各 provider のキーを返す単一の関数)。
- `Agent` は **インスタンスごとに `initialState.model` を取る**。したがって「メイン Agent は Sonnet、子 Agent は別モデル」を同一プロセス内で並立できる。

### 3つの役割の設定
1. **メイン(Sonnet)**: `getModel('anthropic', '<sonnet-model-id>')`。`PiProvider` が構築するトップレベル Agent に渡す。
2. **コーディング サブ(local LLM)**: 手元の OpenAI 互換エンドポイント(Qwen3 on RTX 4090)を使う。
   - カタログに合致する Qwen が `models.generated` にあればそれを、無ければ `registerApiProvider` で `{ provider: '<local>', baseUrl: 'http://<gpu-host>:<port>/v1', ... }` を登録して `Model` を作る。
   - `code_subagent` の子 Agent にこの `Model` を渡す。
3. **リサーチ サブ(DeepSeek)**: `getModel('deepseek', '<deepseek-model-id>')`。`research_subagent` の子 Agent に渡す。

### キー/エンドポイントの注入経路
- 3系統の資格情報が要る: Anthropic 認証(Sonnet)、local エンドポイント URL(認証不要なことが多い)、DeepSeek API キー。
- `getApiKey(provider)` が provider 名で出し分ける。キー・URL は **`ProviderOptions.env` / コンテナ env 経由**で渡し、必要なら host 側 `src/providers/pi.ts`(`registerProviderContainerConfig`)で env passthrough を登録する(§1 host 側登録、§5 WebSearch のキー注入と同じ経路)。
- **ネットワーク到達性の確認(重要)**: コンテナ → GPU ホスト(local LLM エンドポイント)の到達性を必ず確認する。この環境は過去に IPv6 ルーティング問題があったため、コンテナから `http://<gpu-host>:<port>/v1` に到達できるか(IPv4/IPv6 経路、Docker ネットワーク)を実機で検証してから子 Agent に組み込む。

### 退避との関係
- このモデル構成はすべて `pi` provider の**内側**の話。group の provider 名を `claude` に戻せば、3モデル構成ごと迂回して素の Anthropic SDK + Sonnet に復帰する(§8 退避路)。
- メインのモデル ID を Sonnet に保つ限り「メインは実質 Claude」を維持。Pi 経由 Sonnet に問題が出たら provider を `claude` に切り替えれば SDK ネイティブ Sonnet に戻る。

---

## 6. AMCP mediator 層の実装ポイント(確保のみ。実装はしない)

将来 AMCP(AI Mediated Component Protocol)の mediator 層を差し込む場所を、フェーズ1の時点で**空けておく**。

- Pi `Agent` の **`beforeToolCall` / `afterToolCall` フック**がその場所。これは agent-core の `AgentLoopConfig` に正式定義されたフックで、ツール実行の前後で `block` / 結果の `content`・`details`・`isError`・`terminate` の上書きができる。Claude SDK の PreToolUse/PostToolUse より表現力が高い。
- `PiProvider` 構築時に `beforeToolCall` / `afterToolCall` を**受け取れる引数として用意しておく**(フェーズ1ではパススルー = 何もしない実装でよい)。
- 将来、AMCP の IEDI レコード(Intent-Evidence-Delta-Insight)は `afterToolCall` の戻り値 `details` に構造化して載せる想定。三実行モード(autonomous/cooperative/delighted)は `beforeToolCall` の `block`/`reason` と組み合わせて表現する想定。
- **このドキュメントの範囲ではフックの中身は実装しない**。空のフック点を残すことだけが要件。

---

## 7. 依存とビルド上の注意

- container は **bun で TS を直接実行**(`tsc` ビルドなし、`mcp-tools/index.ts` も bun 起動)。Pi パッケージも bun で読める前提。
- `package.json`(`container/agent-runner/package.json`)に依存追加:
  - `@mariozechner/pi-agent-core`(必須・軽い)
  - `@mariozechner/pi-ai`(agent-core の依存として入る。LLM 接続に必要)
  - `@mariozechner/pi-coding-agent`(ツール cherry-pick のため。**ただし named import のみ**で UI を引き込まない)
- **バージョンは `0.73.1` に完全固定する(キャレット `^` を使わない)**。Pi はまだ 0.x 系で、semver 上マイナー更新でも破壊的変更があり得る(実際に `@mariozechner/pi-agent-old` という旧 agent 層の残骸があり、内部 API は流動的)。`package.json` には `"@mariozechner/pi-agent-core": "0.73.1"` のように完全固定で書き、ロックファイル(`bun.lock`)でも固定すること。**Pi の更新は自動で拾わず、§11 の手順に従って手動・意図的に行う**。
- **イメージ肥大に注意**: coding-agent は photon-node 等の native 依存を持つ。ツール関数だけ使う前提でも依存ツリーには入る。肥大が問題なら、Bash だけは coding-agent を使わず NanoClaw 既存の bash 経路を薄く `defineTool` する代替も検討(container はもともと bash 実行可能)。これは §11 の「coding-agent からの撤退路」とも繋がる。

---

## 8. テストと検証(各フェーズの完了条件)

### フェーズ1 完了条件
1. 既存の `claude` provider が**従来どおり**動く(回帰なし)。`scripts/test-v2-agent.ts` 等の既存テストが通ること。
2. ある group の `container_configs.provider` を `pi` に設定すると、その group が Pi で起動する。
3. Pi group で以下が動く:
   - ファイル操作(Read/Write/Edit)とシェル(Bash)
   - NanoClaw 組み込みツール(最低でも `ask_user_question` のブロッキング往復、`schedule_task` の登録)
   - `init` で continuation が返り、`result` で最終応答が返る
   - 長いツール実行中に idle kill されない(activity マッピングの検証)
4. `claude` group と `pi` group を**併存**させて両方応答する。

### フェーズ1-2 完了条件
1. Pi group で `web_search` / `web_fetch` が動く。
2. Pi group で `Task`(単一サブエージェント)が動き、子エージェントの結果が親に集約される。
3. フェーズ1の全項目に回帰がない。

### 検証の進め方(自己改善ループ)
- `mock` provider と既存テスト(`providers/factory.test.ts`, `providers/*.test.ts`, `poll-loop.test.ts`)の構造を踏襲し、`pi` provider 用のユニットテストを追加する。
- まず `mock` をコピーして `pi` を「canned response を返すだけ」で登録 → factory/barrel/DB 解決の配線が通ることを確認 → そこから中身を Pi 実装に差し替える、という順で進める(失敗しても DB の provider 名を戻すだけで素の状態に復帰できる)。

### 回帰スイートの固定(Pi 更新時の防波堤)
- `pi.test.ts` には、4つの継ぎ目(§3)の挙動を最小で押さえる回帰テストを**固定で**置く。最低限カバーすべき項目:
  1. `init` で continuation(sessionId)が返る
  2. 何らかの Pi イベントごとに `activity` が yield される(idle kill 防止の検証)
  3. cherry-pick したツール(最低 Read/Bash)が呼び出せる
  4. 最終応答が `result` で返る
- これは「機能テスト」であると同時に「**Pi をバージョンアップしたときに何が割れたかを即座に検出するためのスイート**」を兼ねる。§11 の更新手順から必ず参照される。Pi の内部 API(イベント型・ツール関数シグネチャ・`Agent` API)に依存している以上、このスイートが破壊的変更の最初の検知点になる。

---

## 9. 触ってよい / 触ってはいけないファイル

### 新規作成
- `container/agent-runner/src/providers/pi.ts`(本体)
- `container/agent-runner/src/providers/pi.test.ts`(テスト。**§11 の Pi バージョン更新時に必ず回す回帰スイートを兼ねる**)
- (必要なら)`src/providers/pi.ts`(host 側の追加マウント/env。不要なら作らない)

### 追記のみ(最小変更)
- `container/agent-runner/src/providers/index.ts` に `import './pi.js';`
- `container/agent-runner/src/mcp-tools/server.ts` に `getRegisteredTools()` 関数を1つ追記(§4 参照。`registerTools` / `startMcpServer` は変更しない)
- (host 側登録が必要な場合のみ)`src/providers/index.ts` に `import './pi.js';`
- `container/agent-runner/package.json` に Pi 依存3つ

### 参照(変更しない)
- `container/agent-runner/src/providers/types.ts`(インターフェース定義)
- `container/agent-runner/src/providers/mock.ts`(ひな形)
- `container/agent-runner/src/providers/claude.ts`(対応する SDK 実装の参照。**変更禁止**)
- `container/agent-runner/src/poll-loop.ts`(コア。**変更禁止**)
- `container/agent-runner/src/mcp-tools/core.ts` / `scheduling.ts` / `interactive.ts` / `agents.ts`(ラップ対象のツール実体。Pi からは個別に import する。`index.ts` は import 禁止 ── §4 参照)

### 絶対に壊さない
- `claude` provider の経路全体。既存テストの回帰を出さないこと。

---

## 10. 作業順サマリ

0. `git fetch origin providers` で参照 provider を取得し、`opencode.ts`(container/host 両側)と `mcp-to-opencode.ts` を読む。opencode を骨格の主たる手本にする(ただし §3 の「子プロセス方式は真似ない」「idle 監視は移植価値あり」、§4 の「MCP 定義翻訳は Pi に使えない」に注意)。
1. `pi.ts` を `mock` ベースで作り、`registerProvider('pi', ...)` + barrel import を通す。factory/DB 解決の配線確認。
2. Pi の `Agent` を組み込み、4つの継ぎ目(§3)を実装。まず Read/Write/Edit/Bash の cherry-pick ツールだけで最小応答を通す。
3. `mcp-tools/server.ts` に `getRegisteredTools()` を追記し、個別ツールモジュールを直接インポートして NanoClaw 組み込みツールを `AgentTool` ラップ(§4)。`ask_user_question` のブロッキングと `schedule_task` の host 連携を維持。`toolsConfig.allowed` フィルタリングを Pi ツールリストに適用(`DESIGN-phase1-group-config.md` 参照)。
4. `beforeToolCall`/`afterToolCall` の空フック点を確保(§6)。
5. フェーズ1完了条件(§8)を満たす。`claude` 併存を確認。
6. (フェーズ1-2)`web_search`/`web_fetch` を自前 `AgentTool` で追加。
7. (フェーズ1-2)`Task` を子 `Agent` 起動ツールとして追加。
8. フェーズ1-2完了条件(§8)を満たす。

---

## 11. 更新への追従方針

### 前提: 更新耐性は非対称
- **NanoClaw の更新には強い**。乗っているのは `AgentProvider` という公開・安定インターフェース(NanoClaw 自身が「provider 追加用の拡張点」として用意したもの)で、接触面は薄い1枚。新 provider 追加でコアにも `claude` provider にも触らないため、NanoClaw 本体が更新されても `pi.ts` は基本そのまま動く。
- **Pi の更新には相対的に弱い**。依存しているのは Pi の公開安定面ではなく**内部実装**(個別ツール関数 `createReadTool` 等、`AgentEvent` ユニオン型、`Agent` の `steer`/`followUp`/`subscribe` API、`beforeToolCall`/`afterToolCall` の型)で、Pi はまだ 0.x 系。接触面も広い。
- ただし**被害は局所化されている**。Pi の更新で何かが割れても影響範囲は `pi.ts` の中だけで、NanoClaw コアにも `claude` provider にも波及しない。最悪の場合は DB の provider 名を `claude` に戻せば素の動作環境に即復帰できる(§8 の退避路がそのまま Pi 障害時の避難所になる)。

### 採用済みの対策(本ドキュメントで実装する)
1. **バージョン完全固定**(§7)。Pi は `0.73.1` 固定。キャレットを使わず、ロックファイルでも固定。更新は自動で拾わない。
2. **回帰スイート固定**(§8)。`pi.test.ts` が4つの継ぎ目を押さえ、Pi 更新時に何が割れたかの最初の検知点になる。

### Pi をバージョンアップするときの手順
1. 現行(`0.73.1`)で `pi.test.ts` を含む全テストが緑であることを確認。
2. Pi 3パッケージのバージョンを**同時に**上げる(`pi-ai` / `pi-agent-core` / `pi-coding-agent` はバージョンを揃える)。完全固定値を書き換え、ロックファイルを更新。
3. `pi.test.ts`(回帰スイート)を回す。割れた箇所が、その更新で変わった内部 API を指す。
4. 割れた接触面を `pi.ts` 内で修正する。**`claude.ts` / `poll-loop.ts` / コアは触らない**(更新作業でもこの不変条件は保つ)。
5. 直らない/影響が大きい場合は、固定値を `0.73.1` に戻して素の状態へ退避し、原因を切り分けてから再挑戦する。
6. 更新を取り込んだら、検証済みバージョンを §7 に追記して記録を残す。

---

## 12. 今後の検討項目(本ドキュメントの範囲外・将来タスク)

以下は現時点では実装しない。Pi 更新の追従負担が実際に問題化したとき、あるいはフェーズ2以降で着手する候補として記録しておく。

### 12.1 Pi adapter 層の隔離
- **目的**: Pi の内部 API への接触面を `pi.ts` の中でさらに1枚薄い層(Pi adapter)に集約し、Pi 更新時の修正範囲を adapter 内に閉じ込める。
- **方針**: Pi に直接触るコード(`AgentEvent` → `ProviderEvent` 変換、ツールの cherry-pick、`Agent` の構築、フックの配線)をすべて adapter 経由にする。`PiProvider` 本体は adapter のインターフェースだけに依存させる。
- **効果**: NanoClaw が `AgentProvider` でやっている「公開インターフェースの裏に実装を隠す」構造を、Pi に対してももう一段適用する形。Pi が更新されたとき直すのは adapter の中だけで、`PiProvider` のロジックは無傷で済む。
- **判断材料**: フェーズ1〜2を素朴な実装で進めてみて、Pi 更新で実際に割れる箇所が広いと分かった時点で導入する。最初から作り込むと過剰設計になり得るので、痛みが出てから入れる。

### 12.2 coding-agent からの撤退路
- **背景**: 本当に依存したい中核は **agent-core(エージェントループ + フック)** であり、coding-agent のツール実体は「借りているだけ」。agent-core の依存は `pi-ai` と `typebox` のみで接触面が狭く、更新耐性が高い。一方 coding-agent は依存が重く(photon-node 等)、接触面も広い。
- **撤退路**: coding-agent 側の更新追従が重荷になった場合、cherry-pick していたツールを**自前の `defineTool` 実装に置き換え、coding-agent への依存を切って agent-core だけに絞る**。
- **段階的縮退**: 全撤退でなくてもよい。§7 に記載の「Bash だけ自前実装」を一般化し、更新で割れやすい/依存が重いツールから順に自前実装へ置き換えていく部分撤退も可能。
- **効果**: 依存を agent-core のみに絞れば、Pi 更新の影響範囲はさらに小さくなる。ミニマル化の最終形にも近づく。
- **判断材料**: coding-agent のツール群が Pi 更新のたびに割れる、あるいはイメージ肥大(§7)が許容できない、のいずれかが顕在化したときに着手する。
