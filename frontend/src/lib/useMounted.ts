"use client";

import { useEffect, useState } from "react";

/**
 * True only after the first client render.
 *
 * wagmi restores a previously connected wallet on the client, so any branch on
 * `isConnected` / `address` renders one tree during SSR and a different one on
 * hydration — React throws "Hydration failed" and discards the subtree. Gate
 * those branches on this so the server output and the first client render agree,
 * then let the connected view swap in on the following paint.
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
