export function formatCents(cents) {
  const dollars = Math.trunc(cents / 100);
  const remainder = Math.abs(cents % 100);
  return `$${dollars}.${String(remainder).padStart(2, '0')}`;
}
