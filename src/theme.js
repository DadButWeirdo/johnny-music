// The ONE place that defines how every message from johnny looks.
// Commands never build messages themselves, they call ui.success / ui.error / etc.
// Change anything here and every command follows.

export const theme = {
  // "layout" -> Components V2: one borderless sheet (default)
  // "embed"  -> classic embed
  style: process.env.EMBED_STYLE === 'embed' ? 'embed' : 'layout',

  accent: '#0A84FF',   // default colour, servers override it with the color command
  accentBar: false,     // layout only: show the coloured edge (false = fully borderless)
  container: true,     // layout only: false = no card at all, components sit directly on the chat
  banner: null,        // layout only: image URL shown on top of every message, or null
  brand: 'johnny',     // footer text
  timestamp: true,     // time in the footer

  // Per-kind look. `color` overrides the server accent (status colours).
  kinds: {
    success: { glyph: '✓' },
    error:   { glyph: '✕', color: '#FF453A' },
    notice:  { glyph: '',  color: '#FF9F0A' },
    info:    { glyph: '' },
    log:     { glyph: '' },
  },
};
