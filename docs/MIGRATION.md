# Migrating from the prototype

Embassy is the public gateway extracted from an unpublished internal prototype.
This document collects the migration notes for operators moving from that
prototype to Embassy v1.

---

- The prototype's one-way MCP task lifecycle is retired and is not part of Embassy v1.
- Stop any foreground prototype gateway before the first `embassy serve`. For one release, Embassy bounded-reads only the exact legacy default ownership marker and controller-lock record, then holds a newly created legacy lock while running. Any pre-existing legacy lock is preserved and startup stops as `GATEWAY_INSTANCE_IN_USE`; after confirming no prototype process remains, remove that exact stale lock manually and retry. Legacy gateway state and message data are not imported, migrated, or deleted.
- Embassy starts with clean state under `agent-embassy`; it does not migrate prototype state. Register the Codex task and select the Claude destination again. A state-directory override cannot be used to run a second controller.
- `claude-codex-gateway` remains as a deprecated binary alias for one release. New usage should call `embassy`.
