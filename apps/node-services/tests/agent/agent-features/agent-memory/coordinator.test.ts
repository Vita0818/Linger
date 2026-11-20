import { describe, expect, it, vi } from "vitest";
import {
  AgentMemoryCoordinator,
  memoryBudget,
  type AgentMemoryHost,
} from "../../../../src/agent/agent-features/agent-memory/coordinator.js";
import type {
  MemoryClient,
  MemoryDocument,
} from "../../../../src/agent/agent-features/agent-memory/client.js";
import { encodeExecutionContextRef } from "../../../../src/agent/executor/context-ref.js";
import {
  ModelCallError,
  type ModelCall,
  type ModelCallRequest,
} from "../../../../src/runtime-model-call.js";
import {
  TeamHubRuntimeStateError,
  type TeamHubRuntimeStateClient,
} from "../../../../src/agent/executor/teamhub-runtime-state-client.js";
import { modelCallPolicies } from "../../../../src/model-tasks.js";
import { stubModelCall } from "../../../model-call-stub.js";

const OWNER = { tenantId: "tenant-1", ownerActorId: "owner-1" };
const ATTEMPTS = modelCallPolicies.agent_memory.attempts;

const stageOf = (request: ModelCallRequest) =>
  request.schemaName === "memory_extract" ? "extract" : "consolidate";

const validOutput = (request: ModelCallRequest) =>
  stageOf(request) === "extract"
    ? {
        session_summary: "Orchard release is lantern-482",
        raw_memory: "release code lantern-482",
      }
    : {
        summary: "Orchard release",
        edits: [
          {
            op: (
              JSON.parse(request.input) as { memory_sections: string[] }
            ).memory_sections.includes("Releases")
              ? "replace"
              : "add",
            heading: "Releases",
            content: "Release code: lantern-482",
          },
        ],
      };

function fixture(
  options: {
    ghostRuntime?: unknown;
    ghost?: unknown;
    canReadHistory?: (computerId: string, runtimeType: string) => boolean;
    contextWindow?: () => number | undefined;
    inputSequence?: string;
  } = {},
) {
  const clock = { now: 0 };
  const documents = new Map<string, MemoryDocument>();
  let inputSequence = options.inputSequence ?? "1";
  const business = (agentId: string) => ({
    ref: {
      kind: "meta" as const,
      agent_id: agentId,
      room_id: `room-${agentId}`,
    },
    context_key: encodeExecutionContextRef({
      kind: "meta",
      agentId,
      roomId: `room-${agentId}`,
    }),
    next_input_sequence: inputSequence,
  });
  // Maintenance needs no Context lifecycle: the fake host has none.
  const host = {
    getGhost: vi.fn(async () =>
      "ghost" in options
        ? options.ghost
        : {
            runtime: options.ghostRuntime ?? {
              type: "local",
              placement: {
                ...OWNER,
                computerId: "computer-1",
                runtimeType: "codex",
              },
            },
          },
    ),
    subscribeTurnTerminals: () => () => {},
    inspectDebugContextHistory: vi.fn(async () => ({
      status: "available",
      snapshot: {
        id: "snapshot",
        threadId: "thread",
        tailState: "clean",
        recordCount: 1,
      },
      records: [
        {
          ordinal: 0,
          category: "message",
          nativeRecord: {
            role: "user",
            text: "Project Orchard uses release code lantern-482.",
          },
        },
      ],
    })),
  } as unknown as AgentMemoryHost;
  const runtimeState = {
    listContexts: async (id?: string) => [business(id ?? "A")],
    getWorkState: vi.fn(async () => ({ has_pending_work: false })),
  } as unknown as TeamHubRuntimeStateClient;
  const memory = {
    read: vi.fn(async (id: string) =>
      structuredClone(
        documents.get(id) ?? {
          revision: 0,
          summary: "",
          memory: "",
          sessions: {},
          cursors: {},
        },
      ),
    ),
    commit: async (id, document) => {
      if ((documents.get(id)?.revision ?? 0) !== document.revision)
        throw new Error("CAS conflict");
      const next = structuredClone({
        ...document,
        revision: document.revision + 1,
        // PostgreSQL JSONB does not preserve object insertion order.
        sessions: Object.fromEntries(Object.entries(document.sessions).sort()),
      });
      documents.set(id, next);
      return next;
    },
  } satisfies MemoryClient;
  const respond = vi.fn<
    (request: ModelCallRequest) => Promise<Record<string, unknown>>
  >(async (request) => validOutput(request));
  const contextWindow = vi.fn<NonNullable<ModelCall["contextWindow"]>>(
    async () => options.contextWindow?.(),
  );
  // As the call's attempts would: an answer the request's check rejects
  // gets the next attempt, and a thrown failure passes through.
  const modelCall: ModelCall = stubModelCall({
    call: async (request) => {
      for (let attempt = 1; ; attempt += 1) {
        const output = await respond(request);
        const problem = await request.validate?.(output);
        if (problem === undefined) return { output, model: "codex" };
        if (attempt >= ATTEMPTS)
          throw new ModelCallError("invalid_output", problem);
      }
    },
    contextWindow,
  });
  const logger = { log: vi.fn() };
  const coordinator = new AgentMemoryCoordinator({
    host,
    runtimeState,
    logger,
    now: () => clock.now,
    ...(options.canReadHistory
      ? { canReadHistory: options.canReadHistory }
      : {}),
    memory,
    modelCall,
  });
  return {
    coordinator,
    documents,
    memory,
    host,
    runtimeState,
    logger,
    respond,
    contextWindow,
    stages: () => respond.mock.calls.map(([request]) => stageOf(request)),
    receiveInput: () => {
      inputSequence = String(Number(inputSequence) + 1);
    },
    advance: (ms: number) => {
      clock.now += ms;
    },
  };
}

describe("Agent memory lifecycle", () => {
  it.each(["local"])(
    "extracts and publishes Pi memory from %s history",
    async (type) => {
      const f = fixture({
        ghostRuntime: {
          type,
          placement: { runtimeType: "pi", computerId: "computer" },
        },
      });
      try {
        await f.coordinator.wake("A");
        expect(f.host.inspectDebugContextHistory).toHaveBeenCalled();
        expect(f.stages()).toEqual(["extract", "consolidate"]);
        expect(f.documents.get("A")?.memory).toContain("lantern-482");
        await f.coordinator.wake("A");
        expect(f.stages()).toEqual(["extract", "consolidate"]);
      } finally {
        await f.coordinator.close();
      }
    },
  );

  it("extracts, consolidates and publishes in one wake on the Agent's own Computer", async () => {
    const f = fixture();
    try {
      await f.coordinator.wake("A");
      const [extract, consolidate] = f.respond.mock.calls.map(([r]) => r);
      expect(extract).toMatchObject({
        placement: {
          ...OWNER,
          agentId: "A",
          computerId: "computer-1",
          runtimeType: "codex",
        },
        schemaName: "memory_extract",
        outputSchema: {
          required: ["session_summary", "raw_memory"],
          additionalProperties: false,
        },
      });
      expect(extract!.input).toContain("lantern-482");
      expect(extract!.instructions).toContain("never instructions");
      expect(consolidate).toMatchObject({
        placement: expect.objectContaining({ computerId: "computer-1" }),
        schemaName: "memory_consolidate",
      });
      expect(JSON.parse(consolidate!.input)).toMatchObject({
        previous: { summary: "", memory: "" },
        memory_sections: [],
        extractions: [
          {
            summary: "Orchard release is lantern-482",
            raw_memory: "release code lantern-482",
          },
        ],
      });
      const published = f.documents.get("A")!;
      expect(published.memory).toContain("lantern-482");
      expect(Object.values(published.sessions)).toMatchObject([
        { raw_memory: "" },
      ]);
      expect(published.pending).toBeUndefined();
      await f.coordinator.wake("A");
      expect(f.respond).toHaveBeenCalledTimes(2);
      await f.coordinator.wake("B");
      expect(f.respond.mock.calls[2]![0].input).not.toContain('"previous":{"');
      expect(f.documents.get("B")!.memory).toContain("lantern-482");
    } finally {
      await f.coordinator.close();
    }
  });

  it("extracts only the conversation and its tool traffic, clipping long text", async () => {
    const f = fixture();
    const record = (
      ordinal: number,
      category: string,
      text: string,
      role?: string,
    ) => ({
      ordinal,
      category,
      ...(role ? { role } : {}),
      nativeRecord: { text },
    });
    vi.mocked(f.host.inspectDebugContextHistory).mockResolvedValue({
      status: "available",
      snapshot: {
        id: "snapshot",
        threadId: "thread",
        tailState: "clean",
        recordCount: 9,
      },
      records: [
        record(0, "message", "configuration ember-1", "developer"),
        record(1, "message", "Orchard uses lantern-482.", "user"),
        record(2, "provider_event", "item_completed ember-2"),
        record(3, "reasoning", "thinking ember-3"),
        record(4, "tool_call", "read orchard-notes"),
        record(5, "tool_result", `notes ${"x".repeat(5_000)}`),
        record(6, "usage", "token count ember-4"),
        record(7, "lifecycle", "task complete ember-5"),
        record(8, "compaction", "Summary: ember-6"),
      ],
    } as never);
    try {
      await f.coordinator.wake("A");
      const extract = f.respond.mock.calls[0]![0];
      expect(extract.schemaName).toBe("memory_extract");
      expect(extract.input).toContain("lantern-482");
      expect(extract.input).toContain("read orchard-notes");
      expect(extract.input).toContain("[1006 characters omitted]");
      expect(extract.input).not.toContain("ember-");
    } finally {
      await f.coordinator.close();
    }
  });

  it("waits for five succeeded Runs before reading new history", async () => {
    const f = fixture();
    try {
      for (let run = 0; run < 4; run += 1) await f.coordinator.recordRun("A");
      // Input alone wakes a scan, which reads no history before the fifth Run.
      f.receiveInput();
      await f.coordinator.reconcile();
      expect(f.host.inspectDebugContextHistory).not.toHaveBeenCalled();
      expect(f.respond).not.toHaveBeenCalled();
      await f.coordinator.recordRun("A");
      // The fifth Run extracts; its candidates wait for consolidation.
      expect(f.stages()).toEqual(["extract"]);
      expect(f.documents.get("A")!.memory).toBe("");
      expect(Object.values(f.documents.get("A")!.sessions)).toMatchObject([
        { raw_memory: "release code lantern-482" },
      ]);
      // A completed pass starts the count again.
      const inspected = vi.mocked(f.host.inspectDebugContextHistory).mock.calls
        .length;
      for (let run = 0; run < 4; run += 1) await f.coordinator.recordRun("A");
      f.receiveInput();
      await f.coordinator.reconcile();
      expect(f.host.inspectDebugContextHistory).toHaveBeenCalledTimes(
        inspected,
      );
    } finally {
      await f.coordinator.close();
    }
  });

  it("consolidates waiting candidates once the Agent has been idle for six hours", async () => {
    const f = fixture();
    const hour = 60 * 60_000;
    try {
      for (let run = 0; run < 5; run += 1) await f.coordinator.recordRun("A");
      expect(f.stages()).toEqual(["extract"]);
      f.advance(5 * hour);
      // Another Run starts the idle period again.
      await f.coordinator.recordRun("A");
      f.advance(hour);
      await f.coordinator.reconcile();
      expect(f.stages()).toEqual(["extract"]);
      f.advance(5 * hour);
      await f.coordinator.reconcile();
      expect(f.stages()).toEqual(["extract", "consolidate"]);
      const published = f.documents.get("A")!;
      expect(published.memory).toContain("lantern-482");
      expect(Object.values(published.sessions)).toMatchObject([
        { raw_memory: "" },
      ]);
      // Nothing waits any more, however long the Agent stays idle.
      f.advance(24 * hour);
      await f.coordinator.reconcile();
      expect(f.stages()).toEqual(["extract", "consolidate"]);
    } finally {
      await f.coordinator.close();
    }
  });

  it("consolidates candidates waiting from before a restart after six idle hours", async () => {
    const f = fixture();
    const key = "e".repeat(64);
    f.documents.set("A", {
      revision: 3,
      summary: "",
      memory: "",
      cursors: {},
      sessions: {
        [key]: {
          context_key: "source",
          thread_id: "other-thread",
          through: 0,
          summary: "earlier session",
          raw_memory: "waiting lantern-77",
          updated_revision: 3,
        },
      },
    });
    try {
      await f.coordinator.reconcile();
      expect(f.respond).not.toHaveBeenCalled();
      f.advance(6 * 60 * 60_000);
      await f.coordinator.reconcile();
      // An idle pass also extracts history fewer than five Runs left behind.
      expect(f.stages()).toEqual(["extract", "consolidate"]);
      expect(f.respond.mock.calls[1]![0].input).toContain("lantern-77");
      expect(f.documents.get("A")!.sessions[key]!.raw_memory).toBe("");
    } finally {
      await f.coordinator.close();
    }
  });

  it("publishes only the sections the consolidation edits", async () => {
    const f = fixture();
    const key = "e".repeat(64);
    const memory =
      "## Releases\n\n- lantern-77\n\n## Tooling\n\n- Run the gate.\n";
    f.documents.set("A", {
      revision: 3,
      summary: "old index",
      memory,
      cursors: {},
      sessions: {
        [key]: {
          context_key: "source",
          thread_id: "other-thread",
          through: 0,
          summary: "earlier session",
          raw_memory: "the release moved to lantern-482",
          updated_revision: 3,
        },
      },
    });
    try {
      await f.coordinator.wake("A");
      expect(f.stages()).toEqual(["extract", "consolidate"]);
      expect(JSON.parse(f.respond.mock.calls[1]![0].input)).toMatchObject({
        previous: { summary: "old index", memory },
        memory_sections: ["Releases", "Tooling"],
      });
      expect(f.documents.get("A")).toMatchObject({
        summary: "Orchard release",
        memory:
          "## Releases\n\nRelease code: lantern-482\n\n## Tooling\n\n- Run the gate.\n",
      });
    } finally {
      await f.coordinator.close();
    }
  });

  it("corrects edits that do not fit the memory in the call's next attempt", async () => {
    const f = fixture();
    f.respond
      .mockImplementationOnce(async (request) => validOutput(request))
      .mockResolvedValueOnce({
        summary: "Orchard release",
        edits: [{ op: "replace", heading: "Missing", content: "x" }],
      });
    try {
      await f.coordinator.wake("A");
      expect(f.stages()).toEqual(["extract", "consolidate", "consolidate"]);
      expect(f.documents.get("A")!.pending).toBeUndefined();
      expect(f.documents.get("A")!.memory).toBe(
        "## Releases\n\nRelease code: lantern-482\n",
      );
    } finally {
      await f.coordinator.close();
    }
  });

  it("spends an attempt and backs off each time consolidation times out", async () => {
    const f = fixture();
    f.respond.mockImplementation(async (request) => {
      if (stageOf(request) === "consolidate")
        throw new ModelCallError(
          "timed_out",
          "The Runtime did not answer in time",
        );
      return validOutput(request);
    });
    try {
      await f.coordinator.wake("A");
      expect(f.stages()).toEqual(["extract", "consolidate"]);
      expect(f.documents.get("A")!.pending).toMatchObject({
        stage: "consolidate",
        attempt: 1,
      });
      // A timed-out stage is not retried back to back.
      await f.coordinator.wake("A");
      expect(f.respond).toHaveBeenCalledTimes(2);
      f.advance(60_000);
      await f.coordinator.wake("A");
      f.advance(2 * 60_000);
      await f.coordinator.wake("A");
      expect(f.documents.get("A")!.pending).toMatchObject({ attempt: 3 });
      f.advance(60 * 60_000);
      await f.coordinator.wake("A");
      expect(f.respond).toHaveBeenCalledTimes(4);
      expect(f.documents.get("A")!.memory).toBe("");
    } finally {
      await f.coordinator.close();
    }
  });

  it("consolidates before extracting past the waiting candidate budget", async () => {
    const f = fixture();
    const records: {
      ordinal: number;
      category: string;
      nativeRecord: unknown;
    }[] = [];
    vi.mocked(f.host.inspectDebugContextHistory).mockImplementation(
      async () =>
        ({
          status: "available",
          snapshot: {
            id: "snapshot",
            threadId: "thread",
            tailState: "clean",
            recordCount: records.length,
          },
          records: [...records],
        }) as never,
    );
    f.respond.mockImplementation(async (request) =>
      stageOf(request) === "extract"
        ? { session_summary: "busy", raw_memory: "c".repeat(30_000) }
        : validOutput(request),
    );
    try {
      for (let pass = 0; pass < 4; pass += 1) {
        records.push({
          ordinal: pass,
          category: "message",
          nativeRecord: { role: "user", text: `turn ${pass}` },
        });
        for (let run = 0; run < 5; run += 1) await f.coordinator.recordRun("A");
      }
      expect(f.stages()).toEqual([
        "extract",
        "extract",
        "extract",
        "consolidate",
        "extract",
      ]);
      expect(
        Object.values(f.documents.get("A")!.sessions)[0]!.raw_memory,
      ).toHaveLength(30_000);
    } finally {
      await f.coordinator.close();
    }
  });

  it("counts Runs that finish during a pass toward the next one", async () => {
    const f = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.respond.mockImplementationOnce(async (request) => {
      await held;
      return validOutput(request);
    });
    try {
      const passes: Promise<void>[] = [];
      for (let run = 0; run < 5; run += 1)
        passes.push(f.coordinator.recordRun("A"));
      await vi.waitFor(() => expect(f.respond).toHaveBeenCalledTimes(1));
      for (let run = 0; run < 5; run += 1)
        passes.push(f.coordinator.recordRun("A"));
      release();
      await Promise.all(passes);
      const inspected = vi.mocked(f.host.inspectDebugContextHistory).mock.calls
        .length;
      // Five Runs are still counted, so even an unchanged scan reads history.
      await f.coordinator.reconcile();
      expect(f.host.inspectDebugContextHistory).toHaveBeenCalledTimes(
        inspected + 1,
      );
      await f.coordinator.reconcile();
      expect(f.host.inspectDebugContextHistory).toHaveBeenCalledTimes(
        inspected + 1,
      );
    } finally {
      await f.coordinator.close();
    }
  });

  it("extracts every batch a pass found, but not history written during it", async () => {
    const f = fixture();
    const record = (ordinal: number, text: string) => ({
      ordinal,
      category: "message",
      nativeRecord: { role: "user", text },
    });
    // Twenty clipped-size records exceed one default extraction batch.
    const records = Array.from({ length: 20 }, (_, ordinal) =>
      record(
        ordinal,
        `${ordinal === 0 ? "first" : ordinal === 19 ? "second" : "filler"} ${"x".repeat(3_500)}`,
      ),
    );
    vi.mocked(f.host.inspectDebugContextHistory).mockImplementation(
      async () =>
        ({
          status: "available",
          snapshot: {
            id: "snapshot",
            threadId: "thread",
            tailState: "clean",
            recordCount: records.length,
          },
          records: [...records],
        }) as never,
    );
    f.respond.mockImplementation(async (request) => {
      // A Run finishes while the pass is extracting.
      if (records.length === 20) records.push(record(20, "third lantern-999"));
      return validOutput(request);
    });
    try {
      await f.coordinator.wake("A");
      // Both batches are extracted, then consolidated together once.
      expect(f.stages()).toEqual(["extract", "extract", "consolidate"]);
      const inputs = f.respond.mock.calls.map(([request]) => request.input);
      expect(inputs[0]).toContain("first");
      expect(inputs[1]).toContain("second");
      expect(inputs.join("")).not.toContain("lantern-999");
      expect(Object.values(f.documents.get("A")!.cursors)).toEqual([
        { thread_id: "thread", through: 19 },
      ]);
      for (let run = 0; run < 5; run += 1) await f.coordinator.recordRun("A");
      expect(f.respond.mock.calls.at(-1)![0].input).toContain("lantern-999");
    } finally {
      await f.coordinator.close();
    }
  });

  it("scans an Agent again only after one of its Contexts receives input", async () => {
    const f = fixture();
    try {
      await f.coordinator.reconcile();
      const reads = vi.mocked(f.memory.read).mock.calls.length;
      await f.coordinator.reconcile();
      await f.coordinator.reconcile();
      expect(f.memory.read).toHaveBeenCalledTimes(reads);
      f.receiveInput();
      await f.coordinator.reconcile();
      expect(f.memory.read).toHaveBeenCalledTimes(reads + 1);
      // A compaction start still maintains the Agent directly.
      await f.coordinator.wake("A");
      expect(f.memory.read).toHaveBeenCalledTimes(reads + 2);
      expect(f.respond).toHaveBeenCalledTimes(2);
    } finally {
      await f.coordinator.close();
    }
  });

  it("skips a Meta Context that has never received input and still settles", async () => {
    const f = fixture({ inputSequence: "0" });
    try {
      await f.coordinator.reconcile();
      expect(f.runtimeState.getWorkState).not.toHaveBeenCalled();
      expect(f.host.inspectDebugContextHistory).not.toHaveBeenCalled();
      expect(f.respond).not.toHaveBeenCalled();
      // Settled: the next scan with unchanged Contexts reads nothing.
      const getGhost = vi.mocked(f.host.getGhost).mock.calls.length;
      const reads = vi.mocked(f.memory.read).mock.calls.length;
      await f.coordinator.reconcile();
      expect(f.host.getGhost).toHaveBeenCalledTimes(getGhost);
      expect(f.memory.read).toHaveBeenCalledTimes(reads);
    } finally {
      await f.coordinator.close();
    }
  });

  it("leaves unreadable history for the next due pass", async () => {
    const f = fixture();
    vi.mocked(f.host.inspectDebugContextHistory).mockResolvedValue({
      status: "unavailable",
      records: [],
    } as never);
    try {
      for (let run = 0; run < 5; run += 1) await f.coordinator.recordRun("A");
      expect(f.host.inspectDebugContextHistory).toHaveBeenCalledTimes(1);
      // New input alone does not read it again.
      f.receiveInput();
      await f.coordinator.reconcile();
      expect(f.host.inspectDebugContextHistory).toHaveBeenCalledTimes(1);
      for (let run = 0; run < 5; run += 1) await f.coordinator.recordRun("A");
      expect(f.host.inspectDebugContextHistory).toHaveBeenCalledTimes(2);
    } finally {
      await f.coordinator.close();
    }
  });

  it("reads no history from a Computer that is offline or asleep", async () => {
    const canReadHistory = vi.fn(() => false);
    const f = fixture({
      ghostRuntime: {
        type: "local",
        placement: { computerId: "computer-1", runtimeType: "codex" },
      },
      canReadHistory,
    });
    try {
      await f.coordinator.wake("A");
      expect(canReadHistory).toHaveBeenCalledWith("computer-1", "codex");
      expect(f.host.inspectDebugContextHistory).not.toHaveBeenCalled();
      expect(f.respond).not.toHaveBeenCalled();
      expect(f.documents.get("A")).toBeUndefined();
      canReadHistory.mockReturnValue(true);
      await f.coordinator.wake("A");
      expect(f.stages()).toEqual(["extract", "consolidate"]);
    } finally {
      await f.coordinator.close();
    }
  });

  it("keeps extracted candidates and resumes consolidation without the Computer", async () => {
    const canReadHistory = vi.fn(() => true);
    const f = fixture({
      ghostRuntime: {
        type: "local",
        placement: { computerId: "computer-1", runtimeType: "codex" },
      },
      canReadHistory,
    });
    f.respond.mockImplementation(async (request) => {
      if (stageOf(request) === "consolidate")
        throw new ModelCallError("computer_offline", "Computer is offline");
      return validOutput(request);
    });
    try {
      await f.coordinator.wake("A");
      expect(f.documents.get("A")!.pending).toEqual({
        stage: "consolidate",
        prompt: expect.stringContaining("lantern-482"),
      });
      canReadHistory.mockReturnValue(false);
      f.respond.mockImplementation(async (request) => validOutput(request));
      f.advance(60_000);
      const inspected = vi.mocked(f.host.inspectDebugContextHistory).mock.calls
        .length;
      await f.coordinator.wake("A");
      expect(f.stages()).toEqual(["extract", "consolidate", "consolidate"]);
      expect(f.host.inspectDebugContextHistory).toHaveBeenCalledTimes(
        inspected,
      );
      expect(f.documents.get("A")!.memory).toContain("lantern-482");
      expect(f.documents.get("A")!.pending).toBeUndefined();
    } finally {
      await f.coordinator.close();
    }
  });

  it("backs off while the Computer is offline without spending an attempt", async () => {
    const f = fixture();
    f.respond.mockRejectedValue(
      new ModelCallError("computer_offline", "Computer is offline"),
    );
    try {
      await f.coordinator.wake("A");
      await f.coordinator.reconcile();
      await f.coordinator.wake("A");
      expect(f.respond).toHaveBeenCalledTimes(1);
      f.advance(60_000);
      await f.coordinator.wake("A");
      expect(f.respond).toHaveBeenCalledTimes(2);
      // The second failure doubles the wait.
      f.advance(60_000);
      await f.coordinator.wake("A");
      expect(f.respond).toHaveBeenCalledTimes(2);
      expect(f.documents.get("A")!.pending!.attempt).toBeUndefined();
      f.advance(60_000);
      f.respond.mockImplementation(async (request) => validOutput(request));
      await f.coordinator.wake("A");
      expect(f.documents.get("A")!.pending).toBeUndefined();
      expect(f.documents.get("A")!.memory).toContain("lantern-482");
    } finally {
      await f.coordinator.close();
    }
  });

  it("stops after three passes whose output stays invalid and leaves the published memory unchanged", async () => {
    const f = fixture();
    f.respond.mockResolvedValue({ session_summary: 42, raw_memory: "x" });
    try {
      await f.coordinator.wake("A");
      expect(f.respond).toHaveBeenCalledTimes(ATTEMPTS);
      expect(f.documents.get("A")!.pending).toMatchObject({
        stage: "extract",
        attempt: 1,
      });
      // A failed pass is not retried back to back.
      await f.coordinator.wake("A");
      expect(f.respond).toHaveBeenCalledTimes(ATTEMPTS);
      f.advance(60_000);
      await f.coordinator.wake("A");
      f.advance(2 * 60_000);
      await f.coordinator.wake("A");
      expect(f.respond).toHaveBeenCalledTimes(3 * ATTEMPTS);
      const document = f.documents.get("A")!;
      expect(document.pending).toMatchObject({ stage: "extract", attempt: 3 });
      expect(document.sessions).toEqual({});
      expect(document.cursors).toEqual({});
      expect(document.memory).toBe("");
      f.advance(60 * 60_000);
      await f.coordinator.wake("A");
      expect(f.respond).toHaveBeenCalledTimes(3 * ATTEMPTS);
    } finally {
      await f.coordinator.close();
    }
  });

  it("retains extraction watermarks when source summaries are evicted", async () => {
    const f = fixture();
    try {
      await f.coordinator.wake("A");
      const published = f.documents.get("A")!;
      f.documents.set("A", { ...published, sessions: {} });
      await f.coordinator.wake("A");
      expect(f.respond).toHaveBeenCalledTimes(2);
    } finally {
      await f.coordinator.close();
    }
  });

  it("evicts the oldest consolidated session regardless of JSONB key order", async () => {
    const f = fixture();
    const oldestKey = "f".repeat(64);
    const waitingKey = "e".repeat(64);
    const session = {
      context_key: "source",
      thread_id: "thread",
      through: 0,
      summary: "old",
      raw_memory: "",
    };
    f.documents.set("A", {
      revision: 100,
      summary: "",
      memory: "",
      cursors: {},
      sessions: Object.fromEntries([
        ...Array.from(
          { length: 28 },
          (_, i) =>
            [
              i.toString(16).padStart(64, "0"),
              { ...session, updated_revision: i + 3 },
            ] as const,
        ),
        [oldestKey, { ...session, updated_revision: 2 }],
        // Older still, but its candidates wait for consolidation.
        [
          waitingKey,
          { ...session, raw_memory: "waiting", updated_revision: 1 },
        ],
      ]),
    });
    try {
      await f.coordinator.wake("A");
      const published = f.documents.get("A")!;
      expect(Object.keys(published.sessions)).toHaveLength(30);
      expect(published.sessions[oldestKey]).toBeUndefined();
      expect(published.sessions[waitingKey]).toBeDefined();
      expect(f.respond.mock.calls.at(-1)![0].input).toContain("waiting");
      const [sourceKey] = Object.keys(published.cursors);
      expect(published.sessions[sourceKey!]!.updated_revision).toBe(
        Math.max(
          ...Object.values(published.sessions).map(
            (other) => other.updated_revision,
          ),
        ),
      );
    } finally {
      await f.coordinator.close();
    }
  });

  it("does not re-query getGhost for an Agent whose runtime config is gone until the signature changes", async () => {
    const f = fixture({ ghost: null });
    try {
      await f.coordinator.reconcile();
      expect(f.host.getGhost).toHaveBeenCalledTimes(1);
      expect(f.logger.log).toHaveBeenCalledTimes(1);
      expect(f.logger.log).toHaveBeenCalledWith(
        "info",
        "agent_memory.settled_config_gone",
        { agentId: "A", status: 404 },
      );
      expect(
        Object.keys(vi.mocked(f.logger.log).mock.calls[0]![2] as object),
      ).toEqual(["agentId", "status"]);
      await f.coordinator.reconcile();
      expect(f.host.getGhost).toHaveBeenCalledTimes(1);
      expect(f.logger.log).toHaveBeenCalledTimes(1);
      f.receiveInput();
      await f.coordinator.reconcile();
      expect(f.host.getGhost).toHaveBeenCalledTimes(2);
      expect(f.logger.log).toHaveBeenCalledTimes(2);
    } finally {
      await f.coordinator.close();
    }
  });

  it("does not treat an Agent as processed when getGhost throws", async () => {
    const f = fixture();
    vi.mocked(f.host.getGhost).mockRejectedValue(
      new TeamHubRuntimeStateError(503, "service unavailable"),
    );
    try {
      await f.coordinator.reconcile();
      expect(f.host.getGhost).toHaveBeenCalledTimes(1);
      await f.coordinator.reconcile();
      expect(f.host.getGhost).toHaveBeenCalledTimes(1);
      f.advance(60_000);
      await f.coordinator.reconcile();
      expect(f.host.getGhost).toHaveBeenCalledTimes(2);
    } finally {
      await f.coordinator.close();
    }
  });
});

describe("Agent memory sized to the model's context window", () => {
  // Half of 20,000 tokens at 1.5 UTF-8 bytes per token (CJK/JSON safe).
  const WINDOW = 20_000;
  const INPUT_BYTES = 15_000;
  const inputBytes = (request: ModelCallRequest) =>
    Buffer.byteLength(request.instructions ?? "", "utf8") +
    Buffer.byteLength(request.input, "utf8");
  const waitingSession = (raw_memory: string, updated_revision: number) => ({
    context_key: "source",
    thread_id: "thread",
    through: 0,
    summary: "summary",
    raw_memory,
    updated_revision,
  });

  it("extracts history in batches that fit the window", async () => {
    const f = fixture({ contextWindow: () => WINDOW });
    const records = Array.from({ length: 20 }, (_, ordinal) => ({
      ordinal,
      category: "message",
      nativeRecord: {
        role: "user",
        text: `turn ${ordinal} ${"x".repeat(3_000)}`,
      },
    }));
    vi.mocked(f.host.inspectDebugContextHistory).mockResolvedValue({
      status: "available",
      snapshot: {
        id: "snapshot",
        threadId: "thread",
        tailState: "clean",
        recordCount: records.length,
      },
      records,
    } as never);
    try {
      await f.coordinator.wake("A");
      const extractions = f.respond.mock.calls
        .map(([request]) => request)
        .filter((request) => stageOf(request) === "extract");
      expect(extractions.length).toBeGreaterThan(1);
      for (const request of extractions)
        expect(inputBytes(request)).toBeLessThanOrEqual(INPUT_BYTES);
      expect(f.stages().at(-1)).toBe("consolidate");
      expect(Object.values(f.documents.get("A")!.cursors)).toEqual([
        { thread_id: "thread", through: 19 },
      ]);
      // The window is the one of the model the stages run on.
      expect(f.contextWindow).toHaveBeenCalledOnce();
      expect(f.contextWindow.mock.calls[0]![0]).toEqual({
        placement: extractions[0]!.placement,
      });
    } finally {
      await f.coordinator.close();
    }
  });

  it("consolidates waiting sessions in batches that fit the window, least recently extracted first", async () => {
    const f = fixture({
      contextWindow: () => WINDOW,
      canReadHistory: () => false,
    });
    const candidate = (marker: string) => `${marker} ${"x".repeat(5_000)}`;
    f.documents.set("A", {
      revision: 10,
      summary: "",
      memory: "",
      cursors: {},
      sessions: {
        ["1".repeat(64)]: waitingSession(candidate("newest"), 3),
        ["2".repeat(64)]: waitingSession(candidate("oldest"), 1),
        ["3".repeat(64)]: waitingSession(candidate("middle"), 2),
      },
    });
    try {
      await f.coordinator.wake("A");
      expect(f.stages()).toEqual(["consolidate", "consolidate"]);
      const [first, second] = f.respond.mock.calls.map(([request]) => request);
      expect(first!.input).toContain("oldest");
      expect(first!.input).toContain("middle");
      expect(first!.input).not.toContain("newest");
      expect(inputBytes(first!)).toBeLessThanOrEqual(INPUT_BYTES);
      expect(second!.input).toContain("newest");
      expect(
        Object.values(f.documents.get("A")!.sessions).map(
          (session) => session.raw_memory,
        ),
      ).toEqual(["", "", ""]);
    } finally {
      await f.coordinator.close();
    }
  });

  it("consolidates a session alone when it does not fit the window by itself", async () => {
    const f = fixture({
      contextWindow: () => WINDOW,
      canReadHistory: () => false,
    });
    f.documents.set("A", {
      revision: 10,
      summary: "",
      memory: "",
      cursors: {},
      sessions: {
        ["1".repeat(64)]: waitingSession("y".repeat(40_000), 1),
      },
    });
    try {
      await f.coordinator.wake("A");
      expect(f.stages()).toEqual(["consolidate"]);
      expect(f.documents.get("A")!.memory).toContain("lantern-482");
      expect(f.documents.get("A")!.sessions["1".repeat(64)]!.raw_memory).toBe(
        "",
      );
    } finally {
      await f.coordinator.close();
    }
  });

  it("limits the Memory to half of the window's input and corrects a larger one", async () => {
    const f = fixture({ contextWindow: () => WINDOW });
    f.respond
      .mockImplementationOnce(async (request) => validOutput(request))
      .mockResolvedValueOnce({
        summary: "Orchard release",
        edits: [{ op: "add", heading: "Releases", content: "z".repeat(8_000) }],
      });
    try {
      await f.coordinator.wake("A");
      expect(f.stages()).toEqual(["extract", "consolidate", "consolidate"]);
      expect(f.respond.mock.calls[1]![0].instructions).toContain(
        "at most 7500 UTF-8 bytes",
      );
      expect(f.documents.get("A")!.memory).toBe(
        "## Releases\n\nRelease code: lantern-482\n",
      );
    } finally {
      await f.coordinator.close();
    }
  });

  it("uses a conservative 65,536-token fallback when the window is unknown and keeps the 200 KB cap for large windows", async () => {
    expect(memoryBudget(undefined)).toEqual({ input: 49_152, memory: 24_576 });
    expect(memoryBudget(65_536)).toEqual({ input: 49_152, memory: 24_576 });
    expect(memoryBudget(1_000_000)).toEqual({
      input: 400_000,
      memory: 200_000,
    });
    const unknownWindow = fixture({ contextWindow: () => undefined });
    const largeWindow = fixture({ contextWindow: () => 1_000_000 });
    try {
      await unknownWindow.coordinator.wake("A");
      expect(
        unknownWindow.respond.mock.calls.at(-1)![0].instructions,
      ).toContain("at most 24576 UTF-8 bytes");
      await largeWindow.coordinator.wake("A");
      expect(largeWindow.respond.mock.calls.at(-1)![0].instructions).toContain(
        "at most 200000 UTF-8 bytes",
      );
    } finally {
      await unknownWindow.coordinator.close();
      await largeWindow.coordinator.close();
    }
  });

  it("keeps dense CJK and JSON transcripts strictly under 65,536 tokens when contextWindow is unknown or 65,536", async () => {
    // Three-byte UTF-8 ideographs encoded via escapes to keep source English-only.
    const cjkChunk = "\u4e2d\u6587\u8bb0\u5fc6\u6d4b\u8bd5".repeat(400);
    const records = Array.from({ length: 40 }, (_, ordinal) => ({
      ordinal,
      category: "message",
      nativeRecord: {
        role: ordinal % 2 === 0 ? "user" : "assistant",
        text: `turn-${ordinal} ${cjkChunk}`,
        metadata: { step: ordinal, tags: ["json", "payload", "local"] },
      },
    }));
    for (const windowValue of [undefined, 65_536]) {
      const f = fixture({ contextWindow: () => windowValue });
      vi.mocked(f.host.inspectDebugContextHistory).mockResolvedValue({
        status: "available",
        snapshot: {
          id: "snapshot-cjk",
          threadId: "thread-cjk",
          tailState: "clean",
          recordCount: records.length,
        },
        records,
      } as never);
      try {
        await f.coordinator.wake("A");
        const extractions = f.respond.mock.calls
          .map(([request]) => request)
          .filter((request) => stageOf(request) === "extract");
        expect(extractions.length).toBeGreaterThan(1);
        for (const request of extractions) {
          const totalBytes = inputBytes(request);
          // Even at a pessimistic 1.5 UTF-8 bytes/token for CJK+JSON, every
          // batch stays around 32K tokens, well below a 65,536-token n_ctx.
          expect(totalBytes).toBeLessThanOrEqual(49_152);
          const worstCaseTokens = Math.ceil(totalBytes / 1.5);
          expect(worstCaseTokens).toBeLessThan(40_000);
          expect(totalBytes).toBeLessThan(65_536);
        }
        expect(Object.values(f.documents.get("A")!.cursors)).toEqual([
          { thread_id: "thread-cjk", through: 39 },
        ]);
      } finally {
        await f.coordinator.close();
      }
    }
  });

  it("adaptively shrinks extraction batches on invalid_request context overflow instead of looping", async () => {
    const f = fixture({ contextWindow: () => undefined });
    const records = Array.from({ length: 12 }, (_, ordinal) => ({
      ordinal,
      category: "message",
      nativeRecord: {
        role: "user",
        text: `item-${ordinal} ${"a".repeat(2_500)}`,
      },
    }));
    vi.mocked(f.host.inspectDebugContextHistory).mockResolvedValue({
      status: "available",
      snapshot: {
        id: "snapshot-shrink",
        threadId: "thread-shrink",
        tailState: "clean",
        recordCount: records.length,
      },
      records,
    } as never);
    // Simulate a smaller local n_ctx that rejects prompts above 12 KB.
    f.respond.mockImplementation(async (request) => {
      if (
        stageOf(request) === "extract" &&
        Buffer.byteLength(request.input, "utf8") > 12_000
      ) {
        throw new ModelCallError(
          "invalid_request",
          "request exceeds available context size",
        );
      }
      return validOutput(request);
    });
    try {
      await f.coordinator.wake("A");
      expect(Object.values(f.documents.get("A")!.cursors)).toEqual([
        { thread_id: "thread-shrink", through: 11 },
      ]);
      expect(f.documents.get("A")!.pending).toBeUndefined();
      expect(f.logger.log).toHaveBeenCalledWith(
        "warn",
        "agent_memory.batch_shrunk",
        expect.objectContaining({
          agentId: "A",
          stage: "extract",
          before_bytes: expect.any(Number),
          after_bytes: expect.any(Number),
        }),
      );
    } finally {
      await f.coordinator.close();
    }
  });

  it("does not drop healthy sibling records when invalid_request hits max shrink steps or an unshrinkable first record", async () => {
    const f = fixture({ contextWindow: () => 200_000 });
    // Build a persisted multi-record batch: record 0 is unclippable, records 1..2 are healthy.
    const sourceKey = "b".repeat(64);
    const hugeNumbers = Array.from({ length: 4_000 }, (_, i) => i);
    const pendingPrompt = JSON.stringify({
      source_context: "source",
      previous: null,
      records: [
        {
          ordinal: 0,
          category: "tool_result",
          nativeRecord: { numbers: hugeNumbers },
        },
        {
          ordinal: 1,
          category: "message",
          nativeRecord: { role: "user", text: "Keep sibling-one lantern-777." },
        },
        {
          ordinal: 2,
          category: "message",
          nativeRecord: { role: "user", text: "Keep sibling-two lantern-888." },
        },
      ],
    });
    f.documents.set("A", {
      revision: 1,
      summary: "",
      memory: "",
      sessions: {},
      cursors: {},
      pending: {
        stage: "extract",
        prompt: pendingPrompt,
        source_key: sourceKey,
        thread_id: "thread-siblings",
        through: 2,
      },
    });
    // Reject any prompt still containing record 0's huge numbers array.
    f.respond.mockImplementation(async (request) => {
      if (
        stageOf(request) === "extract" &&
        request.input.includes('"numbers":[0,1,2')
      ) {
        throw new ModelCallError(
          "invalid_request",
          "context_too_long: prompt exceeds window",
        );
      }
      return validOutput(request);
    });
    try {
      await f.coordinator.reconcile();
      const extractInputs = f.respond.mock.calls
        .map(([r]) => r)
        .filter((r) => stageOf(r) === "extract")
        .map((r) => r.input);
      // Record 0 was skipped individually while healthy sibling records 1..2
      // were preserved and extracted rather than silently dropped.
      expect(f.logger.log).toHaveBeenCalledWith(
        "warn",
        "agent_memory.record_skipped_oversized",
        expect.objectContaining({
          agentId: "A",
          source_key: sourceKey,
          ordinal: 0,
        }),
      );
      expect(extractInputs.at(-1)).toContain("sibling-one");
      expect(extractInputs.at(-1)).toContain("sibling-two");
      const after = f.documents.get("A")!;
      expect(after.cursors[sourceKey]).toEqual({
        thread_id: "thread-siblings",
        through: 2,
      });
      expect(after.pending).toBeUndefined();
    } finally {
      await f.coordinator.close();
    }
  });

  it("never skips a multi-record batch when MAX_SHRINK_STEPS_PER_PASS is exhausted", async () => {
    const f = fixture({ contextWindow: () => 200_000 });
    const sourceKey = "c".repeat(64);
    // 64 records of ~700 bytes (~45 KB): 4 halvings in one pass leave >2 KB
    // and multiple records, exhausting MAX_SHRINK_STEPS_PER_PASS without
    // advancing the cursor or dropping records.
    const records = Array.from({ length: 64 }, (_, ordinal) => ({
      ordinal,
      category: "message",
      nativeRecord: { role: "user", text: `msg-${ordinal} ${"x".repeat(650)}` },
    }));
    f.documents.set("A", {
      revision: 1,
      summary: "",
      memory: "",
      sessions: {},
      cursors: {},
      pending: {
        stage: "extract",
        prompt: JSON.stringify({
          source_context: "source",
          previous: null,
          records,
        }),
        source_key: sourceKey,
        thread_id: "thread-many",
        through: 63,
      },
    });
    f.respond.mockImplementation(async (request) => {
      if (
        stageOf(request) === "extract" &&
        Buffer.byteLength(request.input, "utf8") > 1_200
      ) {
        throw new ModelCallError("invalid_request", "context_too_long");
      }
      return validOutput(request);
    });
    try {
      await f.coordinator.reconcile();
      // Pass hit MAX_SHRINK_STEPS_PER_PASS (4) with >1 records remaining:
      // must keep the shrunk pending checkpoint and NOT advance the cursor.
      const afterFirst = f.documents.get("A")!;
      expect(afterFirst.cursors[sourceKey]).toBeUndefined();
      expect(afterFirst.pending).toBeDefined();
      const kept = (
        JSON.parse(afterFirst.pending!.prompt) as { records: unknown[] }
      ).records;
      expect(kept.length).toBeGreaterThan(1);
      expect(kept.length).toBeLessThan(64);
    } finally {
      await f.coordinator.close();
    }
  });

  it("does not permanently poison adaptiveInputBytes on transient failed outages and bounds indivisible failed records", async () => {
    const f = fixture({ contextWindow: () => 65_536 });
    const records = Array.from({ length: 12 }, (_, ordinal) => ({
      ordinal,
      category: "message",
      nativeRecord: {
        role: "user",
        text: `transient-${ordinal} ${"x".repeat(2_000)}`,
      },
    }));
    vi.mocked(f.host.inspectDebugContextHistory).mockResolvedValue({
      status: "available",
      snapshot: {
        id: "snapshot-transient",
        threadId: "thread-transient",
        tailState: "clean",
        recordCount: records.length,
      },
      records,
    } as never);
    // Simulate a transient 500 outage for the first 3 calls, then full recovery.
    let failCount = 0;
    f.respond.mockImplementation(async (request) => {
      if (stageOf(request) === "extract" && failCount < 3) {
        failCount += 1;
        throw new ModelCallError("failed", "500 temporary outage");
      }
      return validOutput(request);
    });
    try {
      await f.coordinator.wake("A");
      f.advance(60_000);
      await f.coordinator.wake("A");
      f.advance(2 * 60_000);
      await f.coordinator.wake("A");
      f.advance(4 * 60_000);
      await f.coordinator.wake("A");
      const completedExtracts = f.respond.mock.calls
        .slice(3)
        .map(([r]) => r)
        .filter((r) => stageOf(r) === "extract");
      // The second post-recovery extraction batch must use the full 65K budget
      // (not be stuck at 4 KB from transient failures).
      expect(completedExtracts.length).toBeGreaterThanOrEqual(2);
      const nextBatchBytes = Buffer.byteLength(
        completedExtracts[1]!.input,
        "utf8",
      );
      expect(nextBatchBytes).toBeGreaterThan(10_000);
      expect(Object.values(f.documents.get("A")!.cursors)).toEqual([
        { thread_id: "thread-transient", through: 11 },
      ]);
    } finally {
      await f.coordinator.close();
    }

    // Indivisible / tiny record under persistent "failed" must spend attempts and stop.
    const f2 = fixture({ contextWindow: () => 65_536 });
    f2.respond.mockRejectedValue(
      new ModelCallError("failed", "persistent error"),
    );
    try {
      await f2.coordinator.wake("A");
      expect(f2.documents.get("A")!.pending?.attempt).toBe(1);
      f2.advance(60_000);
      await f2.coordinator.wake("A");
      expect(f2.documents.get("A")!.pending?.attempt).toBe(2);
      f2.advance(2 * 60_000);
      await f2.coordinator.wake("A");
      expect(f2.documents.get("A")!.pending?.attempt).toBe(3);
      const callsAtCap = f2.respond.mock.calls.length;
      f2.advance(4 * 60_000);
      await f2.coordinator.wake("A");
      expect(f2.respond).toHaveBeenCalledTimes(callsAtCap);
    } finally {
      await f2.coordinator.close();
    }
  });

  it("self-heals and shrinks oversized consolidate prompts including previous.memory while preserving memory_sections", async () => {
    const f = fixture({
      contextWindow: () => 65_536,
      canReadHistory: () => false,
    });
    const largeMemory = Array.from(
      { length: 20 },
      (_, idx) => `## Topic ${idx}\n\n${"m".repeat(5_000)}\n`,
    ).join("\n");
    const largeSummary = "s".repeat(12_000);
    const sessionKey = "d".repeat(64);
    f.documents.set("A", {
      revision: 5,
      summary: largeSummary,
      memory: largeMemory,
      cursors: {},
      sessions: {
        [sessionKey]: waitingSession("candidate facts", 5),
      },
    });
    // Also reject prompts above 20 KB to exercise invalid_request shrinking of previous.memory.
    f.respond.mockImplementation(async (request) => {
      if (
        stageOf(request) === "consolidate" &&
        Buffer.byteLength(request.input, "utf8") > 20_000
      ) {
        throw new ModelCallError(
          "invalid_request",
          "context_too_long: consolidate exceeded window",
        );
      }
      // Remove all existing topics so the edited memory fits the tighter 65K memory limit.
      const parsed = JSON.parse(request.input) as { memory_sections: string[] };
      return {
        summary: "Compact summary",
        edits: [
          ...parsed.memory_sections.map((heading) => ({
            op: "delete",
            heading,
            content: "",
          })),
          {
            op: "add",
            heading: "Releases",
            content: "Release code: lantern-482",
          },
        ],
      };
    });
    try {
      await f.coordinator.wake("A");
      const calls = f.respond.mock.calls
        .map(([r]) => r)
        .filter((r) => stageOf(r) === "consolidate");
      expect(calls.length).toBeGreaterThanOrEqual(2);
      // Even the initial consolidate prompt was trimmed below the 65K budget (including schema bytes).
      expect(inputBytes(calls[0]!)).toBeLessThanOrEqual(49_152);
      // After invalid_request shrink, final call fit <= 20 KB while preserving all 20 memory_sections!
      const finalPayload = JSON.parse(calls.at(-1)!.input) as {
        previous: { summary: string; memory: string };
        memory_sections: string[];
      };
      expect(
        Buffer.byteLength(calls.at(-1)!.input, "utf8"),
      ).toBeLessThanOrEqual(20_000);
      expect(finalPayload.memory_sections).toHaveLength(20);
      expect(f.documents.get("A")!.memory).toContain("lantern-482");
      expect(f.documents.get("A")!.pending).toBeUndefined();
    } finally {
      await f.coordinator.close();
    }
  });

  it("self-heals an oversized persisted consolidate checkpoint before invoking the model", async () => {
    const f = fixture({
      contextWindow: () => 65_536,
      canReadHistory: () => false,
    });
    const hugeMemory = Array.from(
      { length: 20 },
      (_, idx) => `## Section ${idx}\n\n${"k".repeat(4_000)}\n`,
    ).join("\n");
    const sessionKey = "e".repeat(64);
    const oversizedPrompt = JSON.stringify({
      previous: { summary: "s".repeat(10_000), memory: hugeMemory },
      memory_sections: Array.from({ length: 20 }, (_, idx) => `Section ${idx}`),
      extractions: [
        {
          key: sessionKey,
          context_key: "source",
          summary: "sum",
          raw_memory: "r".repeat(20_000),
        },
      ],
    });
    expect(Buffer.byteLength(oversizedPrompt, "utf8")).toBeGreaterThan(100_000);
    f.documents.set("A", {
      revision: 2,
      summary: "",
      memory: "",
      cursors: {},
      sessions: { [sessionKey]: waitingSession("r".repeat(20_000), 2) },
      pending: { stage: "consolidate", prompt: oversizedPrompt },
    });
    try {
      await f.coordinator.reconcile();
      const firstCall = f.respond.mock.calls[0]![0];
      expect(stageOf(firstCall)).toBe("consolidate");
      expect(inputBytes(firstCall)).toBeLessThanOrEqual(49_152);
      expect(f.documents.get("A")!.pending).toBeUndefined();
      expect(f.logger.log).toHaveBeenCalledWith(
        "info",
        "agent_memory.batch_shrunk",
        expect.objectContaining({
          agentId: "A",
          stage: "consolidate",
          before_bytes: expect.any(Number),
          after_bytes: expect.any(Number),
          reason: "budget",
        }),
      );
    } finally {
      await f.coordinator.close();
    }
  });

  it("shrinks an oversized batch on failed Pi calls across backoff and recovers", async () => {
    const f = fixture({ contextWindow: () => undefined });
    const records = Array.from({ length: 10 }, (_, ordinal) => ({
      ordinal,
      category: "message",
      nativeRecord: {
        role: "user",
        text: `pi-item-${ordinal} ${"\u4e2d".repeat(1_000)}`,
      },
    }));
    vi.mocked(f.host.inspectDebugContextHistory).mockResolvedValue({
      status: "available",
      snapshot: {
        id: "snapshot-pi",
        threadId: "thread-pi",
        tailState: "clean",
        recordCount: records.length,
      },
      records,
    } as never);
    // Pi redacts provider 400 context-overflow errors to a generic failed outcome.
    f.respond.mockImplementation(async (request) => {
      if (
        stageOf(request) === "extract" &&
        Buffer.byteLength(request.input, "utf8") > 18_000
      ) {
        throw new ModelCallError(
          "failed",
          "Model invocation failed: Pi background call did not complete",
        );
      }
      return validOutput(request);
    });
    try {
      await f.coordinator.wake("A");
      expect(f.documents.get("A")!.pending?.stage).toBe("extract");
      expect(
        Buffer.byteLength(f.documents.get("A")!.pending!.prompt, "utf8"),
      ).toBeLessThanOrEqual(18_000);
      // First backoff extracts the shrunk first slice and shrinks the remainder.
      f.advance(60_000);
      await f.coordinator.wake("A");
      expect(Object.values(f.documents.get("A")!.cursors)).toEqual([
        { thread_id: "thread-pi", through: 3 },
      ]);
      // Next backoff finishes the remaining slices without poisoning adaptiveInputBytes.
      f.advance(2 * 60_000);
      await f.coordinator.wake("A");
      expect(Object.values(f.documents.get("A")!.cursors)).toEqual([
        { thread_id: "thread-pi", through: 9 },
      ]);
      expect(f.documents.get("A")!.pending).toBeUndefined();
    } finally {
      await f.coordinator.close();
    }
  });

  it("skips an indivisible oversized record rather than looping forever", async () => {
    const f = fixture({ contextWindow: () => 20_000 });
    // Build one record whose unclippable JSON structure alone exceeds room, followed by a normal record.
    const hugeArray = Array.from({ length: 6_000 }, (_, i) => i);
    const records = [
      {
        ordinal: 0,
        category: "tool_result",
        nativeRecord: { numbers: hugeArray },
      },
      {
        ordinal: 1,
        category: "message",
        nativeRecord: { role: "user", text: "Keep lantern-482 alive." },
      },
    ];
    vi.mocked(f.host.inspectDebugContextHistory).mockResolvedValue({
      status: "available",
      snapshot: {
        id: "snapshot-oversized",
        threadId: "thread-oversized",
        tailState: "clean",
        recordCount: records.length,
      },
      records,
    } as never);
    try {
      await f.coordinator.wake("A");
      expect(f.logger.log).toHaveBeenCalledWith(
        "warn",
        "agent_memory.record_skipped_oversized",
        expect.objectContaining({
          agentId: "A",
          ordinal: 0,
          source_key: expect.any(String),
          room_bytes: expect.any(Number),
        }),
      );
      expect(f.stages()).toEqual(["extract", "consolidate"]);
      expect(f.respond.mock.calls[0]![0].input).toContain("lantern-482");
      expect(Object.values(f.documents.get("A")!.cursors)).toEqual([
        { thread_id: "thread-oversized", through: 1 },
      ]);
    } finally {
      await f.coordinator.close();
    }
  });

  it("self-heals an oversized persisted pending checkpoint before invoking the model", async () => {
    const f = fixture({ contextWindow: () => undefined });
    const sourceKey = "a".repeat(64);
    const legacyRecords = Array.from({ length: 30 }, (_, ordinal) => ({
      ordinal,
      category: "message",
      nativeRecord: {
        role: "user",
        text: `legacy-${ordinal} ${"x".repeat(3_500)}`,
      },
    }));
    const legacyPrompt = JSON.stringify({
      source_context: "source",
      previous: null,
      records: legacyRecords,
    });
    expect(Buffer.byteLength(legacyPrompt, "utf8")).toBeGreaterThan(100_000);
    f.documents.set("A", {
      revision: 1,
      summary: "",
      memory: "",
      sessions: {},
      cursors: {},
      pending: {
        stage: "extract",
        prompt: legacyPrompt,
        source_key: sourceKey,
        thread_id: "thread-legacy",
        through: 29,
      },
    });
    try {
      await f.coordinator.reconcile();
      const firstExtract = f.respond.mock.calls[0]![0];
      expect(stageOf(firstExtract)).toBe("extract");
      expect(inputBytes(firstExtract)).toBeLessThanOrEqual(49_152);
      expect(f.documents.get("A")!.pending).toBeUndefined();
    } finally {
      await f.coordinator.close();
    }
  });

  it("opens a circuit breaker after repeated unavailable-model failures and resets after a succeeded Run", async () => {
    const f = fixture();
    f.respond.mockRejectedValue(
      new ModelCallError(
        "runtime_unavailable",
        "Local Computer Runtime pi is unavailable",
      ),
    );
    try {
      // Five failures with exponential backoff (1m, 2m, 4m, 8m) trip the circuit.
      await f.coordinator.wake("A");
      expect(f.respond).toHaveBeenCalledTimes(1);
      f.advance(60_000);
      await f.coordinator.reconcile();
      expect(f.respond).toHaveBeenCalledTimes(2);
      f.advance(2 * 60_000);
      await f.coordinator.reconcile();
      expect(f.respond).toHaveBeenCalledTimes(3);
      f.advance(4 * 60_000);
      await f.coordinator.reconcile();
      expect(f.respond).toHaveBeenCalledTimes(4);
      f.advance(8 * 60_000);
      await f.coordinator.reconcile();
      expect(f.respond).toHaveBeenCalledTimes(5);
      expect(f.logger.log).toHaveBeenCalledWith(
        "warn",
        "agent_memory.circuit_opened",
        expect.objectContaining({
          agentId: "A",
          failures: 5,
          cooldown_ms: 6 * 60 * 60_000,
        }),
      );

      // Even after 2 hours, the open circuit suppresses reconcile and wake calls.
      f.advance(2 * 60 * 60_000);
      await f.coordinator.reconcile();
      await f.coordinator.wake("A");
      expect(f.respond).toHaveBeenCalledTimes(5);

      // Once the model recovers and a real Run succeeds, recordRun reopens maintenance.
      f.respond.mockImplementation(async (request) => validOutput(request));
      await f.coordinator.recordRun("A");
      await f.coordinator.reconcile();
      expect(f.documents.get("A")!.pending).toBeUndefined();
      expect(f.respond).toHaveBeenCalledTimes(6);
    } finally {
      await f.coordinator.close();
    }
  });

  it("builds no stage while the window cannot be read and backs off", async () => {
    const contextWindow = vi.fn((): number | undefined => {
      throw new Error("Local Computer is offline");
    });
    const f = fixture({ contextWindow });
    try {
      await f.coordinator.wake("A");
      expect(f.respond).not.toHaveBeenCalled();
      expect(f.documents.get("A")).toBeUndefined();
      expect(f.logger.log).toHaveBeenCalledWith(
        "warn",
        "agent_memory.reconcile_failed",
        expect.objectContaining({ agentId: "A" }),
      );
      contextWindow.mockReturnValue(WINDOW);
      f.advance(60_000);
      await f.coordinator.wake("A");
      expect(f.stages()).toEqual(["extract", "consolidate"]);
    } finally {
      await f.coordinator.close();
    }
  });
});
