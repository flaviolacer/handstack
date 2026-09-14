import {
  databaseDoctor,
  databaseMigrationStatus,
  type DatabaseAdapter,
  type DoctorReport,
  type MigrationStatus,
} from '@handstack/database';

export interface OperationalCommandRuntime {
  output(value: string): void;
}

export async function executeMigrateCommand(
  adapter: DatabaseAdapter,
  runtime: OperationalCommandRuntime,
): Promise<MigrationStatus> {
  const status = await databaseMigrationStatus(adapter);
  runtime.output(JSON.stringify({ command: 'migrate', ...status }));
  return status;
}

export async function executeDoctorCommand(
  adapter: DatabaseAdapter,
  runtime: OperationalCommandRuntime,
): Promise<DoctorReport> {
  const report = await databaseDoctor(adapter);
  runtime.output(JSON.stringify({ command: 'doctor', ...report }));
  if (!report.healthy) throw new Error(`Database doctor failed for ${report.adapter}`);
  return report;
}
