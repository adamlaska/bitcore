import { ChainStateProvider } from '../../providers/chain-state';
import { Api } from '../../services/api';
import { P2P } from '../../services/p2p';
import { Verification } from '../../services/verification';
import { ChainNetwork } from '../../types/ChainNetwork';
import { RippleStateProvider } from './api/csp';
import { XrpRoutes } from './api/xrp-routes';
import { XrpP2pWorker } from './p2p';
import { XrpVerificationPeer } from './p2p/verification';

export default function register({ chain, network }: ChainNetwork) {
  ChainStateProvider.registerService(chain, network, new RippleStateProvider());
  Api.app.use(XrpRoutes);
  P2P.register(chain, network, XrpP2pWorker);
  Verification.register(chain, network, XrpVerificationPeer);
}
