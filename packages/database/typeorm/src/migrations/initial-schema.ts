import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1735689600000 implements MigrationInterface {
  name = 'InitialSchema1735689600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const databaseType = queryRunner.connection.options.type;
    const timestampType =
      databaseType === 'postgres'
        ? 'timestamp with time zone'
        : databaseType === 'mssql'
          ? 'datetime2'
          : 'datetime';
    const payloadType = databaseType === 'mssql' ? 'varchar(max)' : 'text';
    await queryRunner.query(`CREATE TABLE handstack_entities (
      repository_name varchar(120) NOT NULL,
      tenant_id varchar(64) NOT NULL,
      id varchar(36) NOT NULL,
      version integer NOT NULL,
      created_at ${timestampType} NOT NULL,
      updated_at ${timestampType} NOT NULL,
      payload ${payloadType} NOT NULL,
      CONSTRAINT pk_handstack_entities PRIMARY KEY (repository_name, tenant_id, id)
    )`);
    await queryRunner.query(
      'CREATE INDEX idx_handstack_entities_tenant_order ON handstack_entities (repository_name, tenant_id, created_at, id)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE handstack_entities');
  }
}
