/**
 * How a queued write reaches the server — as an interface, and only that.
 *
 * There is no HTTP client here, and that is deliberate. A queue does not need
 * to know how a request is made; it needs to know whether one worked. Writing
 * the client now would mean choosing a transport, a timeout policy and a
 * credential source on behalf of adapters that do not exist yet, and every one
 * of those is an installation decision belonging to whoever ships the adapter.
 *
 * What crosses this boundary is deliberately narrow in both directions.
 *
 * Inward: the item and the owner the caller is acting as. No credential. The
 * implementation holds its own — it is the thing making the request, and it
 * knows how to authenticate one — so the queue never sees a token and cannot
 * write one to a file.
 *
 * Outward: a closed outcome. Not a response, not an error, not a status
 * message. Whether to try again is decided from that outcome alone, so an
 * implementation cannot widen the decision by attaching something to it, and
 * nothing an outside party wrote can end up in a durable file by travelling
 * back through here.
 */

import type { DeliveryOutcome } from './classify.js';
import type { QueueItem } from './item.js';
import type { OwnerId } from '../domain/owner.js';

/**
 * Who a drain is acting as.
 *
 * The owner, resolved by the caller from whatever credential it currently
 * holds — which is the point. A credential rotated since an item was queued
 * still delivers it, because the item was never tied to the credential that
 * produced it, only to the owner whose memory it belongs to.
 */
export interface DeliveryContext {
  readonly ownerId: OwnerId;
}

export interface RetryDelivery {
  /**
   * Attempts one queued write.
   *
   * Must not throw for an ordinary failure: a server that is down, a refused
   * request and a timeout are all outcomes, and reporting them as exceptions
   * would put the decision back into a shape that carries free text. Throwing
   * is reserved for a bug in the implementation itself.
   */
  deliver(item: QueueItem, context: DeliveryContext): Promise<DeliveryOutcome>;
}
