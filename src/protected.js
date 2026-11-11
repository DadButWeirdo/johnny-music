// Commands that can never be disabled or restricted, so admins can't lock themselves out.
export const PROTECTED = new Set(['help', 'command', 'prefix', 'alias', 'setup', 'look']);
