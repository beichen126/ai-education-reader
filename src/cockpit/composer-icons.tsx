// Product-level composer icons (kept out of src/dsh which stays upstream/migration).
import type { SVGProps } from 'react'

/** Image / photo icon: picture frame + mountains + sun. */
export function IconPhoto16(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} fill="currentColor" aria-hidden="true" {...props}>
      <path d="M2 2.5A1.5 1.5 0 0 1 3.5 1h9A1.5 1.5 0 0 1 14 2.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-9zM3.5 2a.5.5 0 0 0-.5.5v9c0 .28.22.5.5.5h9a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-9z" />
      <circle cx="10.6" cy="5.1" r="1.15" />
      <path d="M3.4 10.9l3.1-3.6a.7.7 0 0 1 1.05 0l1.2 1.4 1.2-1.4a.7.7 0 0 1 1.05 0l1.6 1.9v-1.1H3.4v2.8z" opacity=".9" />
    </svg>
  )
}

/** Document / PDF icon: page with folded corner + text lines. */
export function IconDocument16(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} fill="currentColor" aria-hidden="true" {...props}>
      <path d="M11.5 1H4.5A1.5 1.5 0 0 0 3 2.5v11A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-9L11.5 1zM4.5 2h6V5h3v8.5a.5.5 0 0 1-.5.5h-8.5a.5.5 0 0 1-.5-.5v-11c0-.28.22-.5.5-.5zM10 2.4L11.6 4H10V2.4z" />
      <path d="M5.5 7h5v1.1h-5V7zm0 2.4h5v1.1h-5V9.4z" />
    </svg>
  )
}
