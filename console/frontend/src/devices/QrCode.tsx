import { useEffect, useState } from 'react';

import { Skeleton } from '../ui/States';

export interface QrCodeProps {
  /** The text to encode. Nothing is sent anywhere; the image is drawn in the browser. */
  value: string;
  /** Alternative text for the image, read by screen readers. */
  label: string;
  size?: number;
  /**
   * Called when the image cannot be drawn. The component renders an empty
   * box with role="alert" in that case, and the caller says what to do.
   */
  onError?: (error: unknown) => void;
}

/**
 * A QR code drawn to a PNG data URL. The `qrcode` library is loaded on first
 * use so it stays out of the entry chunk.
 */
export function QrCode({ value, label, size = 256, onError }: QrCodeProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    import('qrcode')
      .then((module) => module.default.toDataURL(value, { errorCorrectionLevel: 'M', margin: 2, width: size }))
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setFailed(true);
        onError?.(error);
      });
    return () => {
      cancelled = true;
    };
    // onError is deliberately left out: a new callback identity must not redraw the code.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, size]);

  if (failed) {
    return (
      <div role="alert" data-state="failed" style={{ width: size, height: size }} className="border border-subtle" />
    );
  }

  if (src === null) {
    return <Skeleton aria-busy="true" style={{ width: size, height: size }} className="rounded-md" />;
  }

  return <img src={src} alt={label} width={size} height={size} />;
}
