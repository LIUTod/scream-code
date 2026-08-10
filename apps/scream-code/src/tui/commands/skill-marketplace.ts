/**
 * Fallback skill marketplace shipped with the binary.
 *
 * Used when the remote marketplace cannot be fetched at runtime.
 */

import { t } from '@scream-code/config';

export interface FallbackMarketplaceEntry {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly source: string;
}

export function getFallbackSkillMarketplace(): readonly FallbackMarketplaceEntry[] {
  return [
    {
      id: 'contract-review-pro',
      displayName: t('market.contract_name'),
      description: t('market.contract_desc'),
      source: 'https://github.com/CSlawyer1985/contract-review-pro',
    },
    {
      id: 'humanizer',
      displayName: t('market.humanizer_name'),
      description: t('market.humanizer_desc'),
      source: 'https://github.com/blader/humanizer',
    },
  ];
}
