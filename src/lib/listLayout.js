// listLayout - pure geometry for BookList's manual virtualization.
//
// L7: an expanded row renders its file list below the fixed collapsed row, so
// the total scroll height and the translate offset must account for that extra
// height or the last rows get clipped / overlap. With single-row expansion
// (enforced by the parent) the extra is bounded to one row.

export function computeListMetrics(
  filteredGroups = [],
  expandedGroups = new Set(),
  visibleStart = 0,
  { rowHeight = 80, fileRowHeight = 37 } = {}
) {
  let totalHeight = filteredGroups.length * rowHeight;
  let offsetExtra = 0;

  filteredGroups.forEach((g, i) => {
    if (expandedGroups.has && expandedGroups.has(g.id)) {
      const extra = (g.files?.length || 0) * fileRowHeight;
      totalHeight += extra;
      // Rows above the visible window push the rendered block down.
      if (i < visibleStart) offsetExtra += extra;
    }
  });

  return {
    totalHeight,
    offsetY: visibleStart * rowHeight + offsetExtra,
  };
}
