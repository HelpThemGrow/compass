"use client";

import * as React from "react";

/** Whole seconds since `running` became true (0 when idle). */
export function useElapsed(running: boolean): number {
  const [seconds, setSeconds] = React.useState(0);
  React.useEffect(() => {
    if (!running) return;
    setSeconds(0);
    const start = Date.now();
    const t = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, [running]);
  return running ? seconds : 0;
}
