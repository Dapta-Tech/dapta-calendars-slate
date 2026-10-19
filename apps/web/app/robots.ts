import type { MetadataRoute } from 'next';
import { deploymentNoindex } from '@/lib/indexing';
import { robotsPolicy } from '@/lib/robots';

// Per request, not at build: `NOINDEX` is runtime env, and one image serves
// both a noindexed staging and an indexed production.
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  return robotsPolicy(deploymentNoindex());
}
