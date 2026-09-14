import { PluginRegistry } from '@handstack/plugins';
import { Injectable } from '@nestjs/common';

@Injectable()
export class PluginRegistryRuntimeService {
  readonly registry = new PluginRegistry();
}
