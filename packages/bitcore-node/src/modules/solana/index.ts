import { ChainStateProvider } from '../../providers/chain-state';
import { Api } from '../../services/api';
import { SOLStateProvider } from './api/csp';
import { SOLRoutes } from './api/sol-routes';

export default class SOLModule {
  constructor(chain: string, network: string) {
    ChainStateProvider.registerService(chain, network, new SOLStateProvider());
    Api.app.use(SOLRoutes);
  }
}
