import { ChainStateProvider } from '../../providers/chain-state';
import { EVMVerificationPeer } from '../../providers/chain-state/evm/p2p/EVMVerificationPeer';
import { Api } from '../../services/api';
import { P2P } from '../../services/p2p';
import { Verification } from '../../services/verification';
import { IEVMNetworkConfig } from '../../types/Config';
import { ETHStateProvider } from './api/csp';
import { EthRoutes } from './api/eth-routes';
import { EthP2pWorker } from './p2p/p2p';

export default class ETHModule {
  constructor(chain: string, network: string, _config: IEVMNetworkConfig) {
    P2P.register(chain, network, EthP2pWorker);
    ChainStateProvider.registerService(chain, network, new ETHStateProvider());
    Api.app.use(EthRoutes);
    Verification.register(chain, network, EVMVerificationPeer);
  }
}
