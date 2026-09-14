import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-xl px-6 py-24">
      <p className="font-mono text-xs tracking-[0.2em] text-muted uppercase">404</p>
      <h1 className="mt-4 text-3xl">That page is not on the desk.</h1>
      <p className="mt-3 text-muted">
        Return to the purchasing queue and pick a live recommendation.
      </p>
      <Link className="mt-8 inline-block border-b border-ink pb-0.5" href="/">
        Back to queue
      </Link>
    </main>
  );
}
