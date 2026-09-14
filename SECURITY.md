# Security Policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub private vulnerability reporting for the canonical `handstack/handstack` repository. If that channel is unavailable, contact the maintainers privately through the repository owner profile. Include affected versions, reproduction steps, impact, and any suggested mitigation.

Maintainers should acknowledge a report within three business days, provide an initial assessment within ten business days, and coordinate remediation and disclosure with the reporter. These are response targets, not guarantees.

## Supported versions

Until the first stable release, security fixes target the latest commit on the default branch. The maintained version matrix will be recorded here before a stable release. Never include production secrets or personal data in a report or reproducer.

## Security defaults

Telemetry is opt-in. CORS is deny-by-default, logs redact known secret fields, and generated Graphify data is development-only. See `docs/governance/support-matrix.md` for the runtime support baseline.
