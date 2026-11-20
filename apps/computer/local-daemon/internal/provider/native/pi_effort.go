package native

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
)

const (
	piConfigReadLimit = 4 << 20
	piConfigCacheMax  = 16
)

// canonicalEffortOrder defines the reasoning-effort ladder from lowest to
// highest. "off" is normalized to "none" for comparison so Pi and product
// vocabularies align.
var canonicalEffortOrder = []string{
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
}

// NormalizeReasoningEffort clamps a requested reasoning effort to a model's
// declared allowed efforts and optional default effort.
//
// Matching is case-insensitive and treats "off" and "none" as aliases.
// An empty requested effort or an empty allowed list returns requested
// unchanged. When requested is not allowed, the nearest allowed effort on the
// canonical ladder is selected; equal-distance ties prefer defaultEffort when
// tied, and otherwise prefer the higher effort.
func NormalizeReasoningEffort(requested string, allowed []string, defaultEffort string) string {
	requested = strings.TrimSpace(requested)
	if requested == "" || len(allowed) == 0 {
		return requested
	}
	reqCanonical := canonicalEffortName(requested)
	for _, option := range allowed {
		trimmed := strings.TrimSpace(option)
		if trimmed == "" {
			continue
		}
		if trimmed == requested || canonicalEffortName(trimmed) == reqCanonical {
			return trimmed
		}
	}

	defaultCanonical := canonicalEffortName(defaultEffort)
	matchedDefault := ""
	firstValid := ""
	for _, option := range allowed {
		trimmed := strings.TrimSpace(option)
		if trimmed == "" {
			continue
		}
		if firstValid == "" {
			firstValid = trimmed
		}
		if defaultCanonical != "" && matchedDefault == "" && canonicalEffortName(trimmed) == defaultCanonical {
			matchedDefault = trimmed
		}
	}
	if firstValid == "" {
		return requested
	}

	reqIdx := slices.Index(canonicalEffortOrder, reqCanonical)
	if reqIdx < 0 {
		if matchedDefault != "" {
			return matchedDefault
		}
		return firstValid
	}

	bestOption := ""
	bestDist := len(canonicalEffortOrder) + 1
	bestIdx := -1
	bestIsDefault := false
	for _, option := range allowed {
		trimmed := strings.TrimSpace(option)
		idx := slices.Index(canonicalEffortOrder, canonicalEffortName(trimmed))
		if idx < 0 {
			continue
		}
		dist := reqIdx - idx
		if dist < 0 {
			dist = -dist
		}
		isDefault := defaultCanonical != "" && canonicalEffortName(trimmed) == defaultCanonical
		if dist < bestDist ||
			(dist == bestDist && isDefault && !bestIsDefault) ||
			(dist == bestDist && isDefault == bestIsDefault && idx > bestIdx) {
			bestOption = trimmed
			bestDist = dist
			bestIdx = idx
			bestIsDefault = isDefault
		}
	}
	if bestOption != "" {
		return bestOption
	}
	if matchedDefault != "" {
		return matchedDefault
	}
	return firstValid
}

func canonicalEffortName(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "off" {
		return "none"
	}
	return normalized
}

func piEffortToThinkingFlag(value string) string {
	if canonicalEffortName(value) == "none" {
		return "off"
	}
	return strings.ToLower(strings.TrimSpace(value))
}

func (m piCatalogModel) declaredAllowedEfforts() []string {
	for _, list := range [][]string{
		m.AllowedReasoningEffort,
		m.AllowedReasoningEffortSnake,
		m.ReasoningEfforts,
		m.ReasoningEffortsSnake,
	} {
		if len(list) > 0 {
			return list
		}
	}
	return nil
}

func (m piCatalogModel) declaredDefaultEffort() string {
	if value := strings.TrimSpace(m.DefaultReasoningEffort); value != "" {
		return value
	}
	return strings.TrimSpace(m.DefaultReasoningEffortSnake)
}

func (o piLocalModelOverride) declaredAllowedEfforts() []string {
	for _, list := range [][]string{
		o.AllowedReasoningEffort,
		o.AllowedReasoningEffortSnake,
		o.ReasoningEfforts,
		o.ReasoningEffortsSnake,
	} {
		if len(list) > 0 {
			return list
		}
	}
	return nil
}

func (o piLocalModelOverride) declaredDefaultEffort() string {
	if value := strings.TrimSpace(o.DefaultReasoningEffort); value != "" {
		return value
	}
	return strings.TrimSpace(o.DefaultReasoningEffortSnake)
}

func (o piLocalModelOverride) declaresEffortConstraint() bool {
	return o.Reasoning != nil ||
		len(o.ThinkingLevelMap) > 0 ||
		len(o.declaredAllowedEfforts()) > 0
}

// piModelEffortSupport derives the advertised effort options and default for a
// Pi catalog or models.json entry. Explicit allowed-effort lists take
// precedence over Pi's thinkingLevelMap.
func piModelEffortSupport(model piCatalogModel, fallbackDefault string) *EffortSupport {
	defaultLevel := model.declaredDefaultEffort()
	if defaultLevel == "" {
		defaultLevel = strings.TrimSpace(fallbackDefault)
	}
	if declared := model.declaredAllowedEfforts(); len(declared) > 0 {
		var efforts effortCatalog
		for _, raw := range declared {
			value := canonicalEffortName(raw)
			if value != "" {
				efforts.add(value, "")
			}
		}
		return finalizeEffortSupport(efforts, defaultLevel)
	}
	if !model.Reasoning {
		return nil
	}
	return piEffortSupport(model.ThinkingLevelMap, defaultLevel)
}

func finalizeEffortSupport(efforts effortCatalog, defaultLevel string) *EffortSupport {
	support := efforts.support("")
	if support == nil {
		return nil
	}
	for i := range support.Options {
		if support.Options[i].Value == "off" {
			support.Options[i].Value = "none"
		}
	}
	defaultLevel = strings.TrimSpace(defaultLevel)
	if defaultLevel != "" {
		allowed := make([]string, len(support.Options))
		for i, option := range support.Options {
			allowed[i] = option.Value
		}
		support.Default = NormalizeReasoningEffort(defaultLevel, allowed, "")
	}
	return support
}

// piResolveThinkingLevel validates requestedEffort and, when the target model
// is described in Pi's local models.json, clamps the level to that model's
// supported thinking levels (or omits --thinking for non-reasoning models).
// Models absent from models.json keep the validated requested level unchanged.
func piResolveThinkingLevel(profile Profile, modelID, requestedEffort string) (string, error) {
	thinking, err := piThinkingLevel(requestedEffort)
	if err != nil || thinking == "" {
		return thinking, err
	}
	model, settingsDefault, ok := piLookupLocalModel(profile, modelID)
	if !ok {
		return thinking, nil
	}
	support := piModelEffortSupport(model, settingsDefault)
	if support == nil {
		return "", nil
	}
	return piClampThinkingToSupport(thinking, support), nil
}

// piStateThinkingLevel checks the active model reported by Pi's get_state RPC
// and reports whether set_thinking_level is needed to keep the turn within
// that model's declared capabilities.
func piStateThinkingLevel(state piCatalogState, requestedThinking string) (string, bool) {
	model := state.Model
	if model.ID == "" {
		return "", false
	}
	stateLevel := strings.TrimSpace(state.ThinkingLevel)
	hasExplicitConstraints := len(model.ThinkingLevelMap) > 0 || len(model.declaredAllowedEfforts()) > 0
	if !hasExplicitConstraints && !model.Reasoning {
		if stateLevel != "" && canonicalEffortName(stateLevel) != "none" {
			return "off", true
		}
		return "", false
	}
	support := piModelEffortSupport(model, "")
	if support == nil {
		if stateLevel != "" && canonicalEffortName(stateLevel) != "none" {
			return "off", true
		}
		return "", false
	}
	target := strings.TrimSpace(requestedThinking)
	if target == "" {
		target = stateLevel
	}
	if target == "" {
		return "", false
	}
	clamped := piClampThinkingToSupport(target, support)
	if clamped == "" ||
		canonicalEffortName(clamped) == canonicalEffortName(stateLevel) ||
		(stateLevel == "" && canonicalEffortName(clamped) == canonicalEffortName(requestedThinking)) {
		return "", false
	}
	return clamped, true
}

func piClampThinkingToSupport(thinking string, support *EffortSupport) string {
	if support == nil || len(support.Options) == 0 {
		return ""
	}
	allowed := make([]string, len(support.Options))
	for i, option := range support.Options {
		allowed[i] = option.Value
	}
	normalized := NormalizeReasoningEffort(thinking, allowed, support.Default)
	return piEffortToThinkingFlag(normalized)
}

type piLocalSettings struct {
	DefaultProvider      string            `json:"defaultProvider"`
	DefaultModel         string            `json:"defaultModel"`
	DefaultThinkingLevel string            `json:"defaultThinkingLevel"`
	ModelThinkingLevels  map[string]string `json:"modelThinkingLevels"`
}

type piLocalModelsFile struct {
	Providers map[string]struct {
		Models         []piCatalogModel                `json:"models"`
		ModelOverrides map[string]piLocalModelOverride `json:"modelOverrides"`
	} `json:"providers"`
}

type piLocalModelOverride struct {
	Name                        string                     `json:"name"`
	Reasoning                   *bool                      `json:"reasoning"`
	ThinkingLevelMap            map[string]json.RawMessage `json:"thinkingLevelMap"`
	AllowedReasoningEffort      []string                   `json:"allowedReasoningEffort"`
	AllowedReasoningEffortSnake []string                   `json:"allowed_reasoning_effort"`
	ReasoningEfforts            []string                   `json:"reasoningEfforts"`
	ReasoningEffortsSnake       []string                   `json:"reasoning_efforts"`
	DefaultReasoningEffort      string                     `json:"defaultReasoningEffort"`
	DefaultReasoningEffortSnake string                     `json:"default_reasoning_effort"`
}

type parsedPiLocalConfig struct {
	settings  piLocalSettings
	models    piLocalModelsFile
	hasModels bool
}

type piFileStatKey struct {
	exists  bool
	size    int64
	modNano int64
}

type piStatCacheKey struct {
	dir      string
	settings piFileStatKey
	models   piFileStatKey
}

var piConfigCache = struct {
	mu       sync.Mutex
	byDigest map[string]parsedPiLocalConfig
	byStat   map[piStatCacheKey]parsedPiLocalConfig
}{
	byDigest: make(map[string]parsedPiLocalConfig),
	byStat:   make(map[piStatCacheKey]parsedPiLocalConfig),
}

func parsePiLocalConfigBytes(settingsData, modelsData []byte) parsedPiLocalConfig {
	var parsed parsedPiLocalConfig
	if len(settingsData) > 0 && len(settingsData) <= piConfigReadLimit {
		_ = json.Unmarshal(settingsData, &parsed.settings)
	}
	if len(modelsData) > 0 && len(modelsData) <= piConfigReadLimit {
		if json.Unmarshal(modelsData, &parsed.models) == nil {
			parsed.hasModels = true
		}
	}
	return parsed
}

func statPiConfigFile(path string) piFileStatKey {
	info, err := os.Stat(path)
	if err != nil {
		return piFileStatKey{}
	}
	return piFileStatKey{
		exists:  true,
		size:    info.Size(),
		modNano: info.ModTime().UnixNano(),
	}
}

func piLoadLocalConfig(profile Profile) (parsedPiLocalConfig, bool) {
	if profile.PiConfigDigest != "" {
		piConfigCache.mu.Lock()
		cached, ok := piConfigCache.byDigest[profile.PiConfigDigest]
		piConfigCache.mu.Unlock()
		if ok {
			return cached, cached.hasModels
		}
		if profile.PiSettingsJSON != nil || profile.PiModelsJSON != nil {
			parsed := parsePiLocalConfigBytes(profile.PiSettingsJSON, profile.PiModelsJSON)
			piConfigCache.mu.Lock()
			if len(piConfigCache.byDigest) >= piConfigCacheMax {
				clear(piConfigCache.byDigest)
			}
			piConfigCache.byDigest[profile.PiConfigDigest] = parsed
			piConfigCache.mu.Unlock()
			return parsed, parsed.hasModels
		}
	}

	dir := piAgentDir(profile.Env)
	if dir == "" {
		return parsedPiLocalConfig{}, false
	}
	settingsPath := filepath.Join(dir, "settings.json")
	modelsPath := filepath.Join(dir, "models.json")
	key := piStatCacheKey{
		dir:      dir,
		settings: statPiConfigFile(settingsPath),
		models:   statPiConfigFile(modelsPath),
	}
	if !key.models.exists {
		return parsedPiLocalConfig{}, false
	}
	piConfigCache.mu.Lock()
	cached, ok := piConfigCache.byStat[key]
	piConfigCache.mu.Unlock()
	if ok {
		return cached, cached.hasModels
	}
	var settingsData []byte
	if key.settings.exists {
		settingsData, _ = readPiConfigFile(settingsPath)
	}
	modelsData, err := readPiConfigFile(modelsPath)
	if err != nil {
		return parsedPiLocalConfig{}, false
	}
	parsed := parsePiLocalConfigBytes(settingsData, modelsData)
	piConfigCache.mu.Lock()
	if len(piConfigCache.byStat) >= piConfigCacheMax {
		clear(piConfigCache.byStat)
	}
	piConfigCache.byStat[key] = parsed
	piConfigCache.mu.Unlock()
	return parsed, parsed.hasModels
}

func piLookupLocalModel(profile Profile, modelID string) (piCatalogModel, string, bool) {
	loaded, ok := piLoadLocalConfig(profile)
	if !ok {
		return piCatalogModel{}, "", false
	}
	providerName, id := splitPiModelRef(modelID)
	if providerName == "" && id == "" {
		providerName = strings.TrimSpace(loaded.settings.DefaultProvider)
		id = strings.TrimSpace(loaded.settings.DefaultModel)
	}
	if id == "" {
		return piCatalogModel{}, "", false
	}
	matchedProvider, model, ok := findPiLocalModel(loaded.models, providerName, id)
	if !ok {
		return piCatalogModel{}, "", false
	}
	defaultThinking := strings.TrimSpace(loaded.settings.DefaultThinkingLevel)
	if matchedProvider != "" {
		if perModel := strings.TrimSpace(loaded.settings.ModelThinkingLevels[matchedProvider+"/"+model.ID]); perModel != "" {
			defaultThinking = perModel
		}
	}
	return model, defaultThinking, true
}

func piOverrideOnlyModel(providerName, id string, override piLocalModelOverride) (piCatalogModel, bool) {
	if !override.declaresEffortConstraint() {
		return piCatalogModel{}, false
	}
	model := piCatalogModel{
		ID:        id,
		Provider:  providerName,
		Reasoning: override.Reasoning == nil && len(override.ThinkingLevelMap) > 0,
	}
	return applyPiLocalOverride(model, override), true
}

func findPiLocalModel(config piLocalModelsFile, providerName, id string) (string, piCatalogModel, bool) {
	if providerName != "" {
		entry, ok := config.Providers[providerName]
		if !ok {
			return "", piCatalogModel{}, false
		}
		for _, model := range entry.Models {
			if strings.TrimSpace(model.ID) == id {
				model.Provider = providerName
				return providerName, applyPiLocalOverride(model, entry.ModelOverrides[id]), true
			}
		}
		if override, ok := entry.ModelOverrides[id]; ok {
			if model, valid := piOverrideOnlyModel(providerName, id, override); valid {
				return providerName, model, true
			}
		}
		return "", piCatalogModel{}, false
	}

	var matchedProvider string
	var matched piCatalogModel
	matches := 0
	for name, entry := range config.Providers {
		foundInModels := false
		for _, model := range entry.Models {
			if strings.TrimSpace(model.ID) == id {
				model.Provider = name
				matchedProvider = name
				matched = applyPiLocalOverride(model, entry.ModelOverrides[id])
				matches++
				foundInModels = true
				break
			}
		}
		if !foundInModels {
			if override, ok := entry.ModelOverrides[id]; ok {
				if model, valid := piOverrideOnlyModel(name, id, override); valid {
					matchedProvider = name
					matched = model
					matches++
				}
			}
		}
	}
	if matches == 1 {
		return matchedProvider, matched, true
	}
	return "", piCatalogModel{}, false
}

func applyPiLocalOverride(model piCatalogModel, override piLocalModelOverride) piCatalogModel {
	if override.Name != "" {
		model.Name = override.Name
	}
	if override.Reasoning != nil {
		model.Reasoning = *override.Reasoning
	}
	if len(override.ThinkingLevelMap) > 0 {
		merged := make(map[string]json.RawMessage, len(model.ThinkingLevelMap)+len(override.ThinkingLevelMap))
		for key, value := range model.ThinkingLevelMap {
			merged[key] = value
		}
		for key, value := range override.ThinkingLevelMap {
			merged[key] = value
		}
		model.ThinkingLevelMap = merged
	}
	if overrideAllowed := override.declaredAllowedEfforts(); len(overrideAllowed) > 0 {
		model.AllowedReasoningEffort = overrideAllowed
		model.AllowedReasoningEffortSnake = nil
		model.ReasoningEfforts = nil
		model.ReasoningEffortsSnake = nil
	} else if len(override.ThinkingLevelMap) > 0 {
		model.AllowedReasoningEffort = nil
		model.AllowedReasoningEffortSnake = nil
		model.ReasoningEfforts = nil
		model.ReasoningEffortsSnake = nil
	}
	if overrideDefault := override.declaredDefaultEffort(); overrideDefault != "" {
		model.DefaultReasoningEffort = overrideDefault
		model.DefaultReasoningEffortSnake = ""
	}
	return model
}

func splitPiModelRef(modelID string) (string, string) {
	trimmed := strings.TrimSpace(modelID)
	if trimmed == "" || trimmed == piDefaultModel {
		return "", ""
	}
	if provider, id, ok := strings.Cut(trimmed, "/"); ok {
		return strings.TrimSpace(provider), strings.TrimSpace(id)
	}
	return "", trimmed
}

func piAgentDir(env map[string]string) string {
	if dir := strings.TrimSpace(env["PI_CODING_AGENT_DIR"]); dir != "" {
		return filepath.Clean(dir)
	}
	if home := strings.TrimSpace(env["HOME"]); home != "" {
		return filepath.Join(home, ".pi", "agent")
	}
	return ""
}

func readPiConfigFile(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, piConfigReadLimit+1))
	if err != nil {
		return nil, err
	}
	if len(data) > piConfigReadLimit {
		return nil, os.ErrInvalid
	}
	return data, nil
}
