interface EventLaneProps {
  label?: string;
  events: number[];
  duration: number;
  color: string;
  height?: number;
}

/** Vertical tick marks for discrete events (kick_hit, downbeat, drop_detected, …). */
export function EventLane({
  label,
  events,
  duration,
  color,
  height = 14,
}: EventLaneProps) {
  const inner = (
    <div
      className="w-full h-full relative bg-zinc-900/30 border-b border-zinc-900/50"
      style={{ height }}
    >
      {duration > 0 && (
        <svg
          className="absolute inset-0 w-full h-full"
          preserveAspectRatio="none"
          viewBox={`0 0 ${duration} 1`}
        >
          {events.map((t, i) => (
            <line
              key={i}
              x1={t}
              x2={t}
              y1={0.1}
              y2={0.9}
              stroke={color}
              strokeWidth={duration / 600}
            />
          ))}
        </svg>
      )}
    </div>
  );

  if (label) {
    return (
      <div className="flex items-center gap-2">
        <div className="w-20 shrink-0 text-[10px] text-zinc-500 tabular-nums truncate font-mono">
          {label}
        </div>
        <div className="flex-1 min-w-0 rounded overflow-hidden">{inner}</div>
      </div>
    );
  }

  return inner;
}
