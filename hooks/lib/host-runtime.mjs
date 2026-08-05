/**
 * Resolve host-specific plugin paths without inventing state inside the
 * reviewed repository.
 *
 * Codex exports PLUGIN_ROOT / PLUGIN_DATA.
 * Claude Code exports CLAUDE_PLUGIN_ROOT / CLAUDE_PLUGIN_DATA (see
 * https://code.claude.com/docs/en/hooks and plugins reference).
 */

export function resolvePluginRoot(env = process.env) {
  for (const key of ['PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT']) {
    const value = env[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

export function resolveRuntimeDataDir(env = process.env) {
  for (const key of ['PLUGIN_DATA', 'CLAUDE_PLUGIN_DATA']) {
    const value = env[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

export function detectHostKind(env = process.env, rawInput = null) {
  if (typeof env.CLAUDE_PLUGIN_ROOT === 'string' && env.CLAUDE_PLUGIN_ROOT.trim()) {
    return 'claude';
  }
  if (typeof env.PLUGIN_ROOT === 'string' && env.PLUGIN_ROOT.trim()) {
    return 'codex';
  }
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    if (typeof rawInput.prompt_id === 'string' && rawInput.prompt_id
        && (rawInput.turn_id === undefined || rawInput.turn_id === null || rawInput.turn_id === '')) {
      return 'claude';
    }
  }
  return 'unknown';
}
