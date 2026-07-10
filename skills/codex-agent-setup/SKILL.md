---
name: codex-agent-setup
description: >-
  Explicit-only installer for the Sigma Auth Siggy Codex custom agent. Use ONLY
  when the user explicitly asks to install, update, check, uninstall, or set up
  the Sigma Auth or Siggy Codex agent, including "install Siggy in Codex",
  "update the Sigma Auth Codex agent", or "check sigma_auth_guide". Never
  auto-invoke for ordinary OAuth, authentication, Better Auth, BAP, wallet,
  session, passkey, or security requests.
disable-model-invocation: false
user-invocable: true
metadata:
  author: b-open-io
  version: "1.0.0"
  codex:
    disable-model-invocation: true
    explicit_invocation_only: true
    never_modify_global_config: true
---

# Sigma Auth Codex Agent Setup

Install Siggy's generated Codex adapter as a regular file. Run this skill only
after an explicit request to install, update, check, or uninstall Siggy.

## Safety contract

- Default to the current project's `.codex/agents/` directory.
- Use `--user` only when the user explicitly requests a user-wide install.
- Never edit `~/.codex/config.toml` or any global Codex configuration.
- Never create plugin-cache symlinks or delete unrelated custom agents.
- Run `--check` when the user asks what would change.

## Commands

```bash
bash "${SKILL_DIR}/scripts/setup.sh" [--check|--uninstall|--force]
bash "${SKILL_DIR}/scripts/setup.sh" --user [--check|--uninstall|--force]
bash "${SKILL_DIR}/scripts/setup.sh" --target /custom/agents/directory
```

The installer manages only `sigma-auth-guide.toml` and records ownership in
`.sigma-auth-agents.json`. An unmanaged collision is refused unless the user
explicitly authorizes `--force`.

After a successful install or update, tell the user to start a **new Codex
session**, then invoke Siggy using the runtime name `sigma_auth_guide`.

## Maintainer generation

```bash
bash "${SKILL_DIR}/scripts/generate.sh"
bash "${SKILL_DIR}/scripts/generate.sh" --check
```
