import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * The drawn width of an element, in CSS pixels.
 *
 * A chart whose viewBox is a fixed 600 units scales its text with the box:
 * on a 1100 px column a 10 px label becomes 18 px. Drawing in the real pixel
 * width keeps one unit equal to one pixel, so text stays the size the page
 * sets. Where nothing can be measured (a test renderer, no ResizeObserver) the
 * fallback is used.
 */
export function useMeasuredWidth<T extends Element>(fallback: number): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const read = () => {
      const measured = Math.round(node.getBoundingClientRect().width);
      if (measured > 0) setWidth(measured);
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}
