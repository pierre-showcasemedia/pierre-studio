// Inline line icons for the gallery: 16px, stroke 1.5, currentColor, so they
// sit on any pill or photo and follow its text colour.
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function DownloadIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 2.25v8" />
      <path d="M4.75 7.25 8 10.5l3.25-3.25" />
      <path d="M2.75 11.5v1.25c0 .55.45 1 1 1h8.5c.55 0 1-.45 1-1V11.5" />
    </Svg>
  );
}

// The Dropbox mark drawn as a line glyph (no brand fill), so it reads as one of
// our pills rather than a Dropbox ad.
export function DropboxIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4.75 2.5 1.75 4.5l3 2 3.25-2-3.25-2Z" />
      <path d="M11.25 2.5 8 4.5l3.25 2 3-2-3-2Z" />
      <path d="M1.75 8.5l3 2 3.25-2-3.25-2-3 2Z" />
      <path d="M14.25 8.5l-3-2L8 8.5l3.25 2 3-2Z" />
      <path d="M4.75 11.5 8 13.5l3.25-2" />
    </Svg>
  );
}

// Google Drive's triangle, drawn in the same line style as the other icons.
export function DriveIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5.6 2.25h4.8l4.1 7.1-2.4 4.15H3.9L1.5 9.35l4.1-7.1Z" />
      <path d="M5.6 2.25 9.9 9.6M10.4 2.25 6.1 9.6M1.5 9.35h13" />
    </Svg>
  );
}

export function CloseIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </Svg>
  );
}

export function ChevronLeftIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M10 3 5 8l5 5" />
    </Svg>
  );
}

export function ChevronRightIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 3l5 5-5 5" />
    </Svg>
  );
}

export function CheckIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3.25 8.25 6.5 11.5l6.25-6.5" />
    </Svg>
  );
}

export function LinkIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6.75 9.25a2.75 2.75 0 0 0 3.9 0l2-2a2.75 2.75 0 0 0-3.9-3.9l-.6.6" />
      <path d="M9.25 6.75a2.75 2.75 0 0 0-3.9 0l-2 2a2.75 2.75 0 0 0 3.9 3.9l.6-.6" />
    </Svg>
  );
}

export function PlayIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5 3.25v9.5L12.75 8 5 3.25Z" />
    </Svg>
  );
}

export function PencilIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M10.6 2.9a1.6 1.6 0 0 1 2.3 2.3L5.6 12.5l-3 .8.8-3z" />
      <path d="M9.4 4.1l2.5 2.5" />
    </Svg>
  );
}
