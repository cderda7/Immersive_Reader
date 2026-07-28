interface ReturnBannerProps {
  active: boolean;
  msLeft: number;
  totalMs: number;
}

export function ReturnBanner({ active, msLeft, totalMs }: ReturnBannerProps) {
  if (!active) return null;
  const pct = Math.max(0, Math.min(100, (msLeft / totalMs) * 100));
  return (
    <div className="return-banner" role="status">
      <span>Return-to mode: click any word to jump there</span>
      <div className="return-timer-track">
        <div className="return-timer-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
