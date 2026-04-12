import { useEffect, useRef } from "react";
import { usePlayback } from "@/store/playback";

interface PlayheadCursorProps {
  pxPerSecond: number;
}

export function PlayheadCursor({ pxPerSecond }: PlayheadCursorProps) {
  const lineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = lineRef.current;
      if (el) {
        const t = usePlayback.getState().currentTime;
        el.style.transform = `translateX(${t * pxPerSecond}px)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pxPerSecond]);

  return (
    <div
      ref={lineRef}
      className="absolute top-0 bottom-0 w-0.5 bg-accent-hot pointer-events-none z-50"
      style={{ left: 0 }}
    />
  );
}
