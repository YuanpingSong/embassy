# Security Policy

## Supported versions

Security fixes are applied to the `main` branch. No released version is
currently supported independently of `main`.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through this repository's
GitHub Security Advisory interface. Do not open a public issue for a suspected
security problem.

Do not include credentials, OAuth material, raw Claude output, local bridge
state, Claude configuration, or unredacted machine paths in a report. Replace
sensitive values with minimal synthetic reproductions.

## Security boundary

This bridge is intended for one person, one local OS account, and stdio MCP
transport. It must not be exposed as a network service or used to share a
subscription between users. Read-only operation is the default. Changes that
widen tools, environment forwarding, authentication behavior, state access,
or workspace permissions require focused tests and explicit security review.
