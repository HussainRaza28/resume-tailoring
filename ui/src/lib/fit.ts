/**
 * The scale that fits a page inside a box, by width and by height.
 *
 * The page is scaled by whichever ratio is smaller, so the whole page shows
 * with nothing cut off and no scrolling, whatever the box's shape.
 */
export function fitScale(page: { width: number; height: number }, box: { width: number; height: number }): number {
  if (page.width <= 0 || page.height <= 0 || box.width <= 0 || box.height <= 0) return 0;
  return Math.min(box.width / page.width, box.height / page.height);
}
