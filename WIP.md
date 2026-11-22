# T8 WIP (not committed)

Status: paused by coordinator (model capacity) before any code edits.

Branch: oldwinter/lmt-t8 at a2d0cc7f (= origin/oldwinter/local-models-team). Worktree clean apart from this file.

Read so far:
- TASKS.md T8, DESIGN.md sections 0, 1, 2, 5, 6, 7, 8.
- apps/computer/AGENTS.md; local-daemon/internal/computercli cli.go, arguments.go, errors.go, main.go.

Next steps:
- Read computerconfig/config.go (local_models section), computerprofile/probe.go (hardware probe to reuse),
  localmodels/library.go + status.go (library status --json, schema localmodels.library-status/v1),
  computercli/setup.go (staged local models on login), help.go, release generator (localmodels.json pin from kit release.json),
  daemon selfupdate (D6 background kit upgrade, maybe split as T8b), TeamHub version constant for enable_command.
- Implement local-models enable/status/disable per DESIGN 6 with exit codes 0/2/3/4/5/6 and --json schema
  linger-computer.local-models-enable/v1.
