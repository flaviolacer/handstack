import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { TcpRedisProbe } from '../src/health/redis-runtime.service.js';

describe('TcpRedisProbe', () => {
  it('normalizes HA Redis URL schemes before probing', async () => {
    const server = createServer((socket) => {
      socket.once('data', () => {
        socket.write('+PONG\r\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('server address unavailable');
    const probe = new TcpRedisProbe(`redis+sentinel://127.0.0.1:${String(address.port)}`);
    try {
      await expect(probe.ping()).resolves.toBeUndefined();
    } finally {
      await probe.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        }),
      );
    }
  });
  it('performs a Redis PING and closes the socket', async () => {
    const server = createServer((socket) => {
      socket.once('data', (data) => {
        expect(data.toString()).toContain('PING');
        socket.write('+PONG\r\n');
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        resolve();
      }),
    );
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Server did not bind');
    const probe = new TcpRedisProbe(`redis://127.0.0.1:${String(address.port)}`);

    await expect(probe.ping()).resolves.toBeUndefined();
    await probe.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  });

  it('rejects a non-Redis response', async () => {
    const server = createServer((socket) => {
      socket.once('data', () => {
        socket.write('-NOAUTH\r\n');
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        resolve();
      }),
    );
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Server did not bind');

    await expect(
      new TcpRedisProbe(`redis://127.0.0.1:${String(address.port)}`).ping(),
    ).rejects.toThrow('invalid response');
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  });
});
