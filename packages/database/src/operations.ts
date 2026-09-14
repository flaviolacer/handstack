import {
  documentMigrations,
  entityCollectionName,
  migrationCollectionName,
  MongoAdapter,
  portableImportCollectionName,
  portableRecordCollectionName,
} from '@handstack/database-mongodb';
import { TypeOrmAdapter } from '@handstack/database-typeorm';

export interface MigrationStatus {
  readonly adapter: string;
  readonly applied: readonly string[];
  readonly pending: readonly string[];
}

export interface DoctorCheck {
  readonly name: 'connection' | 'version' | 'transactions' | 'schema' | 'migrations' | 'indexes';
  readonly status: 'pass' | 'fail';
  readonly detail: string;
}

export interface DoctorReport {
  readonly healthy: boolean;
  readonly adapter: string;
  readonly checks: readonly DoctorCheck[];
}

async function typeOrmMigrationStatus(adapter: TypeOrmAdapter): Promise<MigrationStatus> {
  const appliedRows = await adapter.dataSource.query<{ name: string }[]>(
    'SELECT name FROM migrations ORDER BY id',
  );
  const applied = appliedRows.map((row) => row.name);
  const pending = adapter.dataSource.migrations
    .map((migration) => migration.name)
    .filter((name): name is string => name !== undefined)
    .filter((name) => !applied.includes(name));
  return { adapter: adapter.dataSource.options.type, applied, pending };
}

async function mongoMigrationStatus(adapter: MongoAdapter): Promise<MigrationStatus> {
  const appliedVersions = await adapter
    .nativeDatabase()
    .collection<{ version: number; name: string }>(migrationCollectionName)
    .find({})
    .sort({ version: 1 })
    .toArray();
  const applied = appliedVersions.map((migration) => migration.name);
  const pending = documentMigrations
    .filter((migration) => !appliedVersions.some((item) => item.version === migration.version))
    .map((migration) => migration.name);
  return { adapter: 'mongodb', applied, pending };
}

export function databaseMigrationStatus(adapter: unknown): Promise<MigrationStatus> {
  if (adapter instanceof MongoAdapter) return mongoMigrationStatus(adapter);
  if (adapter instanceof TypeOrmAdapter) return typeOrmMigrationStatus(adapter);
  throw new TypeError('Unsupported database adapter');
}

async function typeOrmDoctor(adapter: TypeOrmAdapter): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  try {
    await adapter.dataSource.query('SELECT 1');
    checks.push({ name: 'connection', status: 'pass', detail: 'query succeeded' });
  } catch (error) {
    checks.push({ name: 'connection', status: 'fail', detail: String(error) });
  }
  try {
    const type = adapter.dataSource.options.type;
    const query =
      type === 'postgres'
        ? 'SELECT version() AS version'
        : type === 'mssql'
          ? 'SELECT @@VERSION AS version'
          : type === 'sqljs'
            ? 'SELECT sqlite_version() AS version'
            : 'SELECT VERSION() AS version';
    const rows = await adapter.dataSource.query<Record<string, unknown>[]>(query);
    checks.push({ name: 'version', status: 'pass', detail: JSON.stringify(rows[0] ?? {}) });
  } catch (error) {
    checks.push({ name: 'version', status: 'fail', detail: String(error) });
  }
  try {
    await adapter.dataSource.transaction(async (manager) => {
      await manager.query('SELECT 1');
    });
    checks.push({ name: 'transactions', status: 'pass', detail: 'transaction committed' });
  } catch (error) {
    checks.push({ name: 'transactions', status: 'fail', detail: String(error) });
  }
  const runner = adapter.dataSource.createQueryRunner();
  try {
    const required = [
      'handstack_entities',
      'handstack_portable_imports',
      'handstack_portable_records',
    ];
    const present = await Promise.all(required.map((table) => runner.hasTable(table)));
    checks.push({
      name: 'schema',
      status: present.every(Boolean) ? 'pass' : 'fail',
      detail:
        required.filter((_, index) => !present[index]).join(', ') || 'required tables present',
    });
    const table = await runner.getTable('handstack_entities');
    const indexNames = new Set(table?.indices.map((index) => index.name) ?? []);
    checks.push({
      name: 'indexes',
      status: indexNames.has('idx_handstack_entities_tenant_order') ? 'pass' : 'fail',
      detail: [...indexNames].join(', ') || 'required index missing',
    });
  } finally {
    await runner.release();
  }
  const migrations = await typeOrmMigrationStatus(adapter);
  checks.push({
    name: 'migrations',
    status: migrations.pending.length === 0 ? 'pass' : 'fail',
    detail: migrations.pending.join(', ') || `${String(migrations.applied.length)} applied`,
  });
  return {
    healthy: checks.every((check) => check.status === 'pass'),
    adapter: adapter.dataSource.options.type,
    checks,
  };
}

async function mongoDoctor(adapter: MongoAdapter): Promise<DoctorReport> {
  const database = adapter.nativeDatabase();
  const checks: DoctorCheck[] = [];
  try {
    await database.command({ ping: 1 });
    checks.push({ name: 'connection', status: 'pass', detail: 'ping succeeded' });
  } catch (error) {
    checks.push({ name: 'connection', status: 'fail', detail: String(error) });
  }
  try {
    const build = (await database.command({ buildInfo: 1 })) as { version?: string };
    checks.push({
      name: 'version',
      status: build.version === undefined ? 'fail' : 'pass',
      detail: build.version ?? 'unknown',
    });
  } catch (error) {
    checks.push({ name: 'version', status: 'fail', detail: String(error) });
  }
  try {
    const session = adapter.nativeClient().startSession();
    try {
      await session.withTransaction(() =>
        database.collection(migrationCollectionName).findOne({}, { session }),
      );
    } finally {
      await session.endSession();
    }
    checks.push({
      name: 'transactions',
      status: 'pass',
      detail: 'replica-set transaction succeeded',
    });
  } catch (error) {
    checks.push({ name: 'transactions', status: 'fail', detail: String(error) });
  }
  const required = [
    entityCollectionName,
    migrationCollectionName,
    portableImportCollectionName,
    portableRecordCollectionName,
  ];
  const names = new Set(
    (await database.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name),
  );
  checks.push({
    name: 'schema',
    status: required.every((name) => names.has(name)) ? 'pass' : 'fail',
    detail:
      required.filter((name) => !names.has(name)).join(', ') || 'required collections present',
  });
  const indexNames = new Set(
    (await database.collection(entityCollectionName).indexes()).map((index) => index.name),
  );
  checks.push({
    name: 'indexes',
    status: indexNames.has('uq_handstack_entities_tenant_id') ? 'pass' : 'fail',
    detail: [...indexNames].join(', '),
  });
  const migrations = await mongoMigrationStatus(adapter);
  checks.push({
    name: 'migrations',
    status: migrations.pending.length === 0 ? 'pass' : 'fail',
    detail: migrations.pending.join(', ') || `${String(migrations.applied.length)} applied`,
  });
  return { healthy: checks.every((check) => check.status === 'pass'), adapter: 'mongodb', checks };
}

export function databaseDoctor(adapter: unknown): Promise<DoctorReport> {
  if (adapter instanceof MongoAdapter) return mongoDoctor(adapter);
  if (adapter instanceof TypeOrmAdapter) return typeOrmDoctor(adapter);
  throw new TypeError('Unsupported database adapter');
}
