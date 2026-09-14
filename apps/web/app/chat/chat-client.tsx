'use client';

import { useCallback, useRef, useState, type SyntheticEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  chatApi,
  type ChatSession,
  type Conversation,
  type Message,
  type MessagePart,
  type PublicModel,
} from './chat-api';

const textOf = (message: Message) =>
  message.parts
    .filter((part) => part.type === 'text' || part.type === 'reasoning')
    .map((part) => part.text ?? '')
    .join('');
const field = (data: FormData, name: string) => {
  const value = data.get(name);
  return typeof value === 'string' ? value.trim() : '';
};
const partId = () => globalThis.crypto.randomUUID();

export function ChatClient() {
  const [session, setSession] = useState<ChatSession>();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [active, setActive] = useState<Conversation>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [models, setModels] = useState<PublicModel[]>([]);
  const [model, setModel] = useState('');
  const [status, setStatus] = useState<'signed-out' | 'loading' | 'ready' | 'streaming' | 'error'>(
    'signed-out',
  );
  const [error, setError] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const streamAbort = useRef<AbortController | undefined>(undefined);
  const baseUrl = process.env.NEXT_PUBLIC_HANDSTACK_API_URL ?? '';

  const loadConversations = useCallback(
    async (current: ChatSession, cursor?: string) => {
      const page = await chatApi(current, baseUrl).conversations(cursor);
      setConversations((existing) =>
        cursor === undefined ? [...page.items] : [...existing, ...page.items],
      );
      setNextCursor(page.nextCursor);
    },
    [baseUrl],
  );

  async function connect(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const current = {
      organizationId: field(data, 'organizationId'),
      accessToken: field(data, 'accessToken'),
    };
    setSession(current);
    setStatus('loading');
    setError('');
    event.currentTarget.reset();
    try {
      const api = chatApi(current, baseUrl);
      const [conversationPage, modelPage] = await Promise.all([api.conversations(), api.models()]);
      const available = modelPage.items.filter((item) => item.lifecycle === 'PUBLISHED');
      setConversations([...conversationPage.items]);
      setNextCursor(conversationPage.nextCursor);
      setModels(available);
      setModel(available[0]?.id ?? '');
      setStatus('ready');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load chat');
      setStatus('error');
    }
  }

  async function open(item: Conversation, branchId = item.activeBranchId) {
    if (session === undefined) return;
    setStatus('loading');
    try {
      const page = await chatApi(session, baseUrl).history(item.id, branchId);
      setActive({ ...item, activeBranchId: branchId });
      setMessages([...page.items]);
      setStatus('ready');
    } catch (cause) {
      fail(cause);
    }
  }

  async function create() {
    if (session === undefined) return;
    try {
      const item = await chatApi(session, baseUrl).createConversation('New conversation');
      setConversations((items) => [item, ...items]);
      setActive(item);
      setMessages([]);
    } catch (cause) {
      fail(cause);
    }
  }

  async function changeConversationStatus(
    item: Conversation,
    operation: 'archive' | 'restore' | 'delete',
  ) {
    if (session === undefined) return;
    if (operation === 'delete' && !window.confirm('Delete this conversation and its content?'))
      return;
    try {
      const api = chatApi(session, baseUrl);
      const updated =
        operation === 'archive'
          ? await api.archiveConversation(item.id)
          : operation === 'restore'
            ? await api.restoreConversation(item.id)
            : await api.deleteConversation(item.id);
      if (operation === 'delete') {
        setConversations((current) => current.filter(({ id }) => id !== item.id));
        if (active?.id === item.id) {
          setActive(undefined);
          setMessages([]);
        }
      } else {
        setConversations((current) =>
          current.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
        );
        if (active?.id === item.id) setActive(updated);
      }
    } catch (cause) {
      fail(cause);
    }
  }

  async function send(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (session === undefined || active === undefined || model === '') return;
    const form = event.currentTarget;
    const prompt = field(new FormData(form), 'prompt');
    if (prompt === '' && files.length === 0) return;
    setStatus('streaming');
    setError('');
    try {
      const api = chatApi(session, baseUrl);
      const parts: MessagePart[] = [];
      if (prompt !== '') parts.push({ id: partId(), type: 'text', text: prompt });
      for (const file of files) {
        const attachment = await api.upload(active.id, file);
        parts.push({
          id: partId(),
          type: file.type.startsWith('image/')
            ? 'image'
            : file.type.startsWith('audio/')
              ? 'audio'
              : 'file',
          mimeType: file.type,
          uri: `attachment://${attachment.id}`,
        });
      }
      const user = await api.append(active.id, active.activeBranchId, parts);
      setMessages((items) => [...items, user]);
      form.reset();
      setFiles([]);
      const assistant = await api.execute(active.id, active.activeBranchId, model, user.id);
      setMessages((items) => [...items, assistant]);
      await follow(assistant, api);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) fail(cause);
    }
  }

  async function follow(assistant: Message, api: ReturnType<typeof chatApi>) {
    const controller = new AbortController();
    streamAbort.current = controller;
    let current = assistant;
    for await (const event of api.stream(assistant.id, 0, controller.signal)) {
      if (event.part !== undefined) current = { ...current, parts: [...current.parts, event.part] };
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(event.type))
        current = { ...current, status: event.type };
      setMessages((items) => items.map((item) => (item.id === current.id ? current : item)));
    }
    setStatus('ready');
  }

  async function cancel() {
    if (session === undefined) return;
    const pending = messages.findLast((item) => item.status === 'STREAMING');
    if (pending !== undefined) await chatApi(session, baseUrl).cancel(pending.id);
    if (streamAbort.current !== undefined) streamAbort.current.abort();
    setStatus('ready');
  }
  async function revise(message: Message, operation: 'edit' | 'regenerate' | 'retry') {
    if (session === undefined || active === undefined) return;
    try {
      const api = chatApi(session, baseUrl);
      let result;
      if (operation === 'edit') {
        const value = window.prompt('Edit message', textOf(message));
        if (value === null || value.trim() === '') return;
        result = await api.edit(active.id, message.id, value.trim());
      } else if (operation === 'regenerate')
        result = await api.regenerate(active.id, message.id, model || undefined);
      else result = await api.retry(active.id, message.id);
      await open(active, result.branch.id);
      if (operation !== 'edit') {
        setStatus('streaming');
        setMessages((items) =>
          items.some((item) => item.id === result.message.id) ? items : [...items, result.message],
        );
        await follow(result.message, api);
      }
    } catch (cause) {
      fail(cause);
    }
  }
  function fail(cause: unknown) {
    setError(cause instanceof Error ? cause.message : 'Chat operation failed');
    setStatus('error');
  }

  if (status === 'signed-out')
    return (
      <section className="panel chat-connect">
        <h1>Chat workspace</h1>
        <p className="muted">Connect a session. Credentials remain only in memory.</p>
        <form className="form-grid" onSubmit={(event) => void connect(event)}>
          <label>
            Organization ID
            <input name="organizationId" required />
          </label>
          <label>
            Bearer access token
            <input name="accessToken" type="password" required />
          </label>
          <button className="primary-button">Open workspace</button>
        </form>
      </section>
    );
  return (
    <div className="chat-workspace" aria-busy={status === 'loading'}>
      <h1 className="sr-only">Chat workspace</h1>
      <aside className="conversation-list" aria-label="Conversation navigation">
        <button className="primary-button" onClick={() => void create()}>
          + New chat
        </button>
        <h2>Conversations</h2>
        {conversations.length === 0 && <p className="muted">No conversations yet.</p>}
        {conversations.map((item) => (
          <div className="conversation-item" key={item.id}>
            <button
              className={item.id === active?.id ? 'active' : ''}
              disabled={item.status === 'ARCHIVED'}
              onClick={() => void open(item)}
            >
              {item.title}
              {item.status === 'ARCHIVED' ? ' (archived)' : ''}
            </button>
            <div className="conversation-actions">
              <button
                onClick={() =>
                  void changeConversationStatus(
                    item,
                    item.status === 'ARCHIVED' ? 'restore' : 'archive',
                  )
                }
              >
                {item.status === 'ARCHIVED' ? 'Restore' : 'Archive'}
              </button>
              <button onClick={() => void changeConversationStatus(item, 'delete')}>Delete</button>
            </div>
          </div>
        ))}
        {nextCursor !== undefined && session !== undefined && (
          <button onClick={() => void loadConversations(session, nextCursor)}>Load more</button>
        )}
      </aside>
      <section className="conversation" aria-live="polite">
        <header className="chat-topbar">
          <div>
            <strong>{active?.title ?? 'New chat'}</strong>
            <span className="muted"> · Knowledge · Tools</span>
          </div>
          <label>
            Model{' '}
            <select
              value={model}
              onChange={(event) => {
                setModel(event.target.value);
              }}
              disabled={status === 'streaming'}
            >
              <option value="">Select model</option>
              {models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.displayName}
                </option>
              ))}
            </select>
          </label>
        </header>
        {error !== '' && (
          <div className="panel error-panel" role="alert">
            {error}
            <button
              onClick={() => {
                setStatus('ready');
              }}
            >
              Dismiss
            </button>
          </div>
        )}
        <div className="message-list">
          {active === undefined ? (
            <div className="empty-state">
              <h1>What would you like to build?</h1>
              <button className="primary-button" onClick={() => void create()}>
                Start a conversation
              </button>
            </div>
          ) : (
            messages.map((message) => (
              <article className={`chat-message ${message.role}`} key={message.id}>
                <header>
                  <strong>{message.role === 'assistant' ? 'HandStack' : 'You'}</strong>
                  <span className="badge">{message.status}</span>
                </header>
                {message.parts.map((part) =>
                  part.text !== undefined ? (
                    <ReactMarkdown key={part.id}>{part.text}</ReactMarkdown>
                  ) : (
                    <p key={part.id} className="attachment-chip">
                      {part.type}: {part.uri}
                    </p>
                  ),
                )}
                <footer>
                  {message.role === 'user' && (
                    <button onClick={() => void revise(message, 'edit')}>Edit</button>
                  )}
                  {message.role === 'assistant' && (
                    <button onClick={() => void revise(message, 'regenerate')}>Regenerate</button>
                  )}
                  {message.role === 'assistant' &&
                    ['FAILED', 'CANCELLED'].includes(message.status) && (
                      <button onClick={() => void revise(message, 'retry')}>Retry</button>
                    )}
                </footer>
              </article>
            ))
          )}
        </div>
        {active !== undefined && (
          <form className="composer" onSubmit={(event) => void send(event)}>
            <label className="sr-only" htmlFor="prompt">
              Message
            </label>
            <textarea
              id="prompt"
              name="prompt"
              rows={3}
              placeholder="Message HandStack…"
              disabled={status === 'streaming'}
            />
            <div className="composer-actions">
              <label className="secondary-button">
                Attach
                <input
                  type="file"
                  multiple
                  accept="image/png,image/jpeg,image/webp,audio/mpeg,audio/wav,application/pdf,text/plain,text/markdown"
                  onChange={(event) => {
                    setFiles(event.target.files === null ? [] : Array.from(event.target.files));
                  }}
                />
              </label>
              <span className="muted">
                {files.length === 0 ? 'No files' : `${String(files.length)} selected`}
              </span>
              {status === 'streaming' ? (
                <button type="button" className="danger-button" onClick={() => void cancel()}>
                  Stop
                </button>
              ) : (
                <button className="primary-button" disabled={model === ''}>
                  Send
                </button>
              )}
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
