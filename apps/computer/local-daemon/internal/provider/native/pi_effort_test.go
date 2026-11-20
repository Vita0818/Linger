package native

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestNormalizeReasoningEffort(t *testing.T) {
	tests := []struct {
		name          string
		requested     string
		allowed       []string
		defaultEffort string
		want          string
	}{
		{
			name:          "spark medium clamps to declared high default",
			requested:     "medium",
			allowed:       []string{"low", "high"},
			defaultEffort: "high",
			want:          "high",
		},
		{
			name:          "spark medium clamps to declared low default on tie",
			requested:     "medium",
			allowed:       []string{"low", "high"},
			defaultEffort: "low",
			want:          "low",
		},
		{
			name:          "spark medium without default clamps upward to high",
			requested:     "medium",
			allowed:       []string{"low", "high"},
			defaultEffort: "",
			want:          "high",
		},
		{
			name:          "spark preserves allowed low",
			requested:     "low",
			allowed:       []string{"low", "high"},
			defaultEffort: "high",
			want:          "low",
		},
		{
			name:          "spark preserves allowed high",
			requested:     "high",
			allowed:       []string{"low", "high"},
			defaultEffort: "low",
			want:          "high",
		},
		{
			name:          "spark clamps minimal to nearest low",
			requested:     "minimal",
			allowed:       []string{"low", "high"},
			defaultEffort: "high",
			want:          "low",
		},
		{
			name:          "spark clamps xhigh to nearest high",
			requested:     "xhigh",
			allowed:       []string{"low", "high"},
			defaultEffort: "low",
			want:          "high",
		},
		{
			name:          "none alias matches off in allowed",
			requested:     "none",
			allowed:       []string{"off", "low", "high"},
			defaultEffort: "high",
			want:          "off",
		},
		{
			name:          "off alias matches none in allowed",
			requested:     "off",
			allowed:       []string{"none", "low", "high"},
			defaultEffort: "high",
			want:          "none",
		},
		{
			name:          "single allowed option wins",
			requested:     "low",
			allowed:       []string{"high"},
			defaultEffort: "",
			want:          "high",
		},
		{
			name:          "empty allowed leaves requested unchanged",
			requested:     "medium",
			allowed:       nil,
			defaultEffort: "",
			want:          "medium",
		},
		{
			name:          "empty requested stays empty",
			requested:     "",
			allowed:       []string{"low", "high"},
			defaultEffort: "high",
			want:          "",
		},
		{
			name:          "unknown requested falls back to default",
			requested:     "custom",
			allowed:       []string{"low", "high"},
			defaultEffort: "high",
			want:          "high",
		},
		{
			name:          "case insensitive and trimmed matching",
			requested:     " Medium ",
			allowed:       []string{"none", "low", "high"},
			defaultEffort: " LOW ",
			want:          "low",
		},
		{
			name:          "case insensitive direct match",
			requested:     "HIGH",
			allowed:       []string{"none", "low", "high"},
			defaultEffort: "low",
			want:          "high",
		},
		{
			name:          "case insensitive off alias",
			requested:     " OFF ",
			allowed:       []string{"none", "low", "high"},
			defaultEffort: "high",
			want:          "none",
		},
		{
			name:          "none-only model clamps medium to none",
			requested:     "medium",
			allowed:       []string{"none"},
			defaultEffort: "",
			want:          "none",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := NormalizeReasoningEffort(tc.requested, tc.allowed, tc.defaultEffort)
			if got != tc.want {
				t.Fatalf("NormalizeReasoningEffort(%q, %v, %q) = %q; want %q",
					tc.requested, tc.allowed, tc.defaultEffort, got, tc.want)
			}
		})
	}
}

func TestPiCatalogSparkX26EffortConstraints(t *testing.T) {
	state := piCatalogState{
		Model: piCatalogModel{
			Provider: "localmodels",
			ID:       "Spark-X2.6-4B-Q8_0",
		},
		ThinkingLevel: "medium",
	}
	list, err := piCatalogList(state, []json.RawMessage{
		json.RawMessage(`{
			"provider": "localmodels",
			"id": "Spark-X2.6-4B-Q8_0",
			"reasoning": true,
			"thinkingLevelMap": {"off": null, "minimal": null, "low": "low", "medium": null, "high": "high"}
		}`),
		json.RawMessage(`{
			"provider": "localmodels",
			"id": "Spark-Explicit-Default-Low",
			"reasoning": true,
			"allowedReasoningEffort": ["low", "high"],
			"defaultReasoningEffort": "low"
		}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Models) != 2 {
		t.Fatalf("models = %+v", list.Models)
	}
	spark := list.Models[0]
	if spark.Effort == nil {
		t.Fatal("expected effort support on Spark-X2.6-4B-Q8_0")
	}
	var values []string
	for _, option := range spark.Effort.Options {
		values = append(values, option.Value)
	}
	if !slices.Equal(values, []string{"low", "high"}) {
		t.Fatalf("spark allowed efforts = %v; want [low high]", values)
	}
	if spark.Effort.Default != "high" {
		t.Fatalf("spark default effort = %q; want high (normalized from unsupported medium)", spark.Effort.Default)
	}

	explicit := list.Models[1]
	if explicit.Effort == nil || explicit.Effort.Default != "low" {
		t.Fatalf("explicit effort = %+v", explicit.Effort)
	}
	var explicitValues []string
	for _, option := range explicit.Effort.Options {
		explicitValues = append(explicitValues, option.Value)
	}
	if !slices.Equal(explicitValues, []string{"low", "high"}) {
		t.Fatalf("explicit allowed efforts = %v; want [low high]", explicitValues)
	}
}

func TestPiRuntimeClampsEffortFromModelsJSON(t *testing.T) {
	agentDir := t.TempDir()
	writeFile := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(agentDir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writeFile("settings.json", `{
		"defaultProvider": "localmodels",
		"defaultModel": "Spark-X2.6-4B-Q8_0",
		"defaultThinkingLevel": "high"
	}`)
	writeFile("models.json", `{
		"providers": {
			"localmodels": {
				"baseUrl": "http://127.0.0.1:18100/v1",
				"models": [
					{
						"id": "Spark-X2.6-4B-Q8_0",
						"reasoning": true,
						"thinkingLevelMap": {"off": null, "minimal": null, "low": "low", "medium": null, "high": "high"}
					},
					{
						"id": "Spark-Default-Low",
						"reasoning": true,
						"allowedReasoningEffort": ["low", "high"],
						"defaultReasoningEffort": "low"
					},
					{
						"id": "Plain-Non-Reasoner",
						"reasoning": false
					}
				],
				"modelOverrides": {
					"Spark-Override": {
						"reasoning": true,
						"thinkingLevelMap": {"off": null, "minimal": null, "medium": null, "low": "low", "high": "high"}
					}
				}
			}
		}
	}`)

	argvFile := filepath.Join(t.TempDir(), "argv")
	h := piNewHarness(t, "finish", map[string]string{
		piFakeArgvEnv:         argvFile,
		"PI_CODING_AGENT_DIR": agentDir,
	})

	runAndReadThinking := func(model, effort string) (string, bool) {
		t.Helper()
		_, outcome := piCollect(t, h.start(t.Context(), "hello", RunSpec{Model: model, Effort: effort}))
		if outcome.Status != statusCompleted {
			t.Fatalf("model=%q effort=%q outcome = %+v", model, effort, outcome)
		}
		raw, err := os.ReadFile(argvFile)
		if err != nil {
			t.Fatal(err)
		}
		args := strings.Split(string(raw), "\n")
		for i := 0; i+1 < len(args); i++ {
			if args[i] == "--thinking" {
				return args[i+1], true
			}
		}
		return "", false
	}

	if got, ok := runAndReadThinking("localmodels/Spark-X2.6-4B-Q8_0", "medium"); !ok || got != "high" {
		t.Fatalf("spark explicit model medium -> (%q, %v); want (high, true)", got, ok)
	}
	if got, ok := runAndReadThinking(piDefaultModel, "medium"); !ok || got != "high" {
		t.Fatalf("spark default model medium -> (%q, %v); want (high, true)", got, ok)
	}
	if got, ok := runAndReadThinking("localmodels/Spark-X2.6-4B-Q8_0", "low"); !ok || got != "low" {
		t.Fatalf("spark low -> (%q, %v); want (low, true)", got, ok)
	}
	if got, ok := runAndReadThinking("localmodels/Spark-Default-Low", "medium"); !ok || got != "low" {
		t.Fatalf("spark default-low medium -> (%q, %v); want (low, true)", got, ok)
	}
	if got, ok := runAndReadThinking("localmodels/Spark-Override", "medium"); !ok || got != "high" {
		t.Fatalf("spark override medium -> (%q, %v); want (high, true)", got, ok)
	}
	if got, ok := runAndReadThinking("localmodels/Plain-Non-Reasoner", "medium"); ok {
		t.Fatalf("non-reasoning model passed --thinking %q; want omitted", got)
	}
}

func TestInvokePiModelClampsUnsupportedMediumViaModelsJSONAndRPCState(t *testing.T) {
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}

	t.Run("clamps before spawn using models.json", func(t *testing.T) {
		agentDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(agentDir, "settings.json"), []byte(`{"defaultProvider":"localmodels","defaultModel":"Spark-X2.6-4B-Q8_0"}`), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(agentDir, "models.json"), []byte(`{
			"providers": {"localmodels": {"models": [{
				"id": "Spark-X2.6-4B-Q8_0",
				"reasoning": true,
				"thinkingLevelMap": {"off": null, "minimal": null, "low": "low", "medium": null, "high": "high"}
			}]}}
		}`), 0o600); err != nil {
			t.Fatal(err)
		}
		argvFile := filepath.Join(t.TempDir(), "argv")
		commandsFile := filepath.Join(t.TempDir(), "commands")
		outcome, model, err := InvokePiModel(t.Context(), Profile{
			Program: program,
			Env: map[string]string{
				piFakeEnv:             "invoke-clamp",
				piFakeArgvEnv:         argvFile,
				piFakeLogEnv:          commandsFile,
				"PI_CODING_AGENT_DIR": agentDir,
			},
		}, t.TempDir(), "", "hello", "medium")
		if err != nil || outcome.Status != statusCompleted || model != "localmodels/Spark-X2.6-4B-Q8_0" {
			t.Fatalf("InvokePiModel = %+v, %q, %v", outcome, model, err)
		}
		if !strings.Contains(outcome.Output, `"effort":"high"`) {
			t.Fatalf("output = %q; want clamped high effort", outcome.Output)
		}
		argv, _ := os.ReadFile(argvFile)
		if !strings.Contains(string(argv), "--thinking\nhigh") || strings.Contains(string(argv), "--thinking\nmedium") {
			t.Fatalf("argv = %q", argv)
		}
		// Already clamped via models.json, so no redundant set_thinking_level RPC is sent.
		commands, _ := os.ReadFile(commandsFile)
		if strings.Contains(string(commands), "set_thinking_level") {
			t.Fatalf("unexpected set_thinking_level RPC when argv already clamped: %q", commands)
		}
	})

	t.Run("clamps via set_thinking_level when models.json is absent", func(t *testing.T) {
		commandsFile := filepath.Join(t.TempDir(), "commands")
		outcome, model, err := InvokePiModel(t.Context(), Profile{
			Program: program,
			Env: map[string]string{
				piFakeEnv:             "invoke-clamp",
				piFakeLogEnv:          commandsFile,
				"PI_CODING_AGENT_DIR": t.TempDir(),
			},
		}, t.TempDir(), "", "hello", "medium")
		if err != nil || outcome.Status != statusCompleted || model != "localmodels/Spark-X2.6-4B-Q8_0" {
			t.Fatalf("InvokePiModel = %+v, %q, %v", outcome, model, err)
		}
		if !strings.Contains(outcome.Output, `"effort":"high"`) {
			t.Fatalf("output = %q; want clamped high effort", outcome.Output)
		}
		commands, _ := os.ReadFile(commandsFile)
		if !strings.Contains(string(commands), "set_thinking_level:high\n") {
			t.Fatalf("commands = %q; want set_thinking_level:high before prompt", commands)
		}
	})
}

func TestPiCatalogBifrostRealisticThinkingLevelMaps(t *testing.T) {
	// Realistic localmodels bifrost_models.py outputs omit "off" from
	// thinkingLevelMap so Pi keeps "off" -> "none" alongside mapped levels.
	state := piCatalogState{
		Model:         piCatalogModel{Provider: "localmodels", ID: "Spark-X2.6-4B-Q8_0"},
		ThinkingLevel: "medium",
	}
	list, err := piCatalogList(state, []json.RawMessage{
		json.RawMessage(`{
			"provider": "localmodels",
			"id": "Spark-X2.6-4B-Q8_0",
			"reasoning": true,
			"thinkingLevelMap": {"minimal": null, "low": "low", "medium": null, "high": "high"}
		}`),
		json.RawMessage(`{
			"provider": "localmodels",
			"id": "None-Only-Model",
			"reasoning": true,
			"thinkingLevelMap": {"minimal": null, "low": null, "medium": null, "high": null}
		}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Models) != 2 {
		t.Fatalf("models = %+v", list.Models)
	}
	effortValues := func(m ModelOption) []string {
		if m.Effort == nil {
			return nil
		}
		values := make([]string, len(m.Effort.Options))
		for i, opt := range m.Effort.Options {
			values[i] = opt.Value
		}
		return values
	}
	if got := effortValues(list.Models[0]); !slices.Equal(got, []string{"none", "low", "high"}) {
		t.Fatalf("bifrost spark efforts = %v; want [none low high]", got)
	}
	if list.Models[0].Effort.Default != "high" {
		t.Fatalf("bifrost spark default = %q; want high", list.Models[0].Effort.Default)
	}
	if got := effortValues(list.Models[1]); !slices.Equal(got, []string{"none"}) {
		t.Fatalf("none-only model efforts = %v; want [none]", got)
	}
}

func TestPiLocalOverridesPreserveUnrelatedBuiltinModelsAndClearAliases(t *testing.T) {
	var config piLocalModelsFile
	raw := `{
		"providers": {
			"anthropic": {
				"modelOverrides": {
					"claude-sonnet-4-5": {"name": "Custom Display Name"},
					"claude-constrained": {"thinkingLevelMap": {"minimal": null, "medium": null, "low": "low", "high": "high"}}
				}
			},
			"localmodels": {
				"models": [
					{
						"id": "Base-With-Camel",
						"reasoning": true,
						"allowedReasoningEffort": ["low", "medium", "high"],
						"defaultReasoningEffort": "medium"
					},
					{
						"id": "Base-With-List-Map-Override",
						"reasoning": true,
						"allowedReasoningEffort": ["low", "medium", "high"]
					}
				],
				"modelOverrides": {
					"Base-With-Camel": {
						"allowed_reasoning_effort": ["low", "high"],
						"default_reasoning_effort": "low"
					},
					"Base-With-List-Map-Override": {
						"thinkingLevelMap": {"minimal": null, "medium": null, "low": "low", "high": "high"}
					}
				}
			}
		}
	}`
	if err := json.Unmarshal([]byte(raw), &config); err != nil {
		t.Fatal(err)
	}

	// Unrelated modelOverrides-only entry must not match and strip --thinking from built-in models.
	if _, _, ok := findPiLocalModel(config, "anthropic", "claude-sonnet-4-5"); ok {
		t.Fatal("unrelated modelOverrides entry matched with providerName")
	}
	if _, _, ok := findPiLocalModel(config, "", "claude-sonnet-4-5"); ok {
		t.Fatal("unrelated modelOverrides entry matched without providerName")
	}

	// Override with explicit thinkingLevelMap matches consistently with or without providerName.
	for _, providerName := range []string{"anthropic", ""} {
		_, model, ok := findPiLocalModel(config, providerName, "claude-constrained")
		if !ok {
			t.Fatalf("constrained modelOverrides entry did not match (provider=%q)", providerName)
		}
		support := piModelEffortSupport(model, "")
		if support == nil {
			t.Fatalf("expected effort support for constrained override (provider=%q)", providerName)
		}
		if got := piClampThinkingToSupport("medium", support); got != "high" {
			t.Fatalf("clamped medium = %q; want high (provider=%q)", got, providerName)
		}
	}

	// Snake_case override replaces camelCase allowed/default fields without alias shadowing.
	_, camelOverridden, ok := findPiLocalModel(config, "localmodels", "Base-With-Camel")
	if !ok {
		t.Fatal("Base-With-Camel not found")
	}
	support := piModelEffortSupport(camelOverridden, "")
	if support == nil || support.Default != "low" {
		t.Fatalf("camel overridden support = %+v; want default low", support)
	}
	if got := piClampThinkingToSupport("medium", support); got != "low" {
		t.Fatalf("clamped medium with snake override = %q; want low", got)
	}

	// thinkingLevelMap override clears inherited allowedReasoningEffort list.
	_, mapOverridden, ok := findPiLocalModel(config, "localmodels", "Base-With-List-Map-Override")
	if !ok {
		t.Fatal("Base-With-List-Map-Override not found")
	}
	mapSupport := piModelEffortSupport(mapOverridden, "")
	if mapSupport == nil {
		t.Fatal("expected support for thinkingLevelMap override")
	}
	if got := piClampThinkingToSupport("medium", mapSupport); got != "high" {
		t.Fatalf("clamped medium with map override = %q; want high", got)
	}
}

func TestPiRuntimeClampsRegularTurnViaGetStateAndDigestCache(t *testing.T) {
	t.Run("clamps empty spec effort via set_thinking_level on fresh startup", func(t *testing.T) {
		commandsFile := filepath.Join(t.TempDir(), "commands")
		h := piNewHarness(t, "clamp-state", map[string]string{piFakeLogEnv: commandsFile})
		_, outcome := piCollect(t, h.start(t.Context(), "hello", RunSpec{Effort: ""}))
		if outcome.Status != statusCompleted || outcome.Output != "effort:high" {
			t.Fatalf("outcome = %+v; want completed with effort:high", outcome)
		}
		commands, _ := os.ReadFile(commandsFile)
		if !strings.Contains(string(commands), "set_thinking_level:high\n") {
			t.Fatalf("commands = %q; want set_thinking_level:high", commands)
		}
	})

	t.Run("clamps unsupported spec effort when models.json is absent", func(t *testing.T) {
		commandsFile := filepath.Join(t.TempDir(), "commands")
		h := piNewHarness(t, "clamp-state", map[string]string{
			piFakeLogEnv:          commandsFile,
			"PI_CODING_AGENT_DIR": t.TempDir(),
		})
		_, outcome := piCollect(t, h.start(t.Context(), "hello", RunSpec{Effort: "medium"}))
		if outcome.Status != statusCompleted || outcome.Output != "effort:high" {
			t.Fatalf("outcome = %+v; want completed with effort:high", outcome)
		}
		commands, _ := os.ReadFile(commandsFile)
		if !strings.Contains(string(commands), "set_thinking_level:high\n") {
			t.Fatalf("commands = %q; want set_thinking_level:high", commands)
		}
	})

	t.Run("skips set_thinking_level on happy path and uses preloaded digest without disk reads", func(t *testing.T) {
		commandsFile := filepath.Join(t.TempDir(), "commands")
		argvFile := filepath.Join(t.TempDir(), "argv")
		program, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		base := t.TempDir()
		sessionRoot := filepath.Join(base, "sessions")
		contextDir := filepath.Join(base, "context")
		if err := os.MkdirAll(contextDir, 0o700); err != nil {
			t.Fatal(err)
		}
		digest := "preloaded-digest-spark-x26"
		rt, err := Open("pi", Profile{
			Program:        program,
			PiConfigDigest: digest,
			PiSettingsJSON: []byte(`{"defaultProvider":"localmodels","defaultModel":"Spark-X2.6-4B-Q8_0"}`),
			PiModelsJSON: []byte(`{"providers":{"localmodels":{"models":[{
				"id":"Spark-X2.6-4B-Q8_0","reasoning":true,
				"thinkingLevelMap":{"minimal":null,"low":"low","medium":null,"high":"high"}
			}]}}}`),
			Env: map[string]string{
				piFakeEnv:             "clamp-state",
				piSessionRootKey:      sessionRoot,
				piFakeLogEnv:          commandsFile,
				piFakeArgvEnv:         argvFile,
				"PI_CODING_AGENT_DIR": filepath.Join(base, "nonexistent-dir"),
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		run, err := rt.Start(t.Context(), "hello", RunSpec{Dir: contextDir, Effort: "medium"})
		if err != nil {
			t.Fatal(err)
		}
		_, outcome := piCollect(t, run)
		if outcome.Status != statusCompleted || outcome.Output != "effort:high" {
			t.Fatalf("outcome = %+v; want completed with effort:high", outcome)
		}
		argv, _ := os.ReadFile(argvFile)
		if !strings.Contains(string(argv), "--thinking\nhigh") {
			t.Fatalf("argv = %q; want --thinking high from preloaded digest", argv)
		}
		commands, _ := os.ReadFile(commandsFile)
		if strings.Contains(string(commands), "set_thinking_level") {
			t.Fatalf("unexpected set_thinking_level RPC on happy path: %q", commands)
		}
	})
}
