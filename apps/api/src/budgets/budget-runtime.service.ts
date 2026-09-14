import { BudgetEngine, PricingCatalog } from '@handstack/budgets';
import { Injectable, Inject } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

@Injectable()
export class BudgetRuntimeService {
  readonly engine: BudgetEngine;
  readonly pricing: PricingCatalog;

  constructor(@Inject(DatabaseService) database: DatabaseService) {
    this.engine = new BudgetEngine(database.adapter);
    this.pricing = new PricingCatalog(database.adapter);
  }
}
