# Versioning and compatibility

HandStack is pre-1.0. Until `1.0.0`, minor releases may contain breaking changes. Consumers that need
stable behavior should pin a commit or released version and validate upgrades in a staging environment.

## Compatibility surfaces

Treat these as versioned interfaces:

- HTTP and OpenAPI operations;
- CLI commands and exit codes;
- SDK exports and serialized payloads;
- configuration keys and deployment values;
- database migrations and backup formats;
- plugin and capability contracts.

## Change policy

- Document user-visible changes in [CHANGELOG.md](../../CHANGELOG.md).
- Mark breaking changes explicitly in release notes and migration guidance.
- Update the requirements catalog and traceability for behavior changes.
- Add focused tests for the changed contract.
- Validate upgrade and rollback behavior before claiming release readiness.

After the first stable release, the project will use Semantic Versioning for public APIs and will publish
the supported runtime and deployment matrix with each release.
