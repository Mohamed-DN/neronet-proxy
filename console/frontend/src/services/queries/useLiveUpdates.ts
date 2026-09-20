import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { subscribeToSession } from '../authToken';
import { createLiveChannel, topicOf, type LiveChannelOptions, type LiveEvent } from '../live';
import { queryKeys } from './keys';

type QueryKey = readonly unknown[];

/**
 * Turns control-plane events into cache invalidations.
 *
 * Exported separately from the hook so the mapping can be tested against a
 * query client without a socket.
 */
export function invalidateForEvent(invalidate: (key: QueryKey) => void, event: LiveEvent): readonly QueryKey[] {
  const topic = topicOf(event);
  const keys: readonly QueryKey[] = (() => {
    switch (topic) {
      case 'nodes': {
        const nodeId = typeof event.node_id === 'string' ? event.node_id : null;
        const base: readonly QueryKey[] = [queryKeys.nodes, queryKeys.statsOverview, queryKeys.statsTopology];
        return nodeId ? [...base, queryKeys.node(nodeId)] : base;
      }
      case 'risk':
        return [queryKeys.riskSummary, queryKeys.nodes];
      case 'peering':
        return [queryKeys.peering, queryKeys.statsTopology];
      case 'acl':
        return [queryKeys.acl, queryKeys.statsTopology];
      default:
        // The greeting frame, a pong, or an event this console does not cache.
        // Invalidating everything on an unrecognised frame would turn one
        // unknown event into a refetch of the whole console.
        return [];
    }
  })();

  for (const key of keys) invalidate(key);
  return keys;
}

/**
 * Holds the live channel open for as long as there is a session, and keeps the
 * cache in step with it. Mounted once, by the layout.
 */
export function useLiveUpdates(enabled: boolean, options?: LiveChannelOptions): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

    const channel = createLiveChannel(options);
    const unsubscribe = channel.subscribe((event) => {
      invalidateForEvent((queryKey) => {
        void queryClient.invalidateQueries({ queryKey });
      }, event);
    });

    channel.start();
    // The socket carries the token in its URL, so a new token needs a new
    // socket. Sign-out clears the token and start() then parks the channel.
    const unsubscribeSession = subscribeToSession(() => channel.start());

    return () => {
      unsubscribeSession();
      unsubscribe();
      channel.stop();
    };
  }, [enabled, queryClient, options]);
}
