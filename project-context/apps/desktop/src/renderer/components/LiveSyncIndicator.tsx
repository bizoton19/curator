import { useEffect, useRef, useState } from "react";

type LiveSyncIndicatorProps = {
  url?: string;
  enabled?: boolean;
};

export function LiveSyncIndicator({
  url = "ws://localhost:5175/ws",
  enabled = false
}: LiveSyncIndicatorProps) {
  const [status, setStatus] = useState<"connecting" | "online" | "offline">(
    "connecting"
  );
  const [lastPing, setLastPing] = useState<string>("Never");
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!enabled || !url) {
      setStatus("offline");
      return;
    }
    let cancelled = false;
    const socket = new WebSocket(url);
    socketRef.current = socket;
    setStatus("connecting");

    socket.onopen = () => {
      if (cancelled) return;
      setStatus("online");
      setLastPing(new Date().toLocaleTimeString());
    };

    socket.onmessage = () => {
      if (cancelled) return;
      setLastPing(new Date().toLocaleTimeString());
    };

    socket.onerror = () => {
      if (cancelled) return;
      setStatus("offline");
    };

    socket.onclose = () => {
      if (cancelled) return;
      setStatus("offline");
    };

    return () => {
      cancelled = true;
      socket.close();
    };
  }, [url]);

  return (
    <div className="live-sync">
      <span className={`live-dot live-dot--${status}`} />
      <div>
        <p className="live-label">
          Live sync {status === "online" ? "online" : "offline"}
        </p>
        <p className="live-sub">Last activity: {lastPing}</p>
      </div>
    </div>
  );
}
