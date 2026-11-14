/** One outline icon set, 16px, 1.5px stroke. Decorative unless given a title. */
import type { ReactNode } from "react";

function Icon({ children, size = 16, title }: { children: ReactNode; size?: number; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  );
}

type P = { size?: number; title?: string };

export const IconSpark = (p: P) => (
  <Icon {...p}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />
  </Icon>
);
export const IconBriefcase = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="7" width="18" height="13" rx="2.5" />
    <path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7M3 12.5h18" />
  </Icon>
);
export const IconFacts = (p: P) => (
  <Icon {...p}>
    <path d="M5 4h10l4 4v12H5z" />
    <path d="M15 4v4h4M8.5 12.5h7M8.5 16h5" />
  </Icon>
);
export const IconSettings = (p: P) => (
  <Icon {...p}>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </Icon>
);
export const IconSearch = (p: P) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4 4" />
  </Icon>
);
export const IconSidebar = (p: P) => (
  <Icon {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <path d="M9.5 4.5v15" />
  </Icon>
);
export const IconCheck = (p: P) => (
  <Icon {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);
export const IconX = (p: P) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);
export const IconEdit = (p: P) => (
  <Icon {...p}>
    <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z" />
  </Icon>
);
export const IconCopy = (p: P) => (
  <Icon {...p}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
    <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
  </Icon>
);
export const IconUndo = (p: P) => (
  <Icon {...p}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Icon>
);
export const IconDownload = (p: P) => (
  <Icon {...p}>
    <path d="M12 4v11M7 10.5 12 15.5 17 10.5M5 20h14" />
  </Icon>
);
export const IconFolder = (p: P) => (
  <Icon {...p}>
    <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6l2 2.2h7.4a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  </Icon>
);
export const IconTrash = (p: P) => (
  <Icon {...p}>
    <path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13" />
  </Icon>
);
export const IconPlus = (p: P) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
export const IconTheme = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor" stroke="none" />
  </Icon>
);
export const IconChevron = (p: P) => (
  <Icon {...p}>
    <path d="m8 10 4 4 4-4" />
  </Icon>
);
export const IconTimer = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="13" r="7.5" />
    <path d="M12 9v4l2.5 2M10 2.5h4" />
  </Icon>
);

/** The product mark: a threaded needle, drawn for Tailor (same drawing as the app icon). */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="64 64 896 896" aria-hidden="true">
      <rect x="64" y="64" width="896" height="896" rx="208" fill="#141312" stroke="#34312d" strokeWidth="16" />
      <path d="M676 348 C 792 300, 800 470, 700 560 C 600 650, 420 610, 380 700 C 350 768, 420 800, 470 772" stroke="#c6f24e" strokeWidth="56" strokeLinecap="round" fill="none" />
      <path d="M292 732 L716 308" stroke="#f4f4f2" strokeWidth="72" strokeLinecap="round" />
      <ellipse cx="672" cy="352" rx="15" ry="34" transform="rotate(45 672 352)" fill="#141312" />
    </svg>
  );
}
export const IconJobs = (p: P) => (
  <Icon {...p}>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="m15 15 5 5M8 10.5h5M10.5 8v5" />
  </Icon>
);
export const IconRefresh = (p: P) => (
  <Icon {...p}>
    <path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4" />
  </Icon>
);
export const IconExternal = (p: P) => (
  <Icon {...p}>
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Icon>
);
