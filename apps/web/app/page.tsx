import Link from 'next/link';

// Customer-facing name (build-time inlined); "Slate" never surfaces in the UI.
const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME || 'Calendars';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col items-center justify-center gap-8 px-6 py-16 text-center">
      <div className="flex flex-col items-center gap-3">
        <span className="rounded-md bg-primary px-3 py-1 text-sm font-semibold text-primary-foreground">
          {productName}
        </span>
        <h1 className="text-4xl font-semibold tracking-tight">Open-source scheduling</h1>
        <p className="max-w-md text-muted-foreground">
          A clone-and-run booking platform. SQLite by default, deploy anywhere. This dev instance is
          seeded with a demo booking page.
        </p>
      </div>

      <Link
        href="/acme/alex-rivera"
        className="rounded-md bg-primary px-5 py-3 font-semibold text-primary-foreground transition-transform active:scale-[0.98]"
      >
        Open the demo booking page →
      </Link>

      <p className="text-sm text-muted-foreground">
        Try <code className="rounded-sm bg-muted px-1.5 py-0.5">/acme/alex-rivera/intro-call</code>
      </p>
    </main>
  );
}
