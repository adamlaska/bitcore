import { ChainStateProvider } from '../../providers/chain-state';
import { Api } from '../../services/api';
import { ChainNetwork } from '../../types/ChainNetwork';
import { SOLStateProvider } from './api/csp';
import { SOLRoutes } from './api/sol-routes';

export default function register({ chain, network }: ChainNetwork) {
  ChainStateProvider.registerService(chain, network, new SOLStateProvider());
  Api.app.use(SOLRoutes);
}
