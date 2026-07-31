export function orderSubtotal(lineItems) {
  let subtotal = 0;
  for (const item of lineItems) {
    subtotal += item.unitPriceCents * item.quantity;
  }
  return subtotal;
}

export function orderTotal(lineItems, taxRateBasisPoints) {
  const subtotal = orderSubtotal(lineItems);
  const tax = Math.round((subtotal * taxRateBasisPoints) / 10_000);
  return subtotal + tax;
}
