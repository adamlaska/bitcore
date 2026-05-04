import { EventEmitter } from 'events';
import { ChainStateProvider } from '../../providers/chain-state';
import { Api } from '../../services/api';
import { Event } from '../../services/event';
import { P2P } from '../../services/p2p';
import { Verification } from '../../services/verification';
import { IXrpNetworkConfig } from '../../types/Config';
import { RippleStateProvider } from './api/csp';
import { RippleEventAdapter } from './api/event-adapter';
import { XrpRoutes } from './api/xrp-routes';
import { XrpP2pWorker } from './p2p';
import { XrpVerificationPeer } from './p2p/verification';

export default class XRPModule {
  static startMonitor: EventEmitter;
  static endMonitor: EventEmitter;
  constructor(chain: string, network: string, _config: IXrpNetworkConfig) {
    ChainStateProvider.registerService(chain, network, new RippleStateProvider());
    Api.app.use(XrpRoutes);
    P2P.register(chain, network, XrpP2pWorker);
    Verification.register(chain, network, XrpVerificationPeer);

    if (!XRPModule.startMonitor) {
      const adapter = new RippleEventAdapter(network);
      XRPModule.startMonitor = Event.events.on('start', async () => {
        await adapter.start();
      });
      XRPModule.endMonitor = Event.events.on('stop', async () => {
        await adapter.stop();
      });
    }
  }
}
