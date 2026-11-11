import { withStore } from './store.js';

// Bind event and command callbacks to their platform's data namespace.
// This prevents Baff and Yaper events/timers from reading each other's server data.
export function scopeBot(bot, scope) {
  if (bot.__platformScope === scope) return bot;
  const originalOn = bot.on?.bind(bot);
  if (originalOn) {
    bot.on = (event, handler) => originalOn(event, (...args) => withStore(scope, () => handler(...args)));
  }
  const originalCommand = bot.command?.bind(bot);
  if (originalCommand) {
    bot.command = (name, description, handler) => originalCommand(name, description,
      (...args) => withStore(scope, () => handler(...args)));
  }
  const originalOnButton = bot.onButton?.bind(bot);
  if (originalOnButton) {
    bot.onButton = (pattern, handler) => originalOnButton(pattern,
      (...args) => withStore(scope, () => handler(...args)));
  }
  Object.defineProperty(bot, '__platformScope', { value: scope, configurable: false });
  return bot;
}
