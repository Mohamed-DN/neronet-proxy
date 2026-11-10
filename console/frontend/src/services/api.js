/**
 * The adapter the pages still call.
 *
 * WP-402 moved transport, authentication and caching into `apiClient`, and each
 * resource the pages read now has a query hook beside it in services/queries.
 * Nothing reads a resource through this file any more. What is left is the one
 * call with no hook yet: the account self-destruct, started from the sidebar.
 *
 * The fixtures and the namespaces that only served the pages that moved (nodes,
 * users, peering, risk, cloud PCs, configs, stats, audit, acl, features and the
 * rest of nuke) are gone. A write that fails throws: nothing that changes state
 * may report success it cannot account for.
 */

import { apiRequest } from './apiClient';

/** A write. Throws whatever went wrong, always. */
function write(endpoint, method, body) {
  return apiRequest(endpoint, body === undefined ? { method } : { method, body });
}

export const api = {
  nuke: {
    // Tier 1: user account self-destruct, immediate.
    async userSelfDestruct(confirmationText, disclaimerAccepted) {
      if (confirmationText !== 'DELETE MY ACCOUNT' || !disclaimerAccepted) {
        throw new Error("Must accept disclaimer and type exact confirmation 'DELETE MY ACCOUNT'");
      }
      return write('/nuke/user/self-destruct', 'POST', {
        confirmation_text: confirmationText,
        disclaimer_accepted: disclaimerAccepted
      });
    }
  }
};

export default api;
