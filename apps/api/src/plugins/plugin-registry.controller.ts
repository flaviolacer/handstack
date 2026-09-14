import { PluginRegistryRuntimeService } from './plugin-registry.runtime.js';
import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { PluginCatalog } from '@handstack/plugins';

@ApiTags('Plugin Registry')
@Controller('registry/plugins')
export class PluginRegistryController {
  constructor(
    @Inject(PluginRegistryRuntimeService) private readonly runtime: PluginRegistryRuntimeService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List official, community, installed or update plugins' })
  @ApiQuery({
    name: 'catalog',
    required: false,
    enum: ['OFFICIAL', 'COMMUNITY', 'INSTALLED', 'UPDATES'],
  })
  list(@Query('catalog') catalog?: PluginCatalog, @Query('search') search?: string) {
    return { items: this.runtime.registry.search(search ?? '', catalog ?? 'OFFICIAL') };
  }

  @Get(':name')
  @ApiOperation({ summary: 'Resolve a plugin registry entry' })
  get(@Param('name') name: string, @Query('version') version?: string) {
    return this.runtime.registry.get(name, version);
  }
}
