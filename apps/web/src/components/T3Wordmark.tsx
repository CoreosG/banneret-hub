import type { SVGProps } from "react";

// Banneret Hub: upstream's T3 wordmark is replaced by the pennant mark (assets/banneret/mark.svg).
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="248 116 544 740" xmlns="http://www.w3.org/2000/svg">
      <rect x="268" y="176" width="64" height="680" rx="32" fill="currentColor" />
      <circle cx="300" cy="168" r="52" fill="currentColor" />
      <path d="M332 236 H792 L660 400 L792 564 H332 Z" fill="currentColor" />
    </svg>
  );
}
