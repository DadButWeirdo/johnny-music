// Johnny Music shares the main Johnny bot's token but must NEVER touch its slash commands.
// Yaper's SDK sends the full command list (PUT /commands) every time it starts, even an empty one,
// which would wipe the main bot's commands. This makes that one call a harmless no-op.
export function blockCommandSync(bot) {
  const realApi = bot.api.bind(bot);
  bot.api = (method, path, ...rest) => {
    if (String(method).toUpperCase() === 'PUT' && /^\/commands\/?$/.test(String(path))) return Promise.resolve({});
    return realApi(method, path, ...rest);
  };
  return bot;
}
