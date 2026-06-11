export function PageHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-5">
      <h1 className="text-2xl font-semibold tracking-normal text-ink">{title}</h1>
      <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">{description}</p>
    </div>
  );
}

export function DbError({ message }: { message: string | null }) {
  if (!message) {
    return null;
  }

  return (
    <div className="mb-4 border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
      Database read failed: {message}
    </div>
  );
}

export function EmptyState({ label }: { label: string }) {
  return <div className="border border-line bg-white px-4 py-8 text-center text-sm text-muted">{label}</div>;
}

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "accepted" || status === "filled" || status === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : status === "rejected" || status === "failed" || status === "error"
        ? "border-rose-200 bg-rose-50 text-rose-800"
        : "border-slate-200 bg-slate-50 text-slate-700";

  return <span className={`inline-flex rounded border px-2 py-0.5 text-xs font-medium ${tone}`}>{status}</span>;
}
