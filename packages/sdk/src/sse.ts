/** A single parsed Server-Sent Events event. */
export interface SseEvent {
  readonly event: string;
  readonly data: string;
  readonly id?: string;
}

/**
 * Parses a byte stream of `text/event-stream` content into discrete events.
 * Handles CRLF/LF line endings, comments, multi-line `data` fields and a final
 * unterminated event, while never buffering unbounded content in memory.
 */
export async function* parseSse(chunks: AsyncIterable<Uint8Array>): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      yield parseEventBlock(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim() !== '') yield parseEventBlock(buffer);
}

function parseEventBlock(block: string): SseEvent {
  let event = 'message';
  let data = '';
  let id: string | undefined;
  for (const line of block.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const rawValue = colon === -1 ? '' : line.slice(colon + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    if (field === 'event') event = value;
    else if (field === 'data') data = data === '' ? value : `${data}\n${value}`;
    else if (field === 'id') id = value;
  }
  return { event, data, ...(id === undefined ? {} : { id }) };
}
