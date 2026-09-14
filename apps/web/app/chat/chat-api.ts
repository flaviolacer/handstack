export interface ChatSession {
  readonly organizationId: string;
  readonly accessToken: string;
}

export interface ChatPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}
export interface Conversation {
  readonly id: string;
  readonly title: string;
  readonly activeBranchId: string;
  readonly status: string;
  readonly updatedAt: string;
}
export interface MessagePart {
  readonly id: string;
  readonly type: string;
  readonly text?: string;
  readonly uri?: string;
  readonly mimeType?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}
export interface Message {
  readonly id: string;
  readonly conversationId: string;
  readonly branchId: string;
  readonly sequence: number;
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly parts: readonly MessagePart[];
  readonly status: string;
  readonly modelDefinitionId?: string;
  readonly providerId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}
export interface Attachment {
  readonly id: string;
  readonly originalName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly status: string;
}
export interface PublicModel {
  readonly id: string;
  readonly displayName: string;
  readonly providerModel: string;
  readonly lifecycle: string;
  readonly capabilities: readonly string[];
}
export interface StreamEvent {
  readonly sequence: number;
  readonly type: string;
  readonly part?: MessagePart;
  readonly errorCode?: string;
}

export class ChatApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ChatApiError';
  }
}

function key(): string {
  return globalThis.crypto.randomUUID();
}

export function chatApi(session: ChatSession, baseUrl = '') {
  const root = `${baseUrl}/api/v1/organizations/${encodeURIComponent(session.organizationId)}`;
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${session.accessToken}`);
    if (init?.body !== undefined && !(init.body instanceof FormData))
      headers.set('content-type', 'application/json');
    const response = await fetch(`${root}${path}`, { ...init, cache: 'no-store', headers });
    if (!response.ok) {
      const problem = (await response.json().catch(() => undefined)) as
        { detail?: string; title?: string } | undefined;
      throw new ChatApiError(
        response.status,
        problem?.detail ?? problem?.title ?? 'Chat request failed',
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
  const conversation = (id: string) => `/conversations/${encodeURIComponent(id)}`;
  return {
    models: () => request<ChatPage<PublicModel>>('/chat/models'),
    conversations: (cursor?: string) =>
      request<ChatPage<Conversation>>(
        `/conversations?limit=30${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
      ),
    createConversation: (title: string) =>
      request<Conversation>('/conversations', { method: 'POST', body: JSON.stringify({ title }) }),
    archiveConversation: (conversationId: string) =>
      request<Conversation>(`${conversation(conversationId)}/archive`, { method: 'PATCH' }),
    restoreConversation: (conversationId: string) =>
      request<Conversation>(`${conversation(conversationId)}/restore`, { method: 'PATCH' }),
    deleteConversation: (conversationId: string) =>
      request<Conversation>(conversation(conversationId), { method: 'DELETE' }),
    history: (conversationId: string, branchId: string, cursor?: string) =>
      request<ChatPage<Message>>(
        `${conversation(conversationId)}/branches/${encodeURIComponent(branchId)}/messages?limit=50${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
      ),
    append: (conversationId: string, branchId: string, parts: readonly MessagePart[]) =>
      request<Message>(
        `${conversation(conversationId)}/branches/${encodeURIComponent(branchId)}/messages`,
        { method: 'POST', body: JSON.stringify({ role: 'user', parts }) },
      ),
    execute: (conversationId: string, branchId: string, model: string, parentMessageId: string) =>
      request<Message>(
        `${conversation(conversationId)}/branches/${encodeURIComponent(branchId)}/executions`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': key() },
          body: JSON.stringify({ model, dataClassification: 'INTERNAL', parentMessageId }),
        },
      ),
    cancel: (messageId: string) =>
      request<StreamEvent>(`/messages/${encodeURIComponent(messageId)}/cancel`, {
        method: 'POST',
        headers: { 'Idempotency-Key': key() },
      }),
    upload: (conversationId: string, file: File) => {
      const body = new FormData();
      body.set('file', file);
      return request<Attachment>(
        `${conversation(conversationId)}/attachments?dataClassification=INTERNAL`,
        { method: 'POST', body },
      );
    },
    edit: (conversationId: string, messageId: string, text: string) =>
      request<{ branch: { id: string }; message: Message }>(
        `${conversation(conversationId)}/messages/${encodeURIComponent(messageId)}/edit`,
        { method: 'POST', body: JSON.stringify({ parts: [{ id: key(), type: 'text', text }] }) },
      ),
    regenerate: (conversationId: string, messageId: string, model?: string) =>
      request<{ branch: { id: string }; message: Message }>(
        `${conversation(conversationId)}/messages/${encodeURIComponent(messageId)}/regenerate`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': key() },
          body: JSON.stringify({
            ...(model === undefined ? {} : { model }),
            dataClassification: 'INTERNAL',
          }),
        },
      ),
    retry: (conversationId: string, messageId: string) =>
      request<{ branch: { id: string }; message: Message }>(
        `${conversation(conversationId)}/messages/${encodeURIComponent(messageId)}/retry`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': key() },
          body: JSON.stringify({ dataClassification: 'INTERNAL' }),
        },
      ),
    stream: (messageId: string, after: number, signal: AbortSignal) =>
      streamEvents(
        `${root}/messages/${encodeURIComponent(messageId)}/events`,
        session.accessToken,
        after,
        signal,
      ),
  };
}

export async function* streamEvents(
  url: string,
  token: string,
  after: number,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  let cursor = after;
  for (let attempt = 0; attempt < 5 && !signal.aborted; attempt += 1) {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, 'Last-Event-ID': String(cursor) },
      cache: 'no-store',
      signal,
    });
    if (!response.ok || response.body === null)
      throw new ChatApiError(response.status, 'Unable to connect to the chat stream');
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          if (frame.startsWith(':')) continue;
          const data = frame
            .split(/\r?\n/)
            .find((line) => line.startsWith('data: '))
            ?.slice(6);
          if (data === undefined) continue;
          const event = JSON.parse(data) as StreamEvent;
          if (event.sequence <= cursor) continue;
          cursor = event.sequence;
          yield event;
          if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(event.type)) return;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (!signal.aborted) throw new ChatApiError(0, 'Chat stream disconnected repeatedly');
}
