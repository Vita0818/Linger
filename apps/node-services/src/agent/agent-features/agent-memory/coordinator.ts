import {
  decodeExecutionContextKey,
  type ExecutionContextRef,
} from "../../executor/context-ref.js";
import type { Ghost } from "../../executor/ghost.js";
import type {
  RuntimeHistoryJsonValue,
  RuntimeHistoryOptions,
  RuntimeHistoryRecord,
  RuntimeHistoryInspection,
} from "../../executor/history.js";
import type { AgentId } from "../../executor/types.js";
import type { LocalRuntimeSettings } from "../../runtime-settings.js";
import type { TeamHubRuntimeStateClient } from "../../executor/teamhub-runtime-state-client.js";
import type { AgentLogger } from "../../observability/agent-log.js";
import { ModelCallError, type ModelCall } from "../../../runtime-model-call.js";
import type { MemoryClient, MemoryDocument } from "./client.js";
import { memoryInstructions, memoryOutputSchema } from "./prompts.js";
import {
  applyMemoryEdits,
  InvalidMemoryOutputError,
  memorySectionHeadings,
} from "./sections.js";
import { sha256Hex } from "@linger/service-kit/node";

// A failed maintenance step waits before retrying: 1, 2, 4, 8 minutes, then
// opens the circuit breaker to avoid hammering an unavailable model.
const RETRY_BASE_MS = 60_000;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 6 * 60 * 60_000;
const STAGE_TIMEOUT_MS = { extract: 5 * 60_000, consolidate: 10 * 60_000 };
// Passes whose stage call fails past its own attempts with an invalid or
// timed-out output, allowed per stage before maintenance stops for the Agent.
const MAX_STAGE_ATTEMPTS = 3;
// Extraction shares the model with the conversation it reads, so it waits
// for this many succeeded Meta Runs instead of following every one.
const RUNS_PER_EXTRACTION = 5;
// Consolidation sends the whole memory to the model. As in Codex, it waits until the
// Agent has had no succeeded Run for this long. Every consolidation needs a
// later Run to become due again, so this also spaces consolidations apart.
const IDLE_BEFORE_CONSOLIDATION_MS = 6 * 60 * 60_000;
// Waiting candidates past this size, or in every session slot, are
// consolidated before more are extracted, so an Agent that is never idle
// stays within the document limits.
const MAX_WAITING_CANDIDATE_BYTES = 64_000;
const MAX_SESSIONS = 30;
// Memory sources are the conversation and its tool traffic. Usage, lifecycle,
// reasoning and provider events add no fact (Codex repeats every item as a
// provider event), and a compaction summary restates earlier records.
const SOURCE_CATEGORIES: ReadonlySet<RuntimeHistoryRecord["category"]> =
  new Set(["message", "tool_call", "tool_result"]);
// A longer string, typically a file or page a tool returned, keeps its head.
const MAX_SOURCE_TEXT = 4_000;
// A stage's input, instructions included, takes half of the Agent model's
// context window using a conservative UTF-8 bytes-per-token ratio (1.5) so
// dense CJK and JSON transcripts stay below the window. The other half holds
// the Runtime's own prompt, output schema, output, and reasoning tokens. When
// the window is unknown (for example BYOK or local servers that omit
// context_length), assume a conservative 65,536-token context window rather
// than the 400 KB ceiling.
const WINDOW_INPUT_SHARE = 0.5;
const BYTES_PER_TOKEN = 1.5;
const DEFAULT_CONTEXT_WINDOW = 65_536;
const MAX_INPUT_BYTES = 400_000;
const MAX_EXTRACTION_RECORD_BYTES = 250_000;
const MAX_MEMORY_BYTES = 200_000;
const MIN_SHRINK_INPUT_BYTES = 4_096;
const MAX_SHRINK_STEPS_PER_PASS = 4;

export interface MemoryBudget {
  /** One stage's input, instructions included. */
  readonly input: number;
  /** The Memory a consolidation may produce: at most half of its input, so
   * candidates always have room beside it. */
  readonly memory: number;
}

export function memoryBudget(
  contextWindow: number | undefined,
  adaptiveInputBytes?: number,
): MemoryBudget {
  const effectiveWindow = contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const windowInput = Math.min(
    MAX_INPUT_BYTES,
    Math.floor(effectiveWindow * WINDOW_INPUT_SHARE * BYTES_PER_TOKEN),
  );
  const input =
    adaptiveInputBytes === undefined
      ? windowInput
      : Math.max(
          MIN_SHRINK_INPUT_BYTES,
          Math.min(windowInput, adaptiveInputBytes),
        );
  return {
    input,
    memory: Math.min(MAX_MEMORY_BYTES, Math.floor(windowInput / 2)),
  };
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * `resume` only finishes a pending stage, `extract` also reads new history,
 * and `consolidate` then merges every waiting candidate once.
 */
type PassMode = "resume" | "extract" | "consolidate";

function clip(
  value: RuntimeHistoryJsonValue,
  maxText = MAX_SOURCE_TEXT,
): RuntimeHistoryJsonValue {
  if (typeof value === "string")
    return value.length > maxText
      ? `${value.slice(0, maxText)}… [${value.length - maxText} characters omitted]`
      : value;
  if (Array.isArray(value)) return value.map((item) => clip(item, maxText));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clip(item, maxText)]),
    );
  return value;
}

function clipStringToBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (bytes(value) <= maxBytes) return value;
  const suffix = "… [omitted]";
  const suffixBytes = bytes(suffix);
  if (maxBytes <= suffixBytes) return "";
  const budget = maxBytes - suffixBytes;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (bytes(value.slice(0, mid)) <= budget) low = mid;
    else high = mid - 1;
  }
  let end = low;
  if (end > 0) {
    const lastCode = value.charCodeAt(end - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1;
  }
  return `${value.slice(0, end)}${suffix}`;
}

/**
 * Fits a string so its JSON-encoded representation (`JSON.stringify(value)`)
 * uses at most `maxJsonBytes`.
 */
function clipJsonStringToBytes(value: string, maxJsonBytes: number): string {
  if (maxJsonBytes <= 2) return "";
  if (bytes(JSON.stringify(value)) <= maxJsonBytes) return value;
  let bound = Math.max(0, maxJsonBytes - 2);
  let candidate = clipStringToBytes(value, bound);
  while (
    candidate.length > 0 &&
    bytes(JSON.stringify(candidate)) > maxJsonBytes
  ) {
    bound = Math.floor(bound * 0.75);
    candidate = clipStringToBytes(value, bound);
  }
  return candidate;
}

const MEMORY_SECTION_HEADING = /^## +(.*\S)\s*$/u;
const MEMORY_FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const MEMORY_OMITTED_MARKER =
  "[earlier memory sections omitted to fit context budget]\n\n";

/**
 * Trims markdown memory to fit within `maxJsonBytes` (as a JSON string),
 * preserving the most recent `## ` sections when possible.
 */
function clipMemoryToJsonBytes(memory: string, maxJsonBytes: number): string {
  if (maxJsonBytes <= 2) return "";
  if (bytes(JSON.stringify(memory)) <= maxJsonBytes) return memory;
  const sections: string[][] = [];
  let fence: string | undefined;
  for (const line of memory.split("\n")) {
    const marker = MEMORY_FENCE.exec(line)?.[1];
    if (marker && (!fence || marker.startsWith(fence)))
      fence = fence ? undefined : marker;
    const isHeading = !fence && !marker && MEMORY_SECTION_HEADING.test(line);
    if (isHeading) sections.push([line]);
    else if (sections.length > 0) sections.at(-1)!.push(line);
  }
  if (sections.length > 1) {
    const kept: string[] = [];
    for (let i = sections.length - 1; i >= 0; i -= 1) {
      const candidate =
        MEMORY_OMITTED_MARKER + [sections[i]!.join("\n"), ...kept].join("\n");
      if (bytes(JSON.stringify(candidate)) > maxJsonBytes) break;
      kept.unshift(sections[i]!.join("\n"));
    }
    if (kept.length > 0) {
      return MEMORY_OMITTED_MARKER + kept.join("\n");
    }
  }
  return clipJsonStringToBytes(memory, maxJsonBytes);
}

interface PreviousMemory {
  summary: string;
  memory: string;
}

/**
 * Trims `previous.summary` and `previous.memory` so `JSON.stringify(result)`
 * fits within `maxBytes`.
 */
function fitPreviousMemory(
  previous: PreviousMemory,
  maxBytes: number,
): PreviousMemory {
  if (bytes(JSON.stringify(previous)) <= maxBytes) return previous;
  const emptyShell = bytes(JSON.stringify({ summary: "", memory: "" }));
  if (maxBytes <= emptyShell) return { summary: "", memory: "" };
  const contentBudget = maxBytes - emptyShell;
  const summaryBudget = Math.min(
    bytes(JSON.stringify(previous.summary)),
    Math.max(2, Math.floor(contentBudget / 4) + 2),
  );
  const summary = clipJsonStringToBytes(previous.summary, summaryBudget);
  const usedBySummary = bytes(JSON.stringify(summary)) - 2;
  const memoryJsonBudget = Math.max(2, contentBudget - usedBySummary + 2);
  const memory = clipMemoryToJsonBytes(previous.memory, memoryJsonBudget);
  return { summary, memory };
}

/**
 * Progressively clips a single history record's text fields until its
 * serialized JSON fits within maxBytes, or returns undefined if even the
 * record skeleton exceeds maxBytes.
 */
function fitRecordToBytes(
  record: RuntimeHistoryRecord,
  maxBytes: number,
): RuntimeHistoryRecord | undefined {
  if (maxBytes <= 0) return undefined;
  if (bytes(JSON.stringify(record)) <= maxBytes) return record;
  for (const limit of [2_000, 1_000, 500, 250, 128, 64, 0]) {
    const candidate: RuntimeHistoryRecord = {
      ...record,
      nativeRecord: clip(
        record.nativeRecord,
        limit,
      ) as RuntimeHistoryRecord["nativeRecord"],
    };
    if (bytes(JSON.stringify(candidate)) <= maxBytes) return candidate;
  }
  return undefined;
}

type PendingStage = NonNullable<MemoryDocument["pending"]>;

interface ExtractPayload {
  source_context: string;
  previous: string | null;
  records: RuntimeHistoryRecord[];
}

interface ConsolidateExtraction {
  key: string;
  context_key: string;
  summary: string;
  raw_memory: string;
}

interface ConsolidatePayload {
  previous: PreviousMemory;
  memory_sections: string[];
  extractions: ConsolidateExtraction[];
}

function fitExtractionToBytes(
  extraction: ConsolidateExtraction,
  maxBytes: number,
): ConsolidateExtraction {
  if (bytes(JSON.stringify(extraction)) <= maxBytes) return extraction;
  const emptyShell = bytes(
    JSON.stringify({ ...extraction, summary: "", raw_memory: "" }),
  );
  if (maxBytes <= emptyShell)
    return { ...extraction, summary: "", raw_memory: "" };
  const contentBudget = maxBytes - emptyShell;
  const summaryBudget = Math.min(
    bytes(JSON.stringify(extraction.summary)),
    Math.max(2, Math.floor(contentBudget / 3) + 2),
  );
  const summary = clipJsonStringToBytes(extraction.summary, summaryBudget);
  const usedBySummary = bytes(JSON.stringify(summary)) - 2;
  const rawMemoryBudget = Math.max(2, contentBudget - usedBySummary + 2);
  const raw_memory = clipJsonStringToBytes(
    extraction.raw_memory,
    rawMemoryBudget,
  );
  return { ...extraction, summary, raw_memory };
}

function parseExtractPayload(prompt: string): ExtractPayload | undefined {
  try {
    const parsed = JSON.parse(prompt) as ExtractPayload;
    if (!Array.isArray(parsed.records)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function shrinkPendingStage(
  pending: PendingStage,
  targetPromptBytes: number,
  forceHalve: boolean,
): PendingStage | undefined {
  const beforeBytes = bytes(pending.prompt);
  if (!forceHalve && beforeBytes <= targetPromptBytes) return undefined;
  const target = Math.max(
    512,
    forceHalve
      ? Math.min(targetPromptBytes, Math.floor(beforeBytes / 2))
      : targetPromptBytes,
  );
  if (pending.stage === "extract") {
    const parsed = parseExtractPayload(pending.prompt);
    if (!parsed || parsed.records.length === 0) return undefined;
    const previous =
      typeof parsed.previous === "string"
        ? clipStringToBytes(parsed.previous, Math.floor(target / 3))
        : null;
    const shellBytes = bytes(
      JSON.stringify({
        source_context: parsed.source_context,
        previous,
        records: [],
      }),
    );
    const recordRoom = Math.max(0, target - shellBytes);
    if (parsed.records.length > 1) {
      const maxRecords = forceHalve
        ? Math.max(1, Math.floor(parsed.records.length / 2))
        : parsed.records.length;
      const kept: RuntimeHistoryRecord[] = [];
      let size = 0;
      for (const record of parsed.records.slice(0, maxRecords)) {
        const nextBytes = bytes(JSON.stringify(record)) + (kept.length ? 1 : 0);
        if (size + nextBytes > recordRoom) break;
        kept.push(record);
        size += nextBytes;
      }
      if (kept.length === 0) {
        const fitted = fitRecordToBytes(parsed.records[0]!, recordRoom);
        if (!fitted) return undefined;
        kept.push(fitted);
      }
      const nextPrompt = JSON.stringify({
        source_context: parsed.source_context,
        previous,
        records: kept,
      });
      if (bytes(nextPrompt) >= beforeBytes) return undefined;
      return {
        ...pending,
        prompt: nextPrompt,
        through: kept.at(-1)!.ordinal,
      };
    }
    const single = parsed.records[0]!;
    const currentRecordBytes = bytes(JSON.stringify(single));
    const shrunkRecordRoom = Math.min(
      recordRoom,
      Math.max(256, Math.floor(currentRecordBytes / 2)),
    );
    const fitted = fitRecordToBytes(single, shrunkRecordRoom);
    if (!fitted) return undefined;
    const nextPrompt = JSON.stringify({
      source_context: parsed.source_context,
      previous,
      records: [fitted],
    });
    if (bytes(nextPrompt) >= beforeBytes) return undefined;
    return { ...pending, prompt: nextPrompt };
  }

  let parsed: ConsolidatePayload;
  try {
    parsed = JSON.parse(pending.prompt) as ConsolidatePayload;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed.extractions) || parsed.extractions.length === 0) {
    return undefined;
  }
  const baseShellBytes = bytes(
    JSON.stringify({
      previous: { summary: "", memory: "" },
      memory_sections: parsed.memory_sections,
      extractions: [],
    }),
  );
  const emptyPrevBytes = bytes(JSON.stringify({ summary: "", memory: "" }));
  const totalRoom = Math.max(0, target - baseShellBytes + emptyPrevBytes);
  const currentPrevBytes = bytes(JSON.stringify(parsed.previous));

  if (parsed.extractions.length > 1) {
    const maxExtractions = forceHalve
      ? Math.max(1, Math.floor(parsed.extractions.length / 2))
      : parsed.extractions.length;
    const prevBudget = Math.min(
      currentPrevBytes,
      Math.max(emptyPrevBytes, Math.floor((totalRoom * 2) / 3)),
    );
    const nextPrevious = fitPreviousMemory(parsed.previous, prevBudget);
    const shellWithPrev = bytes(
      JSON.stringify({
        previous: nextPrevious,
        memory_sections: parsed.memory_sections,
        extractions: [],
      }),
    );
    const extractionRoom = Math.max(0, target - shellWithPrev);
    const kept: ConsolidateExtraction[] = [];
    let size = 0;
    for (const extraction of parsed.extractions.slice(0, maxExtractions)) {
      const nextBytes =
        bytes(JSON.stringify(extraction)) + (kept.length ? 1 : 0);
      if (size + nextBytes > extractionRoom) break;
      kept.push(extraction);
      size += nextBytes;
    }
    if (kept.length === 0) {
      kept.push(fitExtractionToBytes(parsed.extractions[0]!, extractionRoom));
    }
    const nextPrompt = JSON.stringify({
      previous: nextPrevious,
      memory_sections: parsed.memory_sections,
      extractions: kept,
    });
    if (bytes(nextPrompt) >= beforeBytes) return undefined;
    return { ...pending, prompt: nextPrompt };
  }

  const sole = parsed.extractions[0]!;
  const currentSoleBytes = bytes(JSON.stringify(sole));
  const halfRoom = Math.floor(totalRoom / 2);
  let prevRoom = Math.min(currentPrevBytes, halfRoom);
  const soleRoom = Math.min(currentSoleBytes, totalRoom - prevRoom);
  if (soleRoom < totalRoom - prevRoom) {
    prevRoom = Math.min(currentPrevBytes, totalRoom - soleRoom);
  }
  const nextPrevious = fitPreviousMemory(
    parsed.previous,
    Math.max(emptyPrevBytes, prevRoom),
  );
  const shellWithPrev = bytes(
    JSON.stringify({
      previous: nextPrevious,
      memory_sections: parsed.memory_sections,
      extractions: [],
    }),
  );
  const remainingForSole = Math.max(0, target - shellWithPrev);
  const nextSole = fitExtractionToBytes(sole, remainingForSole);
  const nextPrompt = JSON.stringify({
    previous: nextPrevious,
    memory_sections: parsed.memory_sections,
    extractions: [nextSole],
  });
  if (bytes(nextPrompt) >= beforeBytes) return undefined;
  return { ...pending, prompt: nextPrompt };
}

interface AdaptiveInputCap {
  readonly bytes: number;
  readonly window: number | undefined;
}

/**
 * Narrow host capability the maintenance Coordinator needs: Ghost lookup for
 * Runtime placement and Meta Context history reads. Maintenance itself runs
 * as stateless model calls, never as a Context or Run.
 */
export interface AgentMemoryHost {
  getGhost(
    agentId: AgentId,
  ): Promise<Readonly<Ghost<LocalRuntimeSettings>> | null>;
  inspectDebugContextHistory(
    ref: ExecutionContextRef,
    options: RuntimeHistoryOptions,
  ): Promise<RuntimeHistoryInspection>;
}

/** Reconciles derived memory through stateless model calls; never a Run. */
export class AgentMemoryCoordinator {
  readonly #stop = new AbortController();
  readonly #running = new Map<string, Promise<void>>();
  readonly #backoff = new Map<
    string,
    { until: number; failures: number; circuitOpen: boolean }
  >();
  // Learned per-Agent input byte ceiling after a confirmed invalid_request
  // context-overflow failure. Reset when contextWindow changes and gradually
  // relaxed after clean passes without shrinks.
  readonly #adaptiveInputBytes = new Map<string, AdaptiveInputCap>();
  // Meta Context input positions an Agent was last fully caught up to. A
  // scan skips the Agent until one of them receives new input.
  readonly #settled = new Map<string, string>();
  // Scheduling state is kept in process only. After a restart the Run count
  // starts from zero, and waiting candidates count from the first scan.
  // Succeeded Meta Runs since the Agent's last extracting pass.
  readonly #runs = new Map<string, number>();
  // When an Agent with unconsolidated work last finished a succeeded Run.
  readonly #lastRunAt = new Map<string, number>();
  readonly #timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly options: {
      host: AgentMemoryHost;
      runtimeState: TeamHubRuntimeStateClient;
      memory: MemoryClient;
      modelCall: ModelCall;
      logger: Pick<AgentLogger, "log">;
      /**
       * Whether a Local Computer is online and can serve this Runtime's
       * history now. Maintenance never wakes or waits for a Computer.
       */
      canReadHistory?: (
        computerId: string,
        runtimeType: "codex" | "claude" | "pi",
      ) => boolean;
      now?: () => number;
    },
  ) {
    // Run terminals (recordRun) and compaction starts (wake) arrive through
    // the Context feature ports; no self-managed subscription here.
    this.#timer = setInterval(() => {
      void this.reconcile();
    }, 30_000);
    this.#timer.unref();
  }

  async reconcile(): Promise<void> {
    if (this.#stop.signal.aborted) return;
    try {
      const contexts = await this.options.runtimeState.listContexts(
        undefined,
        this.#stop.signal,
      );
      const inputs = new Map<string, string[]>();
      for (const context of contexts) {
        const positions = inputs.get(context.ref.agent_id) ?? [];
        if (context.ref.kind === "meta" && !context.terminal_reason)
          positions.push(
            `${context.context_key}:${context.next_input_sequence}`,
          );
        inputs.set(context.ref.agent_id, positions);
      }
      await Promise.all(
        [...inputs].map(([id, positions]) => {
          const signature = positions.sort().join("\n");
          return this.#settled.get(id) === signature &&
            !this.#extractionDue(id) &&
            !this.#consolidationDue(id)
            ? Promise.resolve()
            : this.#wake(id, signature);
        }),
      );
    } catch (error) {
      this.#log(error);
    }
  }

  /**
   * Counts one succeeded Meta Run: extraction starts once enough add up, and
   * consolidation waits for the Agent to stay idle after it.
   */
  recordRun(agentId: string): Promise<void> {
    this.#runs.set(agentId, (this.#runs.get(agentId) ?? 0) + 1);
    this.#lastRunAt.set(agentId, this.#now());
    // A succeeded Run proves the Agent's model is healthy again, so reopen
    // maintenance if the circuit breaker had paused it.
    if (this.#backoff.get(agentId)?.circuitOpen) this.#backoff.delete(agentId);
    return this.#extractionDue(agentId)
      ? this.#wake(agentId)
      : Promise.resolve();
  }

  /** Extracts and consolidates now, without waiting for Runs or idleness. */
  wake(agentId: string): Promise<void> {
    return this.#wake(agentId, undefined, true);
  }

  #extractionDue(agentId: string): boolean {
    return (this.#runs.get(agentId) ?? 0) >= RUNS_PER_EXTRACTION;
  }

  #consolidationDue(agentId: string): boolean {
    const lastRunAt = this.#lastRunAt.get(agentId);
    return (
      lastRunAt !== undefined &&
      this.#now() - lastRunAt >= IDLE_BEFORE_CONSOLIDATION_MS
    );
  }

  #wake(agentId: string, signature?: string, force = false): Promise<void> {
    if (this.#stop.signal.aborted) return Promise.resolve();
    const running = this.#running.get(agentId);
    if (running) return running;
    const backoff = this.#backoff.get(agentId);
    if (backoff && backoff.until > this.#now()) return Promise.resolve();
    const runs = this.#runs.get(agentId) ?? 0;
    const lastRunAt = this.#lastRunAt.get(agentId);
    const mode: PassMode =
      force || this.#consolidationDue(agentId)
        ? "consolidate"
        : runs >= RUNS_PER_EXTRACTION
          ? "extract"
          : "resume";
    const work = this.#advance(agentId, mode)
      .then((settled) => {
        this.#backoff.delete(agentId);
        if (settled && signature !== undefined)
          this.#settled.set(agentId, signature);
        else this.#settled.delete(agentId);
        if (settled && mode !== "resume") {
          // Runs that finished during this pass count toward the next one.
          const left = (this.#runs.get(agentId) ?? 0) - runs;
          if (left > 0) this.#runs.set(agentId, left);
          else this.#runs.delete(agentId);
        }
        // History left unread by this pass waits for the next Run, so an
        // offline Computer is not retried every scan.
        if (
          mode === "consolidate" &&
          this.#lastRunAt.get(agentId) === lastRunAt
        )
          this.#lastRunAt.delete(agentId);
      })
      .catch((error) => {
        this.#settled.delete(agentId);
        const failures = (backoff?.failures ?? 0) + 1;
        const circuitOpen = failures >= CIRCUIT_BREAKER_THRESHOLD;
        const delay = circuitOpen
          ? CIRCUIT_COOLDOWN_MS
          : RETRY_BASE_MS * 2 ** (failures - 1);
        this.#backoff.set(agentId, {
          failures,
          until: this.#now() + delay,
          circuitOpen,
        });
        if (circuitOpen && !backoff?.circuitOpen)
          this.options.logger.log("warn", "agent_memory.circuit_opened", {
            agentId,
            failures,
            cooldown_ms: CIRCUIT_COOLDOWN_MS,
            error: String(error),
          });
        this.#log(error, agentId);
      })
      .finally(() => this.#running.delete(agentId));
    this.#running.set(agentId, work);
    return work;
  }

  async close(): Promise<void> {
    clearInterval(this.#timer);
    this.#stop.abort();
    await Promise.all(this.#running.values());
  }

  /**
   * Resolves true only when every Meta Context was read and nothing is left to
   * do. An extracting pass reads every batch its Contexts held when it began;
   * a consolidating pass then merges the waiting candidates once.
   */
  async #advance(agentId: string, mode: PassMode): Promise<boolean> {
    const { host, runtimeState, memory } = this.options;
    const signal = this.#stop.signal;
    const ghost = await host.getGhost(agentId);
    if (!ghost) {
      // Ghost store maps only HTTP 404 to null (teamhub-ghost-store.ts get catch + isNotFound).
      this.options.logger.log("info", "agent_memory.settled_config_gone", {
        agentId,
        status: 404,
      });
      return true;
    }
    const runtime = ghost.runtime.placement.runtimeType;
    if (runtime !== "codex" && runtime !== "claude" && runtime !== "pi")
      return true;
    const computerId = ghost.runtime.placement.computerId;
    // Both stages run on the Agent's own Computer and Runtime.
    const placement = {
      tenantId: ghost.runtime.placement.tenantId,
      ownerActorId: ghost.runtime.placement.ownerActorId,
      agentId,
      computerId,
      runtimeType: runtime,
    };
    // Looked up once per pass, and only when a stage is built or run. An
    // offline Computer fails the pass as the model call would, so no stage
    // is sized without the window.
    let resolvedWindow: { readonly value: number | undefined } | undefined;
    const budgetOf = async (): Promise<MemoryBudget> => {
      resolvedWindow ??= {
        value: await this.options.modelCall.contextWindow?.(
          { placement },
          signal,
        ),
      };
      const adaptive = this.#adaptiveInputBytes.get(agentId);
      if (adaptive && adaptive.window !== resolvedWindow.value) {
        this.#adaptiveInputBytes.delete(agentId);
      }
      return memoryBudget(
        resolvedWindow.value,
        this.#adaptiveInputBytes.get(agentId)?.bytes,
      );
    };
    let document = await memory.read(agentId, signal);
    // Candidates found waiting after a restart start their idle period now.
    if (
      !this.#lastRunAt.has(agentId) &&
      Object.values(document.sessions).some((session) => session.raw_memory)
    )
      this.#lastRunAt.set(agentId, this.#now());
    // Reading history is not an execution demand: an offline or sleeping
    // Computer is skipped. Pending stages and consolidation need no Computer.
    const readable = this.options.canReadHistory?.(computerId, runtime) ?? true;
    let settled = true;
    let completedStages = 0;
    let hadInvalidRequestShrink = false;
    const relaxAdaptiveCap = (): void => {
      if (completedStages === 0 || hadInvalidRequestShrink) return;
      const adaptive = this.#adaptiveInputBytes.get(agentId);
      if (!adaptive) return;
      const baseInput = memoryBudget(adaptive.window).input;
      const nextBytes = adaptive.bytes * 2;
      if (nextBytes >= baseInput) this.#adaptiveInputBytes.delete(agentId);
      else
        this.#adaptiveInputBytes.set(agentId, {
          bytes: nextBytes,
          window: adaptive.window,
        });
    };
    // The newest record of each Context when this pass first read it. Records
    // written while the pass runs wait for the next one, so a busy
    // conversation cannot keep one pass going.
    const limits = new Map<string, number>();
    for (;;) {
      if (!document.pending) {
        // A pending stage always resumes; new work waits until it is due.
        if (mode === "resume") {
          relaxAdaptiveCap();
          return settled;
        }
        if (!readable) settled = false;
        const waiting = Object.entries(document.sessions).filter(
          ([, session]) => session.raw_memory,
        );
        const full =
          waiting.length >= MAX_SESSIONS ||
          waiting.reduce(
            (total, [, session]) => total + bytes(session.raw_memory),
            0,
          ) > MAX_WAITING_CANDIDATE_BYTES;
        let extracting = false;
        for (const context of full || !readable
          ? []
          : await runtimeState.listContexts(agentId, signal)) {
          if (context.ref.kind !== "meta" || context.terminal_reason) continue;
          // No input yet means no history to read.
          if (context.next_input_sequence === "0") continue;
          if (
            (await runtimeState.getWorkState(context.context_key, signal))
              .has_pending_work
          ) {
            settled = false;
            continue;
          }
          const ref = decodeExecutionContextKey(context.context_key);
          const page = await host.inspectDebugContextHistory(ref, {
            limit: 200,
            signal,
          });
          // Unreadable history waits for the next due pass.
          if (page.status !== "available") continue;
          if (page.snapshot.tailState !== "clean") {
            settled = false;
            continue;
          }
          const sourceKey = sha256Hex(context.context_key);
          const previous = document.sessions[sourceKey]?.summary;
          const cursorState = document.cursors[sourceKey];
          const through =
            cursorState?.thread_id === page.snapshot.threadId
              ? cursorState.through
              : -1;
          const limit =
            limits.get(context.context_key) ??
            page.records.reduce(
              (newest, record) => Math.max(newest, record.ordinal),
              through,
            );
          limits.set(context.context_key, limit);
          let records: RuntimeHistoryRecord[] = [...page.records];
          let cursor = page.previousCursor;
          // Read backwards only as far as the saved watermark. Batches stay bounded;
          // a long session is consumed over several batches rather than silently skipped.
          while (
            cursor &&
            records.every((record) => record.ordinal > through)
          ) {
            const older = await host.inspectDebugContextHistory(ref, {
              cursor,
              limit: 200,
              signal,
            });
            if (
              older.status !== "available" ||
              older.snapshot.id !== page.snapshot.id
            )
              throw new Error("Memory history changed while reading");
            records = [...older.records, ...records];
            cursor = older.previousCursor;
          }
          // Developer and system messages carry the Agent's configuration.
          records = records
            .filter(
              (record) =>
                record.ordinal > through &&
                record.ordinal <= limit &&
                SOURCE_CATEGORIES.has(record.category) &&
                record.role !== "developer" &&
                record.role !== "system",
            )
            .map((record) => ({
              ...record,
              nativeRecord: clip(
                record.nativeRecord,
              ) as RuntimeHistoryRecord["nativeRecord"],
            }))
            .sort((a, b) => a.ordinal - b.ordinal);
          if (
            !records.some(
              (record) =>
                record.category === "message" ||
                record.category === "tool_result",
            )
          )
            continue;
          // The records share the input with the instructions, schema, and the
          // previous summary.
          const currentBudget = await budgetOf();
          const extractOverhead =
            bytes(memoryInstructions("extract", currentBudget.memory)) +
            bytes(JSON.stringify(memoryOutputSchema("extract")));
          const available = Math.max(0, currentBudget.input - extractOverhead);
          const clippedPrevious =
            previous === undefined
              ? null
              : clipStringToBytes(previous, Math.floor(available / 3));
          const wrapperBytes = bytes(
            JSON.stringify({
              source_context: context.context_key,
              previous: clippedPrevious,
              records: [],
            }),
          );
          const room = Math.min(
            MAX_EXTRACTION_RECORD_BYTES,
            Math.max(0, available - wrapperBytes),
          );
          const batch: RuntimeHistoryRecord[] = [];
          let size = 0;
          for (const record of records) {
            const recordBytes =
              bytes(JSON.stringify(record)) + (batch.length ? 1 : 0);
            if (size + recordBytes > room) break;
            batch.push(record);
            size += recordBytes;
          }
          if (!batch.length) {
            const fitted = fitRecordToBytes(records[0]!, room);
            if (fitted) batch.push(fitted);
          }
          if (!batch.length) {
            const skipped = records[0]!;
            this.options.logger.log(
              "warn",
              "agent_memory.record_skipped_oversized",
              {
                agentId,
                source_key: sourceKey,
                ordinal: skipped.ordinal,
                room_bytes: room,
              },
            );
            document = await memory.commit(
              agentId,
              {
                ...document,
                cursors: {
                  ...document.cursors,
                  [sourceKey]: {
                    thread_id: page.snapshot.threadId,
                    through: skipped.ordinal,
                  },
                },
              },
              signal,
            );
            extracting = true;
            break;
          }
          const last = batch.at(-1)!.ordinal;
          const prompt = JSON.stringify({
            source_context: context.context_key,
            previous: clippedPrevious,
            records: batch,
          });
          document = await memory.commit(
            agentId,
            {
              ...document,
              pending: {
                stage: "extract",
                prompt,
                source_key: sourceKey,
                thread_id: page.snapshot.threadId,
                through: last,
              },
            },
            signal,
          );
          extracting = true;
          break;
        }
        if (!extracting) {
          // Every consolidation clears the candidates it took, so this ends.
          if (!waiting.length || (!full && mode !== "consolidate")) {
            relaxAdaptiveCap();
            return settled;
          }
          const currentBudget = await budgetOf();
          const memorySections = memorySectionHeadings(document.memory);
          const consolidateOverhead =
            bytes(memoryInstructions("consolidate", currentBudget.memory)) +
            bytes(JSON.stringify(memoryOutputSchema("consolidate")));
          const available = Math.max(
            0,
            currentBudget.input - consolidateOverhead,
          );
          const shellWithoutPrev = bytes(
            JSON.stringify({
              previous: { summary: "", memory: "" },
              memory_sections: memorySections,
              extractions: [],
            }),
          );
          const emptyPrevBytes = bytes(
            JSON.stringify({ summary: "", memory: "" }),
          );
          const previousBudget = Math.max(
            emptyPrevBytes,
            Math.floor(
              (Math.max(0, available - shellWithoutPrev + emptyPrevBytes) * 2) /
                3,
            ),
          );
          const previousMemory = fitPreviousMemory(
            { summary: document.summary, memory: document.memory },
            previousBudget,
          );
          let size =
            consolidateOverhead +
            bytes(
              JSON.stringify({
                previous: previousMemory,
                memory_sections: memorySections,
                extractions: [],
              }),
            );
          // Sessions least recently extracted go first. Those that do not fit
          // wait for the next consolidation of this pass. A consolidation
          // always takes at least one session, so a small window never
          // blocks the candidates.
          const extractions: ConsolidateExtraction[] = [];
          for (const [key, session] of waiting.sort(
            ([, a], [, b]) => a.updated_revision - b.updated_revision,
          )) {
            const extraction: ConsolidateExtraction = {
              key,
              context_key: session.context_key,
              summary: session.summary,
              raw_memory: session.raw_memory,
            };
            const extractionBytes =
              bytes(JSON.stringify(extraction)) + (extractions.length ? 1 : 0);
            if (
              extractions.length &&
              size + extractionBytes > currentBudget.input
            )
              break;
            extractions.push(extraction);
            size += extractionBytes;
          }
          const prompt = JSON.stringify({
            previous: previousMemory,
            memory_sections: memorySections,
            extractions,
          });
          document = await memory.commit(
            agentId,
            { ...document, pending: { stage: "consolidate", prompt } },
            signal,
          );
        }
      }
      // Each pending stage runs to publication. The persisted pending stage is
      // the checkpoint across restarts and the bounded retry counter.
      let shrinkSteps = 0;
      for (
        let pending = document.pending;
        pending;
        pending = document.pending
      ) {
        const attempt = pending.attempt ?? 0;
        if (attempt >= MAX_STAGE_ATTEMPTS)
          throw new Error(
            `Memory ${pending.stage} produced no valid output in ${MAX_STAGE_ATTEMPTS} attempts`,
          );
        let output: Record<string, unknown>;
        let consolidated: string;
        const { stage } = pending;
        const currentBudget = await budgetOf();
        const memoryLimit = currentBudget.memory;
        const instructions = memoryInstructions(stage, memoryLimit);
        const outputSchema = memoryOutputSchema(stage);
        // Self-heal an oversized persisted extract or consolidate checkpoint
        // (for example one committed before a tighter budget, after migrating
        // to a smaller model, or after an adaptive shrink).
        const maxPromptBytes = Math.max(
          MIN_SHRINK_INPUT_BYTES,
          currentBudget.input -
            bytes(instructions) -
            bytes(JSON.stringify(outputSchema)),
        );
        if (bytes(pending.prompt) > maxPromptBytes) {
          const shrunk = shrinkPendingStage(pending, maxPromptBytes, false);
          if (shrunk) {
            this.options.logger.log("info", "agent_memory.batch_shrunk", {
              agentId,
              stage,
              before_bytes: bytes(pending.prompt),
              after_bytes: bytes(shrunk.prompt),
              reason: "budget",
            });
            document = await memory.commit(
              agentId,
              { ...document, pending: shrunk },
              signal,
            );
            continue;
          }
        }
        // Throws what the output schema cannot express; a consolidation
        // returns the memory its edits produce.
        const previous = document.memory;
        const checked = (candidate: Record<string, unknown>): string => {
          if (stage === "extract") {
            outputText(candidate, "session_summary", 32_000);
            outputText(candidate, "raw_memory", 32_000);
            return "";
          }
          outputText(candidate, "summary", 8_000);
          const edited = applyMemoryEdits(previous, candidate.edits);
          if (bytes(edited) > memoryLimit)
            throw new InvalidMemoryOutputError("Memory exceeds its limit");
          return edited;
        };
        try {
          ({ output } = await this.options.modelCall.call({
            kind: "agent_memory",
            key: `agent-memory:${agentId}:${stage}`,
            placement,
            instructions,
            input: pending.prompt,
            schemaName: `memory_${stage}`,
            outputSchema,
            timeoutMs: STAGE_TIMEOUT_MS[stage],
            // The call corrects an output these checks reject, so a stage
            // fails only past its kind's attempts.
            validate: (candidate) => {
              try {
                checked(candidate);
                return undefined;
              } catch (error) {
                if (error instanceof InvalidMemoryOutputError)
                  return error.message;
                throw error;
              }
            },
            signal,
          }));
          consolidated = checked(output);
        } catch (error) {
          if (
            error instanceof ModelCallError &&
            error.kind === "invalid_request"
          ) {
            const promptBytes = bytes(pending.prompt);
            const nextCap = Math.max(
              MIN_SHRINK_INPUT_BYTES,
              Math.floor((bytes(instructions) + promptBytes) / 2),
            );
            this.#adaptiveInputBytes.set(agentId, {
              bytes: nextCap,
              window: resolvedWindow?.value,
            });
            hadInvalidRequestShrink = true;
            if (shrinkSteps < MAX_SHRINK_STEPS_PER_PASS) {
              const shrunk = shrinkPendingStage(
                pending,
                Math.max(512, Math.floor(promptBytes / 2)),
                true,
              );
              if (shrunk) {
                shrinkSteps += 1;
                this.options.logger.log("warn", "agent_memory.batch_shrunk", {
                  agentId,
                  stage,
                  before_bytes: promptBytes,
                  after_bytes: bytes(shrunk.prompt),
                  reason: error.kind,
                });
                document = await memory.commit(
                  agentId,
                  { ...document, pending: shrunk },
                  signal,
                );
                continue;
              }
            } else {
              // Keep the already-shrunk pending checkpoint and back off so
              // the next pass continues shrinking without dropping records.
              throw error;
            }
            if (
              pending.stage === "extract" &&
              pending.source_key !== undefined &&
              pending.thread_id !== undefined &&
              pending.through !== undefined
            ) {
              const parsed = parseExtractPayload(pending.prompt);
              if (parsed && parsed.records.length === 1) {
                const sole = parsed.records[0]!;
                const { pending: _dropped, ...rest } = document;
                this.options.logger.log(
                  "warn",
                  "agent_memory.record_skipped_oversized",
                  {
                    agentId,
                    source_key: pending.source_key,
                    ordinal: sole.ordinal,
                    prompt_bytes: promptBytes,
                  },
                );
                document = await memory.commit(
                  agentId,
                  {
                    ...rest,
                    cursors: {
                      ...document.cursors,
                      [pending.source_key]: {
                        thread_id: pending.thread_id,
                        through: sole.ordinal,
                      },
                    },
                  },
                  signal,
                );
                break;
              }
              if (parsed && parsed.records.length > 1) {
                const dropped = parsed.records[0]!;
                const remaining = parsed.records.slice(1);
                this.options.logger.log(
                  "warn",
                  "agent_memory.record_skipped_oversized",
                  {
                    agentId,
                    source_key: pending.source_key,
                    ordinal: dropped.ordinal,
                    prompt_bytes: promptBytes,
                  },
                );
                document = await memory.commit(
                  agentId,
                  {
                    ...document,
                    cursors: {
                      ...document.cursors,
                      [pending.source_key]: {
                        thread_id: pending.thread_id,
                        through: dropped.ordinal,
                      },
                    },
                    pending: {
                      ...pending,
                      prompt: JSON.stringify({
                        ...parsed,
                        records: remaining,
                      }),
                      through: remaining.at(-1)!.ordinal,
                    },
                  },
                  signal,
                );
                continue;
              }
            }
            await memory.commit(
              agentId,
              { ...document, pending: { ...pending, attempt: attempt + 1 } },
              signal,
            );
            throw error;
          }
          if (error instanceof ModelCallError && error.kind === "failed") {
            const promptBytes = bytes(pending.prompt);
            // Defensive shrink for older Daemons that report context overflow
            // as generic "failed". Never persist #adaptiveInputBytes here so a
            // transient outage cannot permanently shrink future batches.
            if (promptBytes > MIN_SHRINK_INPUT_BYTES) {
              const shrunk = shrinkPendingStage(
                pending,
                Math.max(MIN_SHRINK_INPUT_BYTES, Math.floor(promptBytes / 2)),
                true,
              );
              if (shrunk) {
                this.options.logger.log("warn", "agent_memory.batch_shrunk", {
                  agentId,
                  stage,
                  before_bytes: promptBytes,
                  after_bytes: bytes(shrunk.prompt),
                  reason: error.kind,
                });
                await memory.commit(
                  agentId,
                  { ...document, pending: shrunk },
                  signal,
                );
                throw error;
              }
            }
            await memory.commit(
              agentId,
              { ...document, pending: { ...pending, attempt: attempt + 1 } },
              signal,
            );
            throw error;
          }
          // Only an output the model produced, or a Runtime that ran out of
          // time producing one, counts against the attempt budget; an offline
          // Computer or a missing Runtime backs off instead. Either way the
          // stage backs off, so it never holds the model back to back.
          if (
            !(error instanceof InvalidMemoryOutputError) &&
            !(
              error instanceof ModelCallError &&
              (error.kind === "invalid_output" ||
                error.kind === "timed_out" ||
                error.kind === "output_limited")
            )
          )
            throw error;
          await memory.commit(
            agentId,
            { ...document, pending: { ...pending, attempt: attempt + 1 } },
            signal,
          );
          throw error;
        }
        shrinkSteps = 0;
        completedStages += 1;
        const { pending: _, ...published } = document;
        if (pending.stage === "extract") {
          const { source_key: key, thread_id, through } = pending;
          if (
            key === undefined ||
            thread_id === undefined ||
            through === undefined
          )
            throw new Error("Memory extraction checkpoint names no source");
          const source = JSON.parse(pending.prompt) as {
            source_context: string;
          };
          const waiting = document.sessions[key]?.raw_memory ?? "";
          const found = outputText(output, "raw_memory", 32_000);
          const sessions = { ...document.sessions };
          sessions[key] = {
            context_key: source.source_context,
            thread_id,
            through,
            summary: outputText(output, "session_summary", 32_000),
            // Candidates wait here until the next consolidation merges them.
            raw_memory:
              waiting && found ? `${waiting}\n\n${found}` : waiting || found,
            updated_revision: document.revision + 1,
          };
          // A session whose candidates still wait is never evicted.
          const oldest = Object.keys(sessions)
            .filter((other) => other === key || !sessions[other]!.raw_memory)
            .sort(
              (a, b) =>
                sessions[a]!.updated_revision - sessions[b]!.updated_revision,
            );
          for (const evicted of oldest.slice(
            0,
            Math.max(0, Object.keys(sessions).length - MAX_SESSIONS),
          ))
            delete sessions[evicted];
          document = await memory.commit(
            agentId,
            {
              ...published,
              sessions,
              cursors: { ...document.cursors, [key]: { thread_id, through } },
            },
            signal,
          );
          continue;
        }
        const { extractions } = JSON.parse(pending.prompt) as {
          extractions: readonly { key: string }[];
        };
        const sessions = { ...document.sessions };
        for (const { key } of extractions)
          if (sessions[key])
            sessions[key] = { ...sessions[key], raw_memory: "" };
        document = await memory.commit(
          agentId,
          {
            ...published,
            sessions,
            summary: outputText(output, "summary", 8_000),
            memory: consolidated,
          },
          signal,
        );
      }
    }
  }

  #now(): number {
    return this.options.now?.() ?? Date.now();
  }

  #log(error: unknown, agentId?: string): void {
    if (!this.#stop.signal.aborted)
      this.options.logger.log("warn", "agent_memory.reconcile_failed", {
        agentId,
        error: String(error),
      });
  }
}

function outputText(
  value: Record<string, unknown>,
  field: string,
  limit: number,
): string {
  const text = value[field];
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > limit)
    throw new InvalidMemoryOutputError(`Invalid memory output: ${field}`);
  return text;
}
