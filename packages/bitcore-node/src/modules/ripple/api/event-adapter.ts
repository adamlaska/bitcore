import type { XrpRpc } from '@bitpay-labs/crypto-rpc/lib/xrp/XrpRpc';

export class RippleEventAdapter {
  stopping = false;
  clients: XrpRpc[] = [];
  constructor(protected network: string) {}

  async start() {
    return;
  }

  async stop() {
    this.stopping = true;
    for (const client of this.clients) {
      client.rpc.removeAllListeners();
      await client.asyncRequest('unsubscribe', { streams: ['ledger', 'transactions_proposed'] });
      client.rpc.disconnect();
    }
  }
}
