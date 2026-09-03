'use client';

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-[#18181b] antialiased">
        <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-[#6f6f78]">
            Something broke
          </p>
          <h1 className="mt-3 text-3xl font-semibold">Nukkad could not load this screen.</h1>
          <p className="mt-3 text-sm leading-relaxed text-[#6f6f78]">
            Try once more. If it repeats, the server logs will have the exact route.
          </p>
          <button
            onClick={reset}
            className="mt-6 w-fit rounded-lg bg-[#4f46e5] px-4 py-2 text-sm font-semibold text-white"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
