/**
 * Hydration entry points. Each takes one JSON string prop (see encodeIslandProps), which keeps the
 * serialized props in the HTML small; the components themselves take typed props.
 */
import { useMemo } from 'preact/hooks';
import { decodeIslandProps } from '../../lib/view';
import { Compare } from './Compare';
import { Explorer } from './Explorer';
import { Leaderboard } from './Leaderboard';

type PropsOf<C> = C extends (props: infer P) => unknown ? P : never;

export function ExplorerIsland({ payload }: { payload: string }) {
  const props = useMemo(() => decodeIslandProps<PropsOf<typeof Explorer>>(payload), [payload]);
  return <Explorer {...props} />;
}

export function CompareIsland({ payload }: { payload: string }) {
  const props = useMemo(() => decodeIslandProps<PropsOf<typeof Compare>>(payload), [payload]);
  return <Compare {...props} />;
}

export function LeaderboardIsland({ payload }: { payload: string }) {
  const props = useMemo(() => decodeIslandProps<PropsOf<typeof Leaderboard>>(payload), [payload]);
  return <Leaderboard {...props} />;
}
