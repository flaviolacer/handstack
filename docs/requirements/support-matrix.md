# Support matrix foundation

Status: foundation for versioned release certification. Exact production ranges must be certified before the first stable release.

| Component                                 | Development baseline                   | Stable-release requirement                   |
| ----------------------------------------- | -------------------------------------- | -------------------------------------------- |
| Node.js                                   | 22 and 24 LTS                          | Previous and current supported LTS           |
| Chrome / Edge / Firefox / Safari          | Latest two stable versions             | Automated compatibility suite                |
| Kubernetes                                | To be certified in M18                 | Minimum and maximum minor versions published |
| Helm                                      | To be certified in M18                 | Tested chart client versions published       |
| Redis                                     | Optional compact; required distributed | HA/Sentinel/Cluster ranges published         |
| PostgreSQL / MySQL / MariaDB / SQL Server | M1 adapters                            | Certified min/max versions                   |
| SQLite                                    | Default compact database               | Bundled-driver version published             |
| MongoDB                                   | M1 first-class adapter                 | Replica-set/sharded ranges published         |
| Vector stores                             | M13/M18                                | Adapter-specific ranges and tested adapters  |
| Object storage APIs                       | M13/M18                                | S3-compatible API range and tested providers |

No row marked “to be certified” is evidence of final support. M18 must replace it with reproducible test results.
Stable releases also publish compatibility evidence for upgrades from the previous two stable
minor versions, plus SBOM, signature, provenance, checksum, and permission-diff artifacts.
