import { ChainStateProvider } from '../../providers/chain-state';
import { EVMVerificationPeer } from '../../providers/chain-state/evm/p2p/EVMVerificationPeer';
import { EVMP2pWorker } from '../../providers/chain-state/evm/p2p/p2p';
import { Api } from '../../services/api';
import { P2P } from '../../services/p2p';
import { Verification } from '../../services/verification';
import { IEVMNetworkConfig } from '../../types/Config';
import { MATICStateProvider } from './api/csp';
import { MaticRoutes } from './api/matic-routes';

export default class MATICModule {
  constructor(chain: string, network: string, _config: IEVMNetworkConfig) {
    P2P.register(chain, network, EVMP2pWorker);
    ChainStateProvider.registerService(chain, network, new MATICStateProvider());
    Api.app.use(MaticRoutes);
    Verification.register(chain, network, EVMVerificationPeer);
  }
}
