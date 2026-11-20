package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/localmodels"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

// fakeModelInvoker holds each call until release or cancellation.
type fakeModelInvoker struct {
	mu       sync.Mutex
	started  chan provider.ModelInvokeRequest
	release  chan struct{}
	requests []provider.ModelInvokeRequest
}

func newFakeModelInvoker() *fakeModelInvoker {
	return &fakeModelInvoker{started: make(chan provider.ModelInvokeRequest, 8), release: make(chan struct{})}
}

func (f *fakeModelInvoker) Close() {}

func (f *fakeModelInvoker) Invoke(ctx context.Context, request provider.ModelInvokeRequest) provider.ModelInvokeResult {
	f.mu.Lock()
	f.requests = append(f.requests, request)
	f.mu.Unlock()
	f.started <- request
	select {
	case <-f.release:
		return provider.ModelInvokeResult{
			Outcome: provider.ModelInvokeCompleted, Text: `{"answer":"ok"}`, Model: "fixture-model", RuntimeVersion: "0.166.0",
			Usage: &provider.ModelInvokeUsage{InputTokens: 10, CachedInputTokens: 2, OutputTokens: 3},
		}
	case <-ctx.Done():
		return provider.ModelInvokeResult{Outcome: provider.ModelInvokeCanceled, Reason: "Model invocation was canceled"}
	}
}

func (f *fakeModelInvoker) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

func modelInvokeFixture(t *testing.T, invoker ModelInvoker) (*Daemon, *fakeStream) {
	t.Helper()
	stream := &fakeStream{}
	d, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream}, IdentityStore: fakeStore{},
		OperationResolver: prepareOperationResolver{workingDirectory: t.TempDir()},
		ModelInvoker:      invoker,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.WaitForOperations)
	return d, stream
}

func modelInvokeCommand(invokeID string, payload map[string]any) protocol.Command {
	body := map[string]any{
		"invoke_id": invokeID, "mode": "structured", "reasoning_effort": "low", "instructions": "Answer.",
		"input": "Question", "output_schema": map[string]any{"type": "object"}, "timeout_ms": 30000,
	}
	for key, value := range payload {
		body[key] = value
	}
	return protocol.Command{
		Type: protocol.CommandModelInvoke, CommandID: "command-" + invokeID, ProtocolVersion: "1.2",
		RunnerID: "computer-1", ConnectionEpoch: 1, TenantID: "tenant-1", OwnerActorID: "owner-1", AgentID: "agent-1",
		RuntimeType: "codex", Payload: mustJSON(body),
	}
}

func waitForModelInvoked(t *testing.T, stream *fakeStream, invokeID string) map[string]any {
	t.Helper()
	watchdog := time.After(5 * time.Second)
	for {
		for _, event := range stream.snapshotEvents() {
			var payload map[string]any
			_ = json.Unmarshal(event.Payload, &payload)
			if event.Type == protocol.EventModelInvoked && payload["invoke_id"] == invokeID {
				return payload
			}
		}
		select {
		case <-watchdog:
			t.Fatalf("no model.invoked for %s", invokeID)
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestModelInvokeRunsTheCallAndReportsItsResult(t *testing.T) {
	for _, runtime := range []string{"codex", "pi"} {
		t.Run(runtime, func(t *testing.T) {
			invoker := newFakeModelInvoker()
			d, stream := modelInvokeFixture(t, invoker)
			command := modelInvokeCommand("invoke-1", map[string]any{"session_key": "permission-review:abc"})
			command.RuntimeType = runtime
			if err := d.handleModelInvoke(context.Background(), stream, command); err != nil {
				t.Fatal(err)
			}
			request := <-invoker.started
			if request.RuntimeType != runtime || request.Mode != "structured" || request.ReasoningEffort != "low" ||
				request.Instructions != "Answer." || request.Input != "Question" || string(request.OutputSchema) != `{"type":"object"}` ||
				request.Timeout != 30*time.Second || request.SessionKey != "permission-review:abc" {
				t.Fatalf("request = %+v", request)
			}
			close(invoker.release)
			payload := waitForModelInvoked(t, stream, "invoke-1")
			if payload["outcome"] != "completed" || payload["text"] != `{"answer":"ok"}` || payload["model"] != "fixture-model" ||
				payload["runtime_version"] != "0.166.0" || payload["command_id"] != "command-invoke-1" || payload["runner_id"] != "computer-1" ||
				payload["reason"] != nil {
				t.Fatalf("payload = %v", payload)
			}
			usage, _ := payload["usage"].(map[string]any)
			if usage["input_tokens"] != float64(10) || usage["cached_input_tokens"] != float64(2) || usage["output_tokens"] != float64(3) {
				t.Fatalf("usage = %v", usage)
			}
		})
	}
}

func TestModelInvokeRunsEveryCallItReceives(t *testing.T) {
	invoker := newFakeModelInvoker()
	d, stream := modelInvokeFixture(t, invoker)
	// The Agent Service's scheduler bounds concurrency; the Daemon has no cap.
	running := make([]string, 0, 5)
	for index := range 5 {
		id := fmt.Sprintf("invoke-%d", index+1)
		if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand(id, nil)); err != nil {
			t.Fatal(err)
		}
		<-invoker.started
		running = append(running, id)
	}
	close(invoker.release)
	for _, id := range running {
		if payload := waitForModelInvoked(t, stream, id); payload["outcome"] != "completed" {
			t.Fatalf("%s payload = %v", id, payload)
		}
	}
	if invoker.calls() != len(running) {
		t.Fatalf("calls = %d", invoker.calls())
	}
}

func TestModelInvokeIsCanceledByDisconnectAndDrain(t *testing.T) {
	for name, stop := range map[string]func(*Daemon, context.CancelFunc){
		"connection lost": func(_ *Daemon, cancelConnection context.CancelFunc) { cancelConnection() },
		"connection cleanup": func(d *Daemon, _ context.CancelFunc) {
			d.cancelModelInvokes("connection_lost")
		},
		"drain": func(d *Daemon, _ context.CancelFunc) { d.Drain(); d.WaitForOperations() },
	} {
		t.Run(name, func(t *testing.T) {
			invoker := newFakeModelInvoker()
			d, stream := modelInvokeFixture(t, invoker)
			connectionCtx, cancelConnection := context.WithCancel(context.Background())
			defer cancelConnection()
			if err := d.handleModelInvoke(connectionCtx, stream, modelInvokeCommand("invoke-stop", nil)); err != nil {
				t.Fatal(err)
			}
			<-invoker.started
			stop(d, cancelConnection)
			payload := waitForModelInvoked(t, stream, "invoke-stop")
			if payload["outcome"] != "canceled" || payload["text"] != nil {
				t.Fatalf("payload = %v", payload)
			}
			d.WaitForOperations()
			if len(d.modelInvokes) != 0 {
				t.Fatalf("in-flight calls = %v", d.modelInvokes)
			}
		})
	}
}

func TestModelInvokeCancelStopsOnlyThatCall(t *testing.T) {
	invoker := newFakeModelInvoker()
	d, stream := modelInvokeFixture(t, invoker)
	for _, id := range []string{"invoke-keep", "invoke-yield"} {
		if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand(id, nil)); err != nil {
			t.Fatal(err)
		}
		<-invoker.started
	}
	cancel := func(id string) protocol.Command {
		return protocol.Command{
			Type: protocol.CommandModelInvokeCancel, CommandID: "cancel-" + id, RunnerID: "computer-1", ConnectionEpoch: 1,
			Payload: mustJSON(map[string]any{"invoke_id": id, "reason": "scheduler_yield"}),
		}
	}
	if err := d.cancelModelInvoke(cancel("invoke-yield")); err != nil {
		t.Fatal(err)
	}
	if payload := waitForModelInvoked(t, stream, "invoke-yield"); payload["outcome"] != "canceled" {
		t.Fatalf("payload = %v", payload)
	}
	// A cancel that arrives after its call was answered does nothing.
	if err := d.cancelModelInvoke(cancel("invoke-yield")); err != nil {
		t.Fatal(err)
	}
	close(invoker.release)
	if payload := waitForModelInvoked(t, stream, "invoke-keep"); payload["outcome"] != "completed" {
		t.Fatalf("payload = %v", payload)
	}
}

func TestModelInvokeRefusesWithoutRunningTheCall(t *testing.T) {
	for name, test := range map[string]struct {
		setup   func(*Daemon)
		payload map[string]any
		outcome string
	}{
		"draining":           {setup: func(d *Daemon) { d.draining = true }, outcome: "unavailable"},
		"locally stopped":    {setup: func(d *Daemon) { d.locallyStopped["agent-1"] = true }, outcome: "unavailable"},
		"structured without": {payload: map[string]any{"output_schema": nil}, outcome: "failed"},
		"unknown effort":     {payload: map[string]any{"reasoning_effort": "xhigh"}, outcome: "failed"},
		"text with files": {payload: map[string]any{
			"mode": "text", "workspace_files": []map[string]any{{"path": "a.md", "content_base64": "YQ=="}},
		}, outcome: "failed"},
	} {
		t.Run(name, func(t *testing.T) {
			invoker := newFakeModelInvoker()
			d, stream := modelInvokeFixture(t, invoker)
			if test.setup != nil {
				test.setup(d)
			}
			if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand("invoke-refused", test.payload)); err != nil {
				t.Fatal(err)
			}
			if payload := waitForModelInvoked(t, stream, "invoke-refused"); payload["outcome"] != test.outcome || payload["reason"] == nil {
				t.Fatalf("payload = %v", payload)
			}
			if invoker.calls() != 0 {
				t.Fatal("a refused call ran")
			}
		})
	}
}

func TestModelInvokeWithoutAnInvokerAnswersRuntimeUnavailable(t *testing.T) {
	d, stream := modelInvokeFixture(t, nil)
	if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand("invoke-none", nil)); err != nil {
		t.Fatal(err)
	}
	if payload := waitForModelInvoked(t, stream, "invoke-none"); payload["outcome"] != "runtime_unavailable" {
		t.Fatalf("payload = %v", payload)
	}
}

func TestModelInvokeCarriesWorkspaceFilesBothWays(t *testing.T) {
	invoker := &workspaceModelInvoker{}
	d, stream := modelInvokeFixture(t, invoker)
	command := modelInvokeCommand("invoke-files", map[string]any{
		"mode": "workspace", "output_schema": nil,
		"workspace_files": []map[string]any{{"path": "raw/a.md", "content_base64": "aGVsbG8="}},
	})
	if err := d.handleModelInvoke(context.Background(), stream, command); err != nil {
		t.Fatal(err)
	}
	payload := waitForModelInvoked(t, stream, "invoke-files")
	files, _ := payload["workspace_files"].([]any)
	if payload["outcome"] != "completed" || len(files) != 1 {
		t.Fatalf("payload = %v", payload)
	}
	file, _ := files[0].(map[string]any)
	if file["path"] != "pages/a.json" || file["content_base64"] != "e30=" {
		t.Fatalf("file = %v", file)
	}
	if len(invoker.request.WorkspaceFiles) != 1 || string(invoker.request.WorkspaceFiles[0].Content) != "hello" {
		t.Fatalf("request files = %+v", invoker.request.WorkspaceFiles)
	}
}

type workspaceModelInvoker struct{ request provider.ModelInvokeRequest }

func (w *workspaceModelInvoker) Close() {}

func (w *workspaceModelInvoker) Invoke(_ context.Context, request provider.ModelInvokeRequest) provider.ModelInvokeResult {
	w.request = request
	return provider.ModelInvokeResult{
		Outcome: provider.ModelInvokeCompleted, Text: "",
		WorkspaceFiles: []provider.ModelInvokeFile{{Path: "pages/a.json", Content: []byte("{}")}},
	}
}

// A reply within the text and tree bounds can still encode past the frame
// limit; it is reported as failed instead of closing the connection.
func TestModelInvokeDegradesAReplyLargerThanAFrame(t *testing.T) {
	invoker := &oversizedModelInvoker{}
	d, stream := modelInvokeFixture(t, invoker)
	if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand("invoke-big", map[string]any{"mode": "text", "output_schema": nil})); err != nil {
		t.Fatal(err)
	}
	payload := waitForModelInvoked(t, stream, "invoke-big")
	if payload["outcome"] != "failed" || payload["text"] != nil || payload["workspace_files"] != nil ||
		!strings.Contains(fmt.Sprint(payload["reason"]), "frame limit") {
		t.Fatalf("payload outcome = %v reason = %v", payload["outcome"], payload["reason"])
	}
	for _, event := range stream.snapshotEvents() {
		if len(event.Payload) > transport.MaxFrameBytes {
			t.Fatalf("sent a %d byte frame", len(event.Payload))
		}
	}
}

type oversizedModelInvoker struct{}

func (oversizedModelInvoker) Close() {}

func (oversizedModelInvoker) Invoke(context.Context, provider.ModelInvokeRequest) provider.ModelInvokeResult {
	// Control characters escape to six bytes each in JSON.
	text := strings.Repeat("\x01", provider.ModelInvokeMaxTextBytes)
	files := []provider.ModelInvokeFile{{Path: "pages/a.json", Content: make([]byte, provider.ModelInvokeMaxWorkspaceBytes)}}
	return provider.ModelInvokeResult{Outcome: provider.ModelInvokeCompleted, Text: text, WorkspaceFiles: files}
}

// stoppedModelInvoker answers every call as a session call that stopped early.
type stoppedModelInvoker struct {
	request chan provider.ModelInvokeRequest
}

func (s stoppedModelInvoker) Close() {}

func (s stoppedModelInvoker) Invoke(_ context.Context, request provider.ModelInvokeRequest) provider.ModelInvokeResult {
	s.request <- request
	return provider.ModelInvokeResult{Outcome: provider.ModelInvokeOutputLimited, Reason: "Model reply exceeded its output limit", Text: `{"actions":[{"p`}
}

func TestModelInvokeCarriesTheCapAndWhatAStoppedCallStreamed(t *testing.T) {
	invoker := stoppedModelInvoker{request: make(chan provider.ModelInvokeRequest, 1)}
	d, stream := modelInvokeFixture(t, invoker)
	if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand("invoke-1", map[string]any{"max_output_chars": 24000})); err != nil {
		t.Fatal(err)
	}
	if request := <-invoker.request; request.MaxOutputChars != 24000 {
		t.Fatalf("request = %+v", request)
	}
	payload := waitForModelInvoked(t, stream, "invoke-1")
	if payload["outcome"] != "output_limited" || payload["text"] != `{"actions":[{"p` || payload["reason"] != "Model reply exceeded its output limit" || payload["usage"] != nil {
		t.Fatalf("payload = %v", payload)
	}
}

func TestModelInvokeNormalizesUnsupportedEffortForTargetModel(t *testing.T) {
	tests := []struct {
		name        string
		runtimeType string
		models      []provider.RuntimeModel
		requested   string
		want        string
	}{
		{
			name:        "spark pi medium clamps to declared high default",
			runtimeType: "pi",
			models: []provider.RuntimeModel{{
				ID:                     "localmodels/Spark-X2.6-4B-Q8_0",
				Label:                  "Spark-X2.6-4B-Q8_0",
				AllowedReasoningEffort: []string{"low", "high"},
				DefaultReasoningEffort: "high",
				IsDefault:              true,
			}},
			requested: "medium",
			want:      "high",
		},
		{
			name:        "spark pi medium clamps to declared low default",
			runtimeType: "pi",
			models: []provider.RuntimeModel{{
				ID:                     "localmodels/Spark-X2.6-4B-Q8_0",
				Label:                  "Spark-X2.6-4B-Q8_0",
				AllowedReasoningEffort: []string{"low", "high"},
				DefaultReasoningEffort: "low",
				IsDefault:              true,
			}},
			requested: "medium",
			want:      "low",
		},
		{
			name:        "spark pi medium without default clamps upward to high",
			runtimeType: "pi",
			models: []provider.RuntimeModel{{
				ID:                     "localmodels/Spark-X2.6-4B-Q8_0",
				Label:                  "Spark-X2.6-4B-Q8_0",
				AllowedReasoningEffort: []string{"low", "high"},
				IsDefault:              true,
			}},
			requested: "medium",
			want:      "high",
		},
		{
			name:        "spark pi preserves allowed low",
			runtimeType: "pi",
			models: []provider.RuntimeModel{{
				ID:                     "localmodels/Spark-X2.6-4B-Q8_0",
				Label:                  "Spark-X2.6-4B-Q8_0",
				AllowedReasoningEffort: []string{"low", "high"},
				DefaultReasoningEffort: "high",
				IsDefault:              true,
			}},
			requested: "low",
			want:      "low",
		},
		{
			name:        "non-reasoning pi model clears thinking effort",
			runtimeType: "pi",
			models: []provider.RuntimeModel{{
				ID:                     "localmodels/plain-model",
				Label:                  "Plain Model",
				AllowedReasoningEffort: []string{},
				IsDefault:              true,
			}},
			requested: "medium",
			want:      "",
		},
		{
			name:        "codex model clamps medium when only low and high are allowed",
			runtimeType: "codex",
			models: []provider.RuntimeModel{{
				ID:                     "custom-model",
				Label:                  "Custom Model",
				AllowedReasoningEffort: []string{"low", "high"},
				DefaultReasoningEffort: "high",
				IsDefault:              true,
			}},
			requested: "medium",
			want:      "high",
		},
		{
			name:        "claude none-only model normalizes to none",
			runtimeType: "claude",
			models: []provider.RuntimeModel{{
				ID:                     "claude-none",
				Label:                  "Claude None",
				AllowedReasoningEffort: []string{"none"},
				IsDefault:              true,
			}},
			requested: "medium",
			want:      "none",
		},
		{
			name:        "pi filters unsupported ultra effort from allowed list",
			runtimeType: "pi",
			models: []provider.RuntimeModel{{
				ID:                     "localmodels/Spark-X2.6-4B-Q8_0",
				Label:                  "Spark-X2.6-4B-Q8_0",
				AllowedReasoningEffort: []string{"low", "ultra"},
				IsDefault:              true,
			}},
			requested: "high",
			want:      "low",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			invoker := newFakeModelInvoker()
			stream := &fakeStream{}
			diagnostics := mustJSON([]provider.RuntimeDiagnostic{{
				Type:   tc.runtimeType,
				Status: "ready",
				Models: tc.models,
			}})
			d, err := newTestDaemon(t, Options{
				ComputerID:         "computer-1",
				ControlPlane:       fakeControlPlane{stream: stream},
				IdentityStore:      fakeStore{},
				OperationResolver:  prepareOperationResolver{workingDirectory: t.TempDir()},
				ModelInvoker:       invoker,
				Runtimes:           []string{tc.runtimeType},
				RuntimeDiagnostics: diagnostics,
			})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(d.WaitForOperations)

			command := modelInvokeCommand("invoke-effort", map[string]any{"reasoning_effort": tc.requested})
			command.RuntimeType = tc.runtimeType
			if err := d.handleModelInvoke(context.Background(), stream, command); err != nil {
				t.Fatal(err)
			}
			request := <-invoker.started
			if request.ReasoningEffort != tc.want {
				t.Fatalf("normalized ReasoningEffort = %q; want %q", request.ReasoningEffort, tc.want)
			}
			close(invoker.release)
			if payload := waitForModelInvoked(t, stream, "invoke-effort"); payload["outcome"] != "completed" {
				t.Fatalf("payload = %v", payload)
			}
		})
	}
}

type scriptedModelInvoker struct {
	mu      sync.Mutex
	calls   int
	result  provider.ModelInvokeResult
	started chan string
	release chan struct{}
}

func (s *scriptedModelInvoker) Close() {}

func (s *scriptedModelInvoker) Invoke(ctx context.Context, _ provider.ModelInvokeRequest) provider.ModelInvokeResult {
	s.mu.Lock()
	s.calls++
	callNum := s.calls
	started := s.started
	release := s.release
	s.mu.Unlock()
	if started != nil {
		started <- fmt.Sprintf("call-%d", callNum)
	}
	if release != nil {
		select {
		case <-release:
		case <-ctx.Done():
			return provider.ModelInvokeResult{Outcome: provider.ModelInvokeCanceled, Reason: "Model invocation was canceled"}
		}
	}
	s.mu.Lock()
	result := s.result
	s.mu.Unlock()
	if result.Outcome == provider.ModelInvokeCompleted && result.Text == "" {
		result.Text = `{"answer":"ok"}`
		result.Model = "fixture-model"
	}
	return result
}

func (s *scriptedModelInvoker) callCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

func (s *scriptedModelInvoker) setResult(result provider.ModelInvokeResult) {
	s.mu.Lock()
	s.result = result
	s.mu.Unlock()
}

func TestModelInvokeBacksOffAfterRepeatedAvailabilityFailuresAndRecovers(t *testing.T) {
	invoker := &scriptedModelInvoker{
		result: provider.ModelInvokeResult{
			Outcome: provider.ModelInvokeRuntimeUnavailable,
			Reason:  "Pi background model service is unavailable",
		},
	}
	d, stream := modelInvokeFixture(t, invoker)
	clock := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	d.now = func() time.Time { return clock }

	runCall := func(id string) map[string]any {
		t.Helper()
		cmd := modelInvokeCommand(id, nil)
		cmd.RuntimeType = "pi"
		if err := d.handleModelInvoke(context.Background(), stream, cmd); err != nil {
			t.Fatal(err)
		}
		return waitForModelInvoked(t, stream, id)
	}

	// First three consecutive availability failures execute and open the circuit breaker.
	for i := range modelInvokeBreakerThreshold {
		payload := runCall(fmt.Sprintf("fail-%d", i+1))
		if payload["outcome"] != provider.ModelInvokeRuntimeUnavailable {
			t.Fatalf("fail-%d outcome = %v", i+1, payload["outcome"])
		}
	}
	if invoker.callCount() != modelInvokeBreakerThreshold {
		t.Fatalf("calls = %d; want %d", invoker.callCount(), modelInvokeBreakerThreshold)
	}

	// Immediate follow-up calls are rejected without spawning another process.
	for i := range 3 {
		payload := runCall(fmt.Sprintf("blocked-%d", i+1))
		if payload["outcome"] != provider.ModelInvokeRuntimeUnavailable {
			t.Fatalf("blocked-%d payload = %v; want runtime_unavailable", i+1, payload)
		}
	}
	if invoker.callCount() != modelInvokeBreakerThreshold {
		t.Fatalf("blocked calls invoked runtime: count = %d", invoker.callCount())
	}

	// After the initial 30s backoff, one half-open probe runs; failure doubles backoff to 60s.
	clock = clock.Add(modelInvokeBreakerBase)
	if payload := runCall("probe-fail"); payload["outcome"] != provider.ModelInvokeRuntimeUnavailable {
		t.Fatalf("probe-fail payload = %v", payload)
	}
	if invoker.callCount() != modelInvokeBreakerThreshold+1 {
		t.Fatalf("probe did not run: count = %d", invoker.callCount())
	}

	// Still blocked 45s later because backoff doubled to 60s.
	clock = clock.Add(45 * time.Second)
	if payload := runCall("blocked-doubled"); payload["outcome"] != provider.ModelInvokeRuntimeUnavailable {
		t.Fatalf("blocked-doubled payload = %v", payload)
	}
	if invoker.callCount() != modelInvokeBreakerThreshold+1 {
		t.Fatalf("call ran before doubled backoff expired: count = %d", invoker.callCount())
	}

	// A Runtime inventory update (for example loading a local model) resets the breaker immediately.
	invoker.setResult(provider.ModelInvokeResult{Outcome: provider.ModelInvokeCompleted})
	diagnostics := mustJSON([]provider.RuntimeDiagnostic{{Type: "pi", Status: "ready", Models: []provider.RuntimeModel{}}})
	if err := d.UpdateRuntimeInventory(context.Background(), []string{"pi"}, diagnostics, nil); err != nil {
		t.Fatal(err)
	}
	if payload := runCall("recovered-after-inventory"); payload["outcome"] != provider.ModelInvokeCompleted {
		t.Fatalf("recovered payload = %v", payload)
	}
	if invoker.callCount() != modelInvokeBreakerThreshold+2 {
		t.Fatalf("recovered call count = %d", invoker.callCount())
	}
}

func TestModelInvokeNonAvailabilityOutcomesDoNotTripBreaker(t *testing.T) {
	cases := []struct {
		name   string
		result provider.ModelInvokeResult
	}{
		{name: "canceled", result: provider.ModelInvokeResult{Outcome: provider.ModelInvokeCanceled, Reason: "transient"}},
		{name: "output_limited", result: provider.ModelInvokeResult{Outcome: provider.ModelInvokeOutputLimited, Reason: "transient"}},
		{name: "generic_failed", result: provider.ModelInvokeResult{Outcome: provider.ModelInvokeFailed, Reason: "Pi background call did not complete"}},
		{name: "context_too_long", result: provider.ModelInvokeResult{Outcome: provider.ModelInvokeFailed, Reason: provider.ModelInvokeContextTooLongReason}},
		{name: "pi_workspace_refusal", result: provider.ModelInvokeResult{Outcome: provider.ModelInvokeRuntimeUnavailable, Reason: "Pi background calls do not run file tools", NonAvailability: true}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			invoker := &scriptedModelInvoker{result: tc.result}
			d, stream := modelInvokeFixture(t, invoker)
			for i := range modelInvokeBreakerThreshold + 2 {
				cmd := modelInvokeCommand(fmt.Sprintf("call-%d", i), nil)
				cmd.RuntimeType = "pi"
				if err := d.handleModelInvoke(context.Background(), stream, cmd); err != nil {
					t.Fatal(err)
				}
				payload := waitForModelInvoked(t, stream, fmt.Sprintf("call-%d", i))
				if payload["outcome"] != tc.result.Outcome {
					t.Fatalf("call-%d outcome = %v; want %s", i, payload["outcome"], tc.result.Outcome)
				}
			}
			if invoker.callCount() != modelInvokeBreakerThreshold+2 {
				t.Fatalf("calls = %d; want %d", invoker.callCount(), modelInvokeBreakerThreshold+2)
			}
		})
	}
}

func TestModelInvokeBreakerConcurrentHalfOpenProbeAndResetOnRun(t *testing.T) {
	invoker := &scriptedModelInvoker{
		result: provider.ModelInvokeResult{Outcome: provider.ModelInvokeFailed, Reason: "connection refused", AvailabilityFailure: true},
	}
	d, stream := modelInvokeFixture(t, invoker)
	clock := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	d.now = func() time.Time { return clock }

	runCall := func(id string) map[string]any {
		t.Helper()
		cmd := modelInvokeCommand(id, nil)
		cmd.RuntimeType = "pi"
		if err := d.handleModelInvoke(context.Background(), stream, cmd); err != nil {
			t.Fatal(err)
		}
		return waitForModelInvoked(t, stream, id)
	}

	// Trip the breaker with 3 transport availability failures.
	for i := range modelInvokeBreakerThreshold {
		if payload := runCall(fmt.Sprintf("trip-%d", i+1)); payload["outcome"] != provider.ModelInvokeFailed {
			t.Fatalf("trip-%d = %v", i+1, payload)
		}
	}

	// Expire backoff and fire two concurrent calls: only one half-open probe may run.
	clock = clock.Add(modelInvokeBreakerBase)
	invoker.mu.Lock()
	invoker.started = make(chan string, 4)
	invoker.release = make(chan struct{})
	invoker.mu.Unlock()

	cmd1 := modelInvokeCommand("probe-1", nil)
	cmd1.RuntimeType = "pi"
	if err := d.handleModelInvoke(context.Background(), stream, cmd1); err != nil {
		t.Fatal(err)
	}
	<-invoker.started

	cmd2 := modelInvokeCommand("probe-2", nil)
	cmd2.RuntimeType = "pi"
	if err := d.handleModelInvoke(context.Background(), stream, cmd2); err != nil {
		t.Fatal(err)
	}
	if payload := waitForModelInvoked(t, stream, "probe-2"); payload["outcome"] != provider.ModelInvokeRuntimeUnavailable {
		t.Fatalf("concurrent second probe was not held back: %v", payload)
	}
	if invoker.callCount() != modelInvokeBreakerThreshold+1 {
		t.Fatalf("concurrent second probe invoked runtime: count = %d", invoker.callCount())
	}

	close(invoker.release)
	if payload := waitForModelInvoked(t, stream, "probe-1"); payload["outcome"] != provider.ModelInvokeFailed {
		t.Fatalf("probe-1 = %v", payload)
	}

	// A normal Run completing on that runtime resets the breaker immediately.
	invoker.mu.Lock()
	invoker.started = nil
	invoker.release = nil
	invoker.result = provider.ModelInvokeResult{Outcome: provider.ModelInvokeCompleted}
	invoker.mu.Unlock()
	d.resetModelInvokeBreaker("pi")
	if payload := runCall("after-run-reset"); payload["outcome"] != provider.ModelInvokeCompleted {
		t.Fatalf("after-run-reset = %v", payload)
	}
}

func TestModelInvokeBreakerIgnoresStaleRevisionAndPostDrainOutcomes(t *testing.T) {
	t.Run("stale diagnostics revision failure does not poison new revision", func(t *testing.T) {
		invoker := &scriptedModelInvoker{
			result:  provider.ModelInvokeResult{Outcome: provider.ModelInvokeRuntimeUnavailable, Reason: "down"},
			started: make(chan string, 4),
			release: make(chan struct{}),
		}
		d, stream := modelInvokeFixture(t, invoker)

		// Launch 3 in-flight calls at diagnostics revision 1.
		for i := range modelInvokeBreakerThreshold {
			cmd := modelInvokeCommand(fmt.Sprintf("stale-%d", i+1), nil)
			cmd.RuntimeType = "pi"
			if err := d.handleModelInvoke(context.Background(), stream, cmd); err != nil {
				t.Fatal(err)
			}
			<-invoker.started
		}
		// Inventory updates to revision 2 while revision 1 calls are still running.
		diagnostics := mustJSON([]provider.RuntimeDiagnostic{{Type: "pi", Status: "ready", Models: []provider.RuntimeModel{}}})
		if err := d.UpdateRuntimeInventory(context.Background(), []string{"pi"}, diagnostics, nil); err != nil {
			t.Fatal(err)
		}
		// Release the stale revision 1 failures.
		close(invoker.release)
		for i := range modelInvokeBreakerThreshold {
			waitForModelInvoked(t, stream, fmt.Sprintf("stale-%d", i+1))
		}
		d.WaitForOperations()

		// Revision 2 must remain clean and admit calls immediately.
		d.modelInvokeMu.Lock()
		_, hasEntry := d.modelInvokeBreakers["pi"]
		d.modelInvokeMu.Unlock()
		if hasEntry {
			t.Fatal("stale revision failures populated breaker for new diagnostics revision")
		}
	})

	t.Run("post-drain completion does not reinsert breaker state", func(t *testing.T) {
		invoker := &scriptedModelInvoker{
			result:  provider.ModelInvokeResult{Outcome: provider.ModelInvokeRuntimeUnavailable, Reason: "down"},
			started: make(chan string, 1),
			release: make(chan struct{}),
		}
		d, stream := modelInvokeFixture(t, invoker)
		cmd := modelInvokeCommand("inflight-drain", nil)
		cmd.RuntimeType = "pi"
		if err := d.handleModelInvoke(context.Background(), stream, cmd); err != nil {
			t.Fatal(err)
		}
		<-invoker.started
		d.Drain()
		close(invoker.release)
		d.WaitForOperations()

		d.modelInvokeMu.Lock()
		n := len(d.modelInvokeBreakers)
		d.modelInvokeMu.Unlock()
		if n != 0 {
			t.Fatalf("modelInvokeBreakers has %d entries after Drain()", n)
		}
	})
}

func TestModelInvokeGatewayFailureTripsBreaker(t *testing.T) {
	invoker := newFakeModelInvoker()
	d, stream := modelInvokeFixture(t, invoker)
	source := &gatewayModelSource{
		err: &localmodels.ModelSourceError{Code: "BYOK_UNREACHABLE", Message: "The endpoint could not be reached."},
	}
	d.modelSource = source
	clock := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	d.now = func() time.Time { return clock }

	runCall := func(id string) map[string]any {
		t.Helper()
		cmd := modelInvokeCommand(id, nil)
		cmd.RuntimeType = "codex"
		if err := d.handleModelInvoke(context.Background(), stream, cmd); err != nil {
			t.Fatal(err)
		}
		return waitForModelInvoked(t, stream, id)
	}

	for i := range modelInvokeBreakerThreshold {
		payload := runCall(fmt.Sprintf("gw-fail-%d", i+1))
		if payload["outcome"] != provider.ModelInvokeRuntimeUnavailable {
			t.Fatalf("gw-fail-%d payload = %v", i+1, payload)
		}
	}
	if len(source.runtime) != modelInvokeBreakerThreshold {
		t.Fatalf("EnsureGateway calls = %d; want %d", len(source.runtime), modelInvokeBreakerThreshold)
	}

	// Subsequent call is rejected by the breaker before hitting EnsureGateway again.
	payload := runCall("gw-blocked")
	if payload["outcome"] != provider.ModelInvokeRuntimeUnavailable {
		t.Fatalf("gw-blocked payload = %v", payload)
	}
	if len(source.runtime) != modelInvokeBreakerThreshold {
		t.Fatalf("blocked call invoked EnsureGateway: calls = %d", len(source.runtime))
	}
	if invoker.calls() != 0 {
		t.Fatalf("invoker calls = %d; want 0", invoker.calls())
	}
}
