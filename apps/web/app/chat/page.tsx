import Link from 'next/link';
import { ChatClient } from './chat-client';

export default function ChatPage() {
  return (
    <div className="chat-shell">
      <aside className="chat-sidebar" aria-label="Workspace navigation">
        <div className="brand">HandStack</div>
        <nav aria-label="Chat navigation">
          <Link href="/chat" aria-current="page">
            New Chat
          </Link>
          <span>Conversations</span>
          <span aria-disabled="true">Agents</span>
          <span aria-disabled="true">Saved Prompts</span>
        </nav>
        <Link className="context-help" href="/help/user/chat-workspace">
          ? Chat guide
        </Link>
      </aside>
      <main className="chat-main">
        <ChatClient />
      </main>
    </div>
  );
}
