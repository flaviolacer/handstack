import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const releaseDir = join(root, 'deploy', 'release');
const readJson = (name) => JSON.parse(readFileSync(join(releaseDir, name), 'utf8'));
const fail = (message) => {
  throw new Error(`Release contract: ${message}`);
};
const manifest = readJson('handstack-release-manifest.json');
const evidenceFiles = Object.values(manifest.operationalEvidence ?? {});
if (evidenceFiles.length !== 3) fail('operational evidence references are incomplete');
for (const file of evidenceFiles)
  if (!existsSync(join(releaseDir, file))) fail(`missing operational evidence ${file}`);
const requiredFiles = [
  manifest.artifacts.sbom,
  manifest.artifacts.provenance,
  manifest.artifacts.signature,
  manifest.artifacts.checksums,
  manifest.artifacts.permissionDiff,
];
for (const file of requiredFiles)
  if (!existsSync(join(releaseDir, file))) fail(`missing artifact ${file}`);
if (manifest.schemaVersion !== 1 || manifest.product !== 'handstack')
  fail('unsupported manifest schema or product');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(manifest.release.version))
  fail('release version is not semver');
if (!manifest.release.publisher || !manifest.release.sourceRevision)
  fail('publisher and source revision are required');

const matrix = manifest.supportMatrix;
const requiredPlatforms = [
  'node',
  'browsers',
  'kubernetes',
  'helm',
  'redis',
  'postgresql',
  'mysql',
  'mariadb',
  'sqlserver',
  'sqlite',
  'mongodb',
  'vectorStores',
  'objectStorage',
];
for (const platform of requiredPlatforms) {
  const entry = matrix[platform];
  if (
    !entry ||
    (!entry.min && platform !== 'browsers') ||
    (!entry.maxExclusive && platform !== 'browsers') ||
    !Array.isArray(entry.tested) ||
    entry.tested.length === 0
  )
    fail(`support matrix entry ${platform} must publish min, maxExclusive and tested versions`);
}
if (matrix.browsers.policy !== 'latest-two-stable')
  fail('browser support must use latest-two-stable policy');
if (matrix.mongodb.topology !== 'replica-set-or-sharded')
  fail('MongoDB production topology is not explicit');
if (
  matrix.vectorStores.compatibility !== 'adapter-specific' ||
  matrix.vectorStores.adapters.length === 0
)
  fail('vector store support must publish adapter-specific compatibility');
if (
  matrix.objectStorage.compatibility !== 's3-compatible-api' ||
  matrix.objectStorage.apis.length === 0
)
  fail('object storage support must publish API compatibility');
const lifecycle = manifest.lifecycle;
if (
  lifecycle.deprecationNoticeDays < 90 ||
  lifecycle.eolNoticeDays < 180 ||
  lifecycle.upgradeFromPreviousStableMinors !== 2 ||
  !Array.isArray(lifecycle.deprecations) ||
  !Array.isArray(lifecycle.eol)
)
  fail('deprecation/EOL policy is incomplete');

const sbom = readJson(manifest.artifacts.sbom);
if (sbom.bomFormat !== 'CycloneDX' || sbom.specVersion !== '1.5' || !Array.isArray(sbom.components))
  fail('SBOM is not a valid CycloneDX 1.5 document');
if (
  sbom.metadata?.component?.name !== 'handstack' ||
  sbom.metadata.component.version !== manifest.release.version
)
  fail('SBOM component does not match release');
const provenance = readJson(manifest.artifacts.provenance);
const subject = provenance.subject?.find(
  (item) => item.name === manifest.artifacts.sourceArchive.name,
);
if (
  provenance.predicateType !== 'https://slsa.dev/provenance/v1' ||
  subject?.digest?.sha256 !== manifest.artifacts.sourceArchive.sha256
)
  fail('provenance does not bind the declared source checksum');
const checksums = readFileSync(join(releaseDir, manifest.artifacts.checksums), 'utf8');
if (
  !checksums.includes(
    `${manifest.artifacts.sourceArchive.sha256}  ${manifest.artifacts.sourceArchive.name}`,
  )
)
  fail('checksum manifest does not bind source artifact');
const permissionDiff = readJson(manifest.artifacts.permissionDiff);
if (
  permissionDiff.schemaVersion !== 1 ||
  permissionDiff.release !== manifest.release.version ||
  permissionDiff.review?.requiredApprover !== 'security-review'
)
  fail('permission diff is incomplete or not bound to the release');
for (const [name, verification] of Object.entries(manifest.verification)) {
  if (
    !verification.status ||
    (!verification.evidence && !verification.approval && !verification.tool)
  )
    fail(`${name} lacks status and evidence`);
}
if (
  !Array.isArray(manifest.lifecycle.deprecations) ||
  manifest.lifecycle.deprecations.some((item) => !item.replacement || !item.removalVersion)
)
  fail('deprecations need replacement and removalVersion');
const signature = readFileSync(join(releaseDir, manifest.artifacts.signature), 'utf8').trim();
if (!signature) fail('signature artifact is empty');
const rolling = readJson(manifest.operationalEvidence.rollingCompatibility);
if (
  rolling.schemaVersion !== 1 ||
  rolling.previousStableMinors !== 2 ||
  !Array.isArray(rolling.databaseWindows) ||
  rolling.databaseWindows.length === 0 ||
  !Array.isArray(rolling.eventWindows) ||
  rolling.eventWindows.length === 0
)
  fail('rolling database/event compatibility evidence is incomplete');
for (const window of [...rolling.databaseWindows, ...rolling.eventWindows]) {
  if (!window.from || !window.to || window.status !== 'offline-validated' || !window.evidence)
    fail('rolling compatibility entries need versions, status, and evidence');
}
const remediation = readJson(manifest.operationalEvidence.securityRemediation);
if (
  remediation.schemaVersion !== 1 ||
  !Array.isArray(remediation.severitySla) ||
  remediation.severitySla.length < 4 ||
  !remediation.disclosureProcess ||
  !remediation.penetrationTesting
)
  fail('security remediation policy is incomplete');
for (const item of remediation.severitySla)
  if (!item.severity || !item.remediateWithinDays || !item.affectedVersionsPolicy)
    fail('security remediation SLA entries are incomplete');
const rotation = readJson(manifest.operationalEvidence.credentialRotation);
if (
  rotation.schemaVersion !== 1 ||
  !Array.isArray(rotation.credentialClasses) ||
  rotation.credentialClasses.length < 7 ||
  !rotation.recoveryDrill ||
  !rotation.revocation
)
  fail('credential rotation policy is incomplete');
for (const item of rotation.credentialClasses)
  if (!item.name || !item.overlap || !item.revocation || !item.recovery)
    fail('credential rotation entries need overlap, revocation, and recovery');
if (
  manifest.release.channel !== 'development' &&
  manifest.artifacts.signatureStatus === 'pipeline-required'
)
  fail('production release cannot use a pipeline-required placeholder signature');
console.log(
  `Release contract passed: ${manifest.release.version}, ${requiredPlatforms.length} support entries, SBOM/provenance/checksum bound.`,
);
