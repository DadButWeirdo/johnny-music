const BUTTON_STYLES = {
  primary: 1,
  secondary: 2,
  success: 3,
  danger: 4,
  link: 5,
};

/** Convert Johnny's compact UI component objects into baff.gg's Discord-shaped payloads. */
export function toBaffComponent(component) {
  if (Array.isArray(component)) return component.map(toBaffComponent);
  if (!component || typeof component !== 'object') return component;

  const kind = typeof component.type === 'string' ? component.type.toLowerCase() : component.type;
  if (kind === 'row' || kind === 'actionrow' || kind === 'action_row') {
    return {
      ...component,
      type: 1,
      components: (component.components ?? []).map(toBaffComponent),
    };
  }

  if (kind === 'button') {
    const styleName = typeof component.style === 'string' ? component.style.toLowerCase() : component.style;
    const button = {
      ...component,
      type: 2,
      style: BUTTON_STYLES[styleName] ?? styleName ?? 2,
    };
    if (button.customId && !button.custom_id) button.custom_id = button.customId;
    delete button.customId;
    delete button.kind;
    return button;
  }

  // V2 containers, sections and nested text/media components already use baff.gg's
  // numeric type codes. Only recurse into component-bearing properties.
  const converted = { ...component };
  if (Array.isArray(component.components)) converted.components = component.components.map(toBaffComponent);
  if (component.accessory && typeof component.accessory === 'object') converted.accessory = toBaffComponent(component.accessory);
  if (Array.isArray(component.items)) {
    converted.items = component.items.map((item) => ({
      ...item,
      ...(item?.components ? { components: item.components.map(toBaffComponent) } : {}),
    }));
  }
  return converted;
}

export const toBaffComponents = (components) => Array.isArray(components) ? components.map(toBaffComponent) : components;
