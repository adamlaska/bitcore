import { ChainStateProvider } from '../../providers/chain-state';
import { EVMRouter } from '../../providers/chain-state/evm/api/routes';
import { EVMVerificationPeer } from '../../providers/chain-state/evm/p2p/EVMVerificationPeer';
import { Api } from '../../services/api';
import { P2P } from '../../services/p2p';
import { Verification } from '../../services/verification';
import { ChainNetwork } from '../../types/ChainNetwork';
import { MoralisStateProvider } from './api/csp';
import { MoralisP2PWorker } from './p2p/p2p';

export default function register({ chain, network }: ChainNetwork) {
  P2P.register(chain, network, MoralisP2PWorker);
  const csp = new MoralisStateProvider(chain);
  ChainStateProvider.registerService(chain, network, csp);
  Api.app.use(new EVMRouter(csp, chain).getRouter());
  Verification.register(chain, network, EVMVerificationPeer);
}
