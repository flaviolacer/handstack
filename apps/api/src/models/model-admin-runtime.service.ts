import { CoreEvaluationProvider } from '@handstack/evaluation';
import { createOfficialProviderFactories } from '@handstack/model-provider-bootstrap';
import { ModelRegistry } from '@handstack/model-registry';
import { ModelEvaluationCaseRunner, ModelExecutionRuntime } from '@handstack/model-runtime';
import { AiGovernanceOpenTelemetry } from '@handstack/telemetry';
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

@Injectable()
export class ModelAdminRuntimeService {
  readonly evaluation: CoreEvaluationProvider;
  readonly execution: ModelExecutionRuntime;
  readonly registry: ModelRegistry;

  constructor(@Inject(DatabaseService) database: DatabaseService) {
    const telemetry = new AiGovernanceOpenTelemetry();
    const secrets = {
      resolve: (organizationId: string, reference: string) => {
        if (organizationId === '') return Promise.reject(new Error('Invalid organization scope'));
        const match = /^env:\/\/(HANDSTACK_SECRET_[A-Z0-9_]+)$/.exec(reference);
        if (match?.[1] === undefined)
          return Promise.reject(new Error('Unsupported model secret reference'));
        const value = process.env[match[1]];
        return value === undefined || value === ''
          ? Promise.reject(new Error('Model secret is unavailable'))
          : Promise.resolve(value);
      },
    };
    const baseRegistry = new ModelRegistry(database.adapter, undefined, telemetry);
    const factories = createOfficialProviderFactories();
    const runner = new ModelEvaluationCaseRunner(baseRegistry, factories, secrets);
    this.evaluation = new CoreEvaluationProvider(database.adapter, runner, undefined, telemetry);
    this.registry = new ModelRegistry(database.adapter, this.evaluation, telemetry);
    this.execution = new ModelExecutionRuntime(
      this.registry,
      factories,
      secrets,
      undefined,
      telemetry,
    );
  }
}
