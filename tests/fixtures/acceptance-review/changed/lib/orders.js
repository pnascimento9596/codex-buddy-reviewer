export function orderSubtotal(lineItems) {
  let subtotal = 0;
  for (const item of lineItems) {
    subtotal += item.unitPriceCents * item.quantity;
  }
  return subtotal;
}

export function applyDiscount(subtotalCents, discountBasisPoints) {
  const discount = Math.round((subtotalCents * discountBasisPoints) / 10_000);
  return subtotalCents + discount;
}

export function orderTotal(lineItems, taxRateBasisPoints, discountBasisPoints = 0) {
  const subtotal = applyDiscount(orderSubtotal(lineItems), discountBasisPoints);
  const tax = Math.round((subtotal * taxRateBasisPoints) / 10_000);
  return subtotal + tax;
}
