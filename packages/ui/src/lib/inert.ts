/**
 * React 18 has no typed `inert` prop and drops boolean `true` for unknown
 * attributes, so the attribute is spread as an empty string when active.
 */
export function inertProps(active: boolean): object {
  return active ? { inert: '' } : {};
}
