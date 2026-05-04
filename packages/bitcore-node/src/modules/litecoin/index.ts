import { ChainStateProvider } from '../../providers/chain-state';
import { LTCStateProvider } from '../../providers/chain-state/ltc/ltc';
import { Libs } from '../../providers/libs';
import { P2P } from '../../services/p2p';
import { Verification } from '../../services/verification';
import { IUtxoNetworkConfig } from '../../types/Config';
import { VerificationPeer } from '../bitcoin/VerificationPeer';
import { LitecoinP2PWorker } from './p2p';

export default class LTCModule {
  constructor(chain: string, network: string, _config: IUtxoNetworkConfig) {
    Libs.register(chain, '@bitpay-labs/bitcore-lib-ltc', '@bitpay-labs/bitcore-p2p');
    P2P.register(chain, network, LitecoinP2PWorker);
    ChainStateProvider.registerService(chain, network, new LTCStateProvider());
    Verification.register(chain, network, VerificationPeer);
  }
}
