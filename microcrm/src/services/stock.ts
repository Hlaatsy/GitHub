import { type Prisma } from '@prisma/client';

/**
 * Puts a cancelled order's items back on the shelf. Call it only in the same
 * transaction as the conditional update that moved the order to CANCELLED, so
 * stock is returned exactly once. Products without stock tracking are skipped.
 */
export async function releaseOrderStock(db: Prisma.TransactionClient, tenantId: string, orderId: string): Promise<void> {
  const items = await db.orderItem.findMany({ where: { tenantId, orderId }, select: { productId: true, quantity: true } });
  for (const item of items) {
    await db.product.updateMany({
      where: { tenantId, id: item.productId, stockQuantity: { not: null } },
      data: { stockQuantity: { increment: item.quantity } },
    });
  }
}
