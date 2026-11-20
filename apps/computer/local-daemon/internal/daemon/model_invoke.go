package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/localmodels"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

const (
	modelInvokeBreakerThreshold = 3
	modelInvokeBreakerBase      = 30 * time.Second
	modelInvokeBreakerMax       = 30 * time.Minute
)

type modelInvokeBreakerEntry struct {
	consecutiveFailures int
	openUntil           time.Time
	diagnosticsRevision uint64
	probeInFlight       bool
}

// ModelInvoker runs one execute model_invoke on a local Runtime.
type ModelInvoker interface {
	Invoke(ctx context.Context, request provider.ModelInvokeRequest) provider.ModelInvokeResult
	// Close stops the processes it keeps between calls.
	Close()
}

// modelInvoke is the Daemon's record of one in-flight model invocation. It has no
// Context, takes no Operation slot and is never written to the ledger: a lost
// connection or a drain kills its process and nobody replays it.
type modelInvoke struct {
	id     string
	cancel context.CancelFunc
}

type modelInvokeRequest struct {
	InvokeID        string                     `json:"invoke_id"`
	Mode            string                     `json:"mode"`
	ReasoningEffort string                     `json:"reasoning_effort"`
	Instructions    string                     `json:"instructions"`
	Input           string                     `json:"input"`
	OutputSchema    json.RawMessage            `json:"output_schema"`
	WorkspaceFiles  []provider.ModelInvokeFile `json:"workspace_files"`
	TimeoutMS       int64                      `json:"timeout_ms"`
	MaxOutputChars  int                        `json:"max_output_chars"`
	SessionKey      string                     `json:"session_key"`
}

// handleModelInvoke admits one model call and runs it off the receive loop.
// The Agent Service's model scheduler decides how many run at once; a call the
// Daemon refuses is answered at once and nothing is queued.
func (d *Daemon) handleModelInvoke(ctx context.Context, stream transport.Stream, command protocol.Command) error {
	var request modelInvokeRequest
	if err := json.Unmarshal(command.Payload, &request); err != nil {
		return fmt.Errorf("decode model invocation: %w", err)
	}
	if request.InvokeID == "" {
		return errors.New("model invocation is incomplete")
	}
	receivedAt := time.Now()
	slog.Info("runner.model.invoke", "phase", "received", "invoke_id", request.InvokeID,
		"agent_id", command.AgentID, "runtime_type", command.RuntimeType, "mode", request.Mode)
	d.admissionMu.Lock()
	result := d.modelInvokeBlocked(command, request)
	var entry *modelInvoke
	var invokeCtx context.Context
	var admittedRevision uint64
	if result.Outcome == "" {
		admittedRevision = d.currentDiagnosticsRevision()
		d.modelInvokeMu.Lock()
		switch {
		case d.modelInvokes[request.InvokeID] != nil:
			result = provider.ModelInvokeResult{Outcome: provider.ModelInvokeFailed, Reason: "Model invocation is already running"}
		default:
			if blocked, ok := d.admitModelInvokeBreakerLocked(command.RuntimeType, admittedRevision); !ok {
				result = blocked
			} else {
				var cancel context.CancelFunc
				invokeCtx, cancel = context.WithCancel(ctx)
				entry = &modelInvoke{id: request.InvokeID, cancel: cancel}
				d.modelInvokes[request.InvokeID] = entry
			}
		}
		d.modelInvokeMu.Unlock()
	}
	d.admissionMu.Unlock()
	if entry == nil {
		return d.sendModelInvoked(ctx, stream, command, request.InvokeID, result, time.Since(receivedAt))
	}
	d.preparationWG.Add(1)
	go func() {
		defer d.preparationWG.Done()
		d.runModelInvoke(invokeCtx, stream, command, request, entry, admittedRevision, receivedAt)
	}()
	return nil
}

// modelInvokeBlocked returns the outcome for a call the Daemon must refuse, or
// an empty result. The caller holds admissionMu.
func (d *Daemon) modelInvokeBlocked(command protocol.Command, request modelInvokeRequest) provider.ModelInvokeResult {
	if d.draining {
		return provider.ModelInvokeResult{Outcome: provider.ModelInvokeUnavailable, Reason: "Local Computer Daemon is draining"}
	}
	d.activeMu.Lock()
	stopped := d.locallyStopped[command.AgentID]
	d.activeMu.Unlock()
	if stopped {
		return provider.ModelInvokeResult{Outcome: provider.ModelInvokeUnavailable, Reason: "Agent Runner is locally stopped"}
	}
	if d.runtimeCleanupUnconfirmed(command.RuntimeType) {
		return provider.ModelInvokeResult{Outcome: provider.ModelInvokeRuntimeUnavailable, Reason: cleanupUnconfirmedMessage}
	}
	if d.modelInvoker == nil {
		return provider.ModelInvokeResult{Outcome: provider.ModelInvokeRuntimeUnavailable, Reason: "Model invocation is unavailable"}
	}
	if reason := invalidModelInvokeRequest(request); reason != "" {
		return provider.ModelInvokeResult{Outcome: provider.ModelInvokeFailed, Reason: reason}
	}
	return provider.ModelInvokeResult{}
}

// invalidModelInvokeRequest restates the schema's cross-field rules so a call
// the Agent should never send fails instead of running.
func invalidModelInvokeRequest(request modelInvokeRequest) string {
	switch request.ReasoningEffort {
	case "low", "medium", "high":
	default:
		return "Model invocation reasoning effort is invalid"
	}
	switch request.Mode {
	case provider.ModelInvokeStructured:
		var schema map[string]any
		if json.Unmarshal(request.OutputSchema, &schema) != nil || schema == nil {
			return "Structured model invocation requires an output schema"
		}
	case provider.ModelInvokeText:
	case provider.ModelInvokeWorkspace:
	default:
		return "Model invocation mode is invalid"
	}
	if request.Mode != provider.ModelInvokeWorkspace && len(request.WorkspaceFiles) != 0 {
		return "Only workspace model invocations carry files"
	}
	if request.Input == "" {
		return "Model invocation input is empty"
	}
	return ""
}

func (d *Daemon) runModelInvoke(ctx context.Context, stream transport.Stream, command protocol.Command, request modelInvokeRequest, entry *modelInvoke, admittedRevision uint64, receivedAt time.Time) {
	slog.Info("runner.model.invoke", "phase", "started", "invoke_id", entry.id)
	var result provider.ModelInvokeResult
	if failureCode, err := d.ensureModelGateway(ctx, command.RuntimeType); err != nil {
		result = modelGatewayInvokeFailure(ctx, failureCode, err)
	} else {
		effort := d.normalizeModelInvokeEffort(command.RuntimeType, request.ReasoningEffort)
		result = d.modelInvoker.Invoke(ctx, provider.ModelInvokeRequest{
			RuntimeType: command.RuntimeType, Mode: request.Mode, ReasoningEffort: effort,
			Instructions: request.Instructions, Input: request.Input, OutputSchema: request.OutputSchema,
			WorkspaceFiles: request.WorkspaceFiles, Timeout: time.Duration(request.TimeoutMS) * time.Millisecond,
			SessionKey: request.SessionKey, MaxOutputChars: request.MaxOutputChars,
		})
	}
	d.recordModelInvokeOutcome(command.RuntimeType, admittedRevision, result)
	entry.cancel()
	d.modelInvokeMu.Lock()
	if d.modelInvokes[entry.id] == entry {
		delete(d.modelInvokes, entry.id)
	}
	d.modelInvokeMu.Unlock()
	if err := d.sendModelInvoked(context.WithoutCancel(ctx), stream, command, entry.id, result, time.Since(receivedAt)); err != nil {
		slog.Debug("runner.model.invoke receipt unavailable", "invoke_id", entry.id)
	}
}

// modelGatewayInvokeFailure answers a model call whose Runtime's gateway
// could not be mounted: the Computer is online, its Runtime cannot run the
// call, and the reason names the tool's code.
func modelGatewayInvokeFailure(ctx context.Context, failureCode string, err error) provider.ModelInvokeResult {
	if ctx.Err() != nil {
		return provider.ModelInvokeResult{Outcome: provider.ModelInvokeCanceled, Reason: "Model invocation was canceled"}
	}
	reason := "The model gateway could not be started"
	var sourceErr *localmodels.ModelSourceError
	if errors.As(err, &sourceErr) {
		reason += " (" + sourceErr.Code + ")"
	}
	if failureCode == "authentication_required" {
		return provider.ModelInvokeResult{Outcome: provider.ModelInvokeAuthRequired, Reason: reason}
	}
	return provider.ModelInvokeResult{Outcome: provider.ModelInvokeRuntimeUnavailable, Reason: reason}
}

func (d *Daemon) modelInvokeNow() time.Time {
	if d.now != nil {
		return d.now()
	}
	return time.Now()
}

func (d *Daemon) currentDiagnosticsRevision() uint64 {
	d.inventoryMu.RLock()
	defer d.inventoryMu.RUnlock()
	return d.diagnosticsRevision
}

// normalizeModelInvokeEffort clamps requested reasoning effort against the
// target Runtime's active default model from the Daemon's latest diagnostics,
// returning only effort values accepted by that Runtime's CLI.
func (d *Daemon) normalizeModelInvokeEffort(runtimeType, requested string) string {
	d.inventoryMu.RLock()
	raw := append(json.RawMessage(nil), d.runtimeDiagnostics...)
	d.inventoryMu.RUnlock()
	if len(raw) == 0 {
		return requested
	}
	var diagnostics []provider.RuntimeDiagnostic
	if json.Unmarshal(raw, &diagnostics) != nil {
		return requested
	}
	for _, diag := range diagnostics {
		if diag.Type != runtimeType {
			continue
		}
		model, ok := defaultRuntimeModel(diag.Models)
		if !ok {
			return requested
		}
		if len(model.AllowedReasoningEffort) == 0 {
			// Pi omits --thinking when effort is empty; Codex and Claude keep
			// the validated effort when the catalog reports no effort list.
			if runtimeType == "pi" {
				return ""
			}
			return requested
		}
		allowed := filterModelInvokeEfforts(runtimeType, model.AllowedReasoningEffort)
		if len(allowed) == 0 {
			return requested
		}
		normalized := native.NormalizeReasoningEffort(requested, allowed, model.DefaultReasoningEffort)
		if normalized != requested {
			slog.Info("runner.model.invoke.effort_normalized", "runtime_type", runtimeType,
				"model", model.ID, "requested", requested, "normalized", normalized)
		}
		return normalized
	}
	return requested
}

func filterModelInvokeEfforts(runtimeType string, efforts []string) []string {
	supported := make([]string, 0, len(efforts))
	for _, raw := range efforts {
		value := strings.ToLower(strings.TrimSpace(raw))
		if validModelInvokeEffort(runtimeType, value) {
			supported = append(supported, value)
		}
	}
	return supported
}

func validModelInvokeEffort(runtimeType, effort string) bool {
	switch runtimeType {
	case "pi":
		switch effort {
		case "none", "off", "minimal", "low", "medium", "high", "xhigh", "max":
			return true
		}
	case "claude":
		switch effort {
		case "none", "low", "medium", "high", "xhigh", "max":
			return true
		}
	case "codex":
		switch effort {
		case "none", "minimal", "low", "medium", "high", "xhigh":
			return true
		}
	}
	return false
}

func defaultRuntimeModel(models []provider.RuntimeModel) (provider.RuntimeModel, bool) {
	for _, model := range models {
		if model.IsDefault {
			return model, true
		}
	}
	if len(models) == 1 {
		return models[0], true
	}
	return provider.RuntimeModel{}, false
}

// admitModelInvokeBreakerLocked enforces per-Runtime exponential backoff after
// consecutive runtime-level availability failures. Any Runtime inventory
// revision change resets the breaker immediately so a newly loaded model is
// tried without waiting out the backoff window. The caller holds modelInvokeMu.
func (d *Daemon) admitModelInvokeBreakerLocked(runtimeType string, revision uint64) (provider.ModelInvokeResult, bool) {
	entry := d.modelInvokeBreakers[runtimeType]
	if entry == nil {
		return provider.ModelInvokeResult{}, true
	}
	if entry.diagnosticsRevision != revision {
		delete(d.modelInvokeBreakers, runtimeType)
		return provider.ModelInvokeResult{}, true
	}
	if entry.consecutiveFailures < modelInvokeBreakerThreshold {
		return provider.ModelInvokeResult{}, true
	}
	now := d.modelInvokeNow()
	if now.Before(entry.openUntil) || entry.probeInFlight {
		return provider.ModelInvokeResult{
			Outcome: provider.ModelInvokeRuntimeUnavailable,
			Reason:  "Runtime model invocation is backing off after repeated failures",
		}, false
	}
	// Admit a single half-open probe while holding back concurrent bursts.
	entry.probeInFlight = true
	return provider.ModelInvokeResult{}, true
}

func (d *Daemon) recordModelInvokeOutcome(runtimeType string, admittedRevision uint64, result provider.ModelInvokeResult) {
	currentRevision := d.currentDiagnosticsRevision()
	now := d.modelInvokeNow()
	d.modelInvokeMu.Lock()
	defer d.modelInvokeMu.Unlock()
	if d.modelInvokeDrained {
		return
	}
	if admittedRevision != currentRevision {
		if entry := d.modelInvokeBreakers[runtimeType]; entry != nil && entry.diagnosticsRevision != currentRevision {
			delete(d.modelInvokeBreakers, runtimeType)
		}
		return
	}
	if result.Outcome == provider.ModelInvokeCompleted {
		delete(d.modelInvokeBreakers, runtimeType)
		return
	}
	if result.IsAvailabilityFailure() {
		if d.modelInvokeBreakers == nil {
			d.modelInvokeBreakers = make(map[string]*modelInvokeBreakerEntry)
		}
		entry := d.modelInvokeBreakers[runtimeType]
		if entry == nil || entry.diagnosticsRevision != admittedRevision {
			entry = &modelInvokeBreakerEntry{diagnosticsRevision: admittedRevision}
			d.modelInvokeBreakers[runtimeType] = entry
		}
		entry.probeInFlight = false
		entry.consecutiveFailures++
		if entry.consecutiveFailures >= modelInvokeBreakerThreshold {
			shift := min(entry.consecutiveFailures-modelInvokeBreakerThreshold, 10)
			delay := min(modelInvokeBreakerBase<<shift, modelInvokeBreakerMax)
			entry.openUntil = now.Add(delay)
			slog.Warn("runner.model.invoke.backoff_opened", "runtime_type", runtimeType,
				"consecutive_failures", entry.consecutiveFailures, "backoff_ms", delay.Milliseconds())
		}
		return
	}
	if entry := d.modelInvokeBreakers[runtimeType]; entry != nil && entry.diagnosticsRevision == admittedRevision {
		entry.probeInFlight = false
	}
}

// resetModelInvokeBreaker clears backoff for runtimeType once a normal Run
// proves the Runtime is healthy again.
func (d *Daemon) resetModelInvokeBreaker(runtimeType string) {
	if runtimeType == "" {
		return
	}
	d.modelInvokeMu.Lock()
	delete(d.modelInvokeBreakers, runtimeType)
	d.modelInvokeMu.Unlock()
}

// cancelModelInvoke cancels one in-flight model call; its canceled receipt
// follows unless it finished first. A call that is not running is already
// answered, so the cancel does nothing.
func (d *Daemon) cancelModelInvoke(command protocol.Command) error {
	var cancel wire.ModelInvokeCancel
	if err := json.Unmarshal(command.Payload, &cancel); err != nil {
		return fmt.Errorf("decode model invocation cancel: %w", err)
	}
	if cancel.InvokeID == "" {
		return errors.New("model invocation cancel is incomplete")
	}
	d.modelInvokeMu.Lock()
	defer d.modelInvokeMu.Unlock()
	entry := d.modelInvokes[cancel.InvokeID]
	if entry == nil {
		slog.Info("runner.model.invoke", "phase", "cancel_ignored", "invoke_id", cancel.InvokeID, "cancellation_source", cancel.Reason)
		return nil
	}
	entry.cancel()
	slog.Info("runner.model.invoke", "phase", "cancel_requested", "invoke_id", entry.id, "cancellation_source", cancel.Reason)
	return nil
}

// cancelModelInvokes cancels every in-flight model call; each still sends its
// canceled receipt if the connection is open.
func (d *Daemon) cancelModelInvokes(source string) {
	d.modelInvokeMu.Lock()
	defer d.modelInvokeMu.Unlock()
	if source == "drain" {
		d.modelInvokeDrained = true
		clear(d.modelInvokeBreakers)
	}
	for _, entry := range d.modelInvokes {
		entry.cancel()
		slog.Info("runner.model.invoke", "phase", "cancel_requested", "invoke_id", entry.id, "cancellation_source", source)
	}
}

func (d *Daemon) sendModelInvoked(ctx context.Context, stream transport.Stream, command protocol.Command, invokeID string, result provider.ModelInvokeResult, duration time.Duration) error {
	payload := map[string]any{
		"type": wire.TypeExecuted, "kind": wire.KindModelInvoke, "command_id": command.CommandID, "runner_id": command.RunnerID,
		"invoke_id": invokeID, "outcome": result.Outcome, "duration_ms": duration.Milliseconds(),
	}
	// The Gateway closes the connection on a frame its schema rejects, so
	// optional fields are sent only when they fit it.
	// A session call that stopped early carries what it streamed so far.
	if result.Outcome != provider.ModelInvokeCompleted && result.Text != "" {
		payload["text"] = result.Text
	}
	if result.Outcome == provider.ModelInvokeCompleted {
		payload["text"] = result.Text
		if result.WorkspaceFiles != nil {
			payload["workspace_files"] = result.WorkspaceFiles
		}
		if result.Usage != nil {
			payload["usage"] = result.Usage
		}
	}
	if result.Model != "" && len(result.Model) <= 200 {
		payload["model"] = result.Model
	}
	if result.RuntimeVersion != "" && len(result.RuntimeVersion) <= 128 {
		payload["runtime_version"] = result.RuntimeVersion
	}
	if reason := receiptReason(redact.Text(result.Reason)); reason != "" && result.Outcome != provider.ModelInvokeCompleted {
		payload["reason"] = reason
	}
	encoded := mustJSON(payload)
	if len(encoded) > transport.MaxFrameBytes {
		// JSON escaping and base64 can push a reply that is within the text
		// and tree bounds past the frame limit, and an oversized frame would
		// close the connection for every other Operation on it.
		slog.Warn("runner.model.invoke", "phase", "reply_oversized", "invoke_id", invokeID, "frame_bytes", len(encoded))
		for _, field := range []string{"text", "workspace_files", "usage"} {
			delete(payload, field)
		}
		result.Outcome = provider.ModelInvokeFailed
		payload["outcome"] = result.Outcome
		payload["reason"] = "Model invocation reply exceeds the Runner Gateway frame limit"
		encoded = mustJSON(payload)
	}
	slog.Info("runner.model.invoke", "phase", result.Outcome, "invoke_id", invokeID, "duration_ms", duration.Milliseconds())
	return stream.Send(ctx, protocol.Event{
		Type: protocol.EventModelInvoked, ProtocolVersion: command.ProtocolVersion, CommandID: command.CommandID,
		SentAt: time.Now().UTC(), Payload: encoded,
	})
}
