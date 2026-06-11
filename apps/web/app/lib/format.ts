export function asNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function") {
    return value.toNumber();
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatPrice(value: unknown): string {
  const number = asNumber(value);
  return number === null ? "N/A" : number.toFixed(4);
}

export function formatContracts(value: unknown): string {
  const number = asNumber(value);
  return number === null ? "0" : number.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) {
    return "N/A";
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "N/A" : date.toLocaleString();
}

export function formatIsoDate(value: Date | string | null | undefined): string {
  if (!value) {
    return "N/A";
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "N/A" : date.toISOString();
}

export function formatSimulatedPnl(value: unknown): string {
  const number = asNumber(value) ?? 0;
  return number.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 4,
    maximumFractionDigits: 4
  });
}
