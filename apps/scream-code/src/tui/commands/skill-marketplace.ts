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
      id: 'gsap-skills',
      displayName: t('market.gsap_name'),
      description: t('market.gsap_desc'),
      source: 'https://github.com/greensock/gsap-skills',
    },
    {
      id: 'claude-design-card',
      displayName: t('market.design_card_name'),
      description: t('market.design_card_desc'),
      source: 'https://github.com/geekjourneyx/claude-design-card',
    },
    {
      id: 'superpowers',
      displayName: t('market.superpowers_name'),
      description: t('market.superpowers_desc'),
      source: 'https://github.com/obra/superpowers',
    },
    {
      id: 'scrapling-skill',
      displayName: t('market.scrapling_name'),
      description: t('market.scrapling_desc'),
      source: 'https://github.com/Cedriccmh/claude-code-skill-scrapling',
    },
    {
      id: 'a-stock-data',
      displayName: t('market.astock_name'),
      description: t('market.astock_desc'),
      source: 'https://github.com/simonlin1212/a-stock-data',
    },
    {
      id: 'humanizer',
      displayName: t('market.humanizer_name'),
      description: t('market.humanizer_desc'),
      source: 'https://github.com/blader/humanizer',
    },
    {
      id: 'patent-disclosure-skill',
      displayName: t('market.patent_name'),
      description: t('market.patent_desc'),
      source: 'https://github.com/handsomestWei/patent-disclosure-skill',
    },
    {
      id: 'contract-review-pro',
      displayName: t('market.contract_name'),
      description: t('market.contract_desc'),
      source: 'https://github.com/CSlawyer1985/contract-review-pro',
    },
    {
      id: 'academic-research-skills',
      displayName: t('market.academic_name'),
      description: t('market.academic_desc'),
      source: 'https://github.com/Imbad0202/academic-research-skills',
    },
    {
      id: 'headroom',
      displayName: t('market.headroom_name'),
      description: t('market.headroom_desc'),
      source: 'https://github.com/chopratejas/headroom',
    },
    {
      id: 'xiaohu-wechat-format',
      displayName: t('market.xiaohu_wechat_name'),
      description: t('market.xiaohu_wechat_desc'),
      source: 'https://github.com/xiaohuailabs/xiaohu-wechat-format',
    },
    {
      id: 'huashu-design',
      displayName: t('market.huashu_name'),
      description: t('market.huashu_desc'),
      source: 'https://github.com/alchaincyf/huashu-design',
    },
    {
      id: 'html-video',
      displayName: t('market.html_video_name'),
      description: t('market.html_video_desc'),
      source: 'https://github.com/nexu-io/html-video',
    },
    {
      id: 'xiaohu-video-translate',
      displayName: t('market.xiaohu_translate_name'),
      description: t('market.xiaohu_translate_desc'),
      source: 'https://github.com/xiaohuailabs/xiaohu-video-translate',
    },
    {
      id: 'videocut-skills',
      displayName: t('market.videocut_name'),
      description: t('market.videocut_desc'),
      source: 'https://github.com/Ceeon/videocut-skills',
    },
    {
      id: 'taste-skill',
      displayName: t('market.taste_name'),
      description: t('market.taste_desc'),
      source: 'https://github.com/Leonxlnx/taste-skill',
    },
    {
      id: 'vtake-skills',
      displayName: t('market.vtake_name'),
      description: t('market.vtake_desc'),
      source: 'https://github.com/notedit/vtake-skills',
    },
    {
      id: 'remotion-skills',
      displayName: t('market.remotion_name'),
      description: t('market.remotion_desc'),
      source: 'https://github.com/remotion-dev/skills',
    },
    {
      id: 'html-anything',
      displayName: t('market.html_anything_name'),
      description: t('market.html_anything_desc'),
      source: 'https://github.com/nexu-io/html-anything',
    },
    {
      id: 'guizang-social-card-skill',
      displayName: t('market.guizang_name'),
      description: t('market.guizang_desc'),
      source: 'https://github.com/op7418/guizang-social-card-skill',
    },
  ];
}
