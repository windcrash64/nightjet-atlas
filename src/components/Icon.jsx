export default function Icon({ name, size = 20, ...props }) {
  const paths = {
    plane: <path d="m22 2-7 20-4-9-9-4 20-7ZM11 13 22 2" />,
    train: (
      <>
        <rect x="5" y="3" width="14" height="15" rx="4" />
        <path d="M5 10h14M9 3v7M15 3v7M8 21l2-3m6 3-2-3M8 14h1m6 0h1" />
      </>
    ),
    bus: (
      <>
        <rect x="4" y="3" width="16" height="16" rx="3" />
        <path d="M4 11h16M8 6h8M7 19v2m10-2v2M7 15h1m8 0h1" />
      </>
    ),
    globe: (
      <>
        <circle cx="12" cy="12" r="9" />
        <ellipse cx="12" cy="12" rx="4" ry="9" />
        <path d="M3 12h18M5 6h14M5 18h14" />
      </>
    ),
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    external: (
      <>
        <path d="M14 3h7v7m0-7-11 11" />
        <path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" />
      </>
    ),
    swap: <path d="M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4" />,
    pin: (
      <>
        <path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" />
        <circle cx="12" cy="10" r="2" />
      </>
    ),
    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="3" />
        <path d="M7 3v4m10-4v4M3 11h18" />
      </>
    ),
    chevron: <path d="m8 5 7 7-7 7" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    heart: (
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" />
    ),
    wallet: (
      <>
        <path d="M20 8V5a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15v12H5a3 3 0 0 1-3-3V6" />
        <path d="M20 12h-5v5h5" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    bag: (
      <>
        <rect x="5" y="6" width="14" height="15" rx="3" />
        <path d="M9 6V4a3 3 0 0 1 6 0v2M9 11v5m6-5v5" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    compass: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m16 8-3 5-5 3 3-5 5-3Z" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6m0-10v1" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name] || paths.pin}
    </svg>
  );
}
