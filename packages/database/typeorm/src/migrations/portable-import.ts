import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PortableImport1735689600001 implements MigrationInterface {
  name = 'PortableImport1735689600001';

  async up(queryRunner: QueryRunner): Promise<void> {
    const type = queryRunner.connection.options.type;
    const timestamp =
      type === 'postgres'
        ? 'timestamp with time zone'
        : type === 'mssql'
          ? 'datetime2'
          : 'datetime';
    const text = type === 'mssql' ? 'varchar(max)' : 'text';
    await queryRunner.query(`CREATE TABLE handstack_portable_imports (
      export_id varchar(120) NOT NULL PRIMARY KEY,
      sequence integer NOT NULL,
      status varchar(20) NOT NULL,
      manifest ${text} NULL
    )`);
    await queryRunner.query(`CREATE TABLE handstack_portable_records (
      export_id varchar(120) NOT NULL,
      sequence integer NOT NULL,
      repository_name varchar(120) NOT NULL,
      tenant_id varchar(64) NOT NULL,
      id varchar(36) NOT NULL,
      version integer NOT NULL,
      created_at ${timestamp} NOT NULL,
      updated_at ${timestamp} NOT NULL,
      payload ${text} NOT NULL,
      CONSTRAINT pk_handstack_portable_records PRIMARY KEY (export_id, sequence)
    )`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE handstack_portable_records');
    await queryRunner.query('DROP TABLE handstack_portable_imports');
  }
}
