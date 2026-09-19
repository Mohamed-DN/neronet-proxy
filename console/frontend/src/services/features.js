/**
 * Optional features, as reported by the server.
 *
 * The console does not decide which features exist. It asks /api/features and shows
 * what the server says is on. A feature that is missing from the answer, or an
 * answer that never arrived, counts as off: a menu entry for something the server
 * has switched off would lead to a page whose every request is a 404.
 */

/** Reduce a /api/features response to booleans, treating anything unclear as off. */
export function parseFeatures(body) {
  return { cloud_pc: body?.cloud_pc === true };
}

/**
 * Drop menu items whose feature is off, and sections left with no items.
 * An item with no `feature` key is always shown.
 */
export function filterNavSections(sections, features) {
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => !item.feature || features?.[item.feature] === true)
    }))
    .filter((section) => section.items.length > 0);
}
