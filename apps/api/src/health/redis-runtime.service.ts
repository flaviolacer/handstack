import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  configLayerFromEnvironment,
  resolveConfigLayers,
  type HandStackConfig,
} from '@handstack/config';
import { connect, type Socket } from 'node:net';
import { connect as connectTls, type TLSSocket } from 'node:tls';
import { loadConfigFile } from '../database/config-file.js';

export type RedisStatus = 'up' | 'down' | 'not-configured';

export interface RedisProbe {
  ping(): Promise<void>;
  close(): Promise<void>;
}

type RedisSocket = Socket | TLSSocket;

/** Minimal Redis PING client; keeps Redis optional in compact development. */
export class TcpRedisProbe implements RedisProbe {
  private socket: RedisSocket | undefined;

  constructor(
    private readonly url: string,
    private readonly timeoutMs = 750,
  ) {}

  async ping(): Promise<void> {
    const parsed = new URL(
      this.url
        .replace(/^redis\+(?:sentinel|cluster):\/\//u, 'redis://')
        .replace(/^redis\+/, 'redis:'),
    );
    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:')
      throw new Error(`Unsupported Redis URL scheme: ${parsed.protocol}`);
    const port = parsed.port === '' ? 6379 : Number(parsed.port);
    await new Promise<void>((resolve, reject) => {
      const socket =
        parsed.protocol === 'rediss:'
          ? connectTls({ host: parsed.hostname, port, servername: parsed.hostname })
          : connect({ host: parsed.hostname, port });
      this.socket = socket;
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners();
        if (error === undefined) resolve();
        else {
          socket.destroy();
          reject(error);
        }
      };
      const timer = setTimeout(() => {
        finish(new Error('Redis PING timed out'));
      }, this.timeoutMs);
      socket.once('connect', () => {
        socket.write('*1\r\n$4\r\nPING\r\n');
      });
      socket.once('data', (data: Buffer) => {
        if (data.toString('utf8').startsWith('+PONG')) finish();
        else finish(new Error('Redis PING returned an invalid response'));
      });
      socket.once('error', (error: Error) => {
        finish(error);
      });
      socket.once('close', () => {
        finish(new Error('Redis connection closed'));
      });
    });
  }

  close(): Promise<void> {
    this.socket?.destroy();
    this.socket = undefined;
    return Promise.resolve();
  }
}

@Injectable()
export class RedisRuntimeService implements OnModuleDestroy {
  readonly config: HandStackConfig;
  private readonly probe: RedisProbe | undefined;
  private lastStatus: RedisStatus;

  constructor() {
    this.config = resolveConfigLayers(configLayerFromEnvironment(process.env), loadConfigFile());
    this.probe =
      this.config.queue.redisUrl === undefined
        ? undefined
        : new TcpRedisProbe(this.config.queue.redisUrl);
    this.lastStatus = this.probe === undefined ? 'not-configured' : 'down';
  }

  status(): RedisStatus {
    return this.lastStatus;
  }

  async check(): Promise<RedisStatus> {
    if (this.probe === undefined) return 'not-configured';
    try {
      await this.probe.ping();
      this.lastStatus = 'up';
    } catch {
      this.lastStatus = 'down';
    }
    return this.lastStatus;
  }

  async onModuleDestroy(): Promise<void> {
    await this.probe?.close();
  }
}
