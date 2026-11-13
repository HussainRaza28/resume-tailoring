/**
 * Collapsing sidebar.
 * Rebuilt from the public listing of the bencho.dev "Collapsing sidebar" block (a
 * press interaction). Not the original source; swap for the original when
 * available (see src/blocks/SOURCE.md).
 *
 * Collapses to an icon rail; labels and lists hide, icons keep tooltips and
 * accessible names. The state is remembered.
 */
import { type ReactNode, useEffect, useState } from "react";

export function useCollapsed(key = "sidebar-collapsed"): [boolean, (v: boolean | ((x: boolean) => boolean)) => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, collapsed ? "1" : "0");
    } catch {
      /* in-memory only */
    }
  }, [collapsed, key]);
  return [collapsed, setCollapsed];
}

export default function CollapsingSidebar({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
  return (
    <aside className="sidebar" data-collapsed={collapsed} aria-label="Sidebar">
      {children}
    </aside>
  );
}
