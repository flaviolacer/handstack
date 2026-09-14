import { configFromEnvironment, type HandStackConfig } from '@handstack/config';
import { createDatabaseAdapter, type DatabaseAdapter } from '@handstack/database';
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  readonly config: HandStackConfig;
  readonly adapter: DatabaseAdapter;
  private initialized = false;

  constructor() {
    this.config = configFromEnvironment(process.env);
    this.adapter = createDatabaseAdapter(this.config);
  }

  async onModuleInit(): Promise<void> {
    await this.adapter.initialize();
    this.initialized = true;
  }

  async onModuleDestroy(): Promise<void> {
    await this.adapter.close();
    this.initialized = false;
  }

  status(): 'up' | 'down' {
    return this.initialized ? 'up' : 'down';
  }
}
