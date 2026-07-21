const DEFAULT_MAX_STDIN_BYTES = 1024 * 1024;

export async function readJsonObjectInput(stream = process.stdin, maxBytes = DEFAULT_MAX_STDIN_BYTES) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error(`hook input exceeded ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('input must be one JSON object');
  }
  return value;
}

export async function readHookInput(stream = process.stdin, maxBytes = DEFAULT_MAX_STDIN_BYTES) {
  const value = await readJsonObjectInput(stream, maxBytes);
  for (const field of ['hook_event_name', 'session_id', 'turn_id', 'cwd']) {
    if (typeof value[field] !== 'string' || !value[field]) throw new Error(`hook input is missing ${field}`);
  }
  return value;
}
