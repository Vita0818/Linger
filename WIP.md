# T5 WIP (not committed)

Status: no code edits yet; read TASKS T3/T4/T5, DESIGN §2.3, §3, §4, §5.2 and the web local-models feature.

Plan:
- `?view=all` on LocalModelsPage renders an AllComputers overview (new file
  all-computers-overview.tsx); default-computer effect must not run then.
  Reuse localModelsSummaryQueryOptions (scope=mine; T12 adds space).
- Row: PlatformGlyph, name (link to `?computer=id`), "· container", ComputerChip,
  one pill: library states -> Open link; plan.primary from emptyStatePlan:
  command -> toggle inline CommandBlock (+ secondary links), docs -> pill anchor,
  refresh -> Check again, open -> Link, desktopSetup -> desktop button; tabs or
  no primary -> no pill (name link opens the library page).
- Generalize emptyStatePlan input to an interface (computer, viewer_is_owner,
  observed_at?, reason?) so a summary row maps to it; export CommandBlock etc.
- Line 2: platform · accelerators (GPU names + VRAM / Apple ... unified / No GPU · RAM)
  · memory in use (summary.memory) · "Computer <v>" for needs_update/needs_reinstall.
- Filters All / Needs action (needs_*, not_set_up) / Ready (online + loaded|ready|working)
  / Offline; search above 6; sort online first then compareComputers.
- Picker footer link "All computers" -> `?view=all`.
- Computers page row: chip from LocalComputer.local_models_readiness; generalize
  computerChip input to {readiness, status, last_seen_at, counts?}.
- Tests: per filter, action buttons, computers-hint live chip update (event-sync
  applyTeamHubEventSignal with a rendered overview).
- Docs: apps/web/AGENTS.md local-models section.
