import { HOST_ARTIFACT_ANSWERS_TOOL, HOST_ARTIFACT_TOOL } from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names geniro's OWN artifact tool.
 *
 * Auto-approved on the family's reading: what the agent is asking to run is the
 * act of publishing a page into this app's own panel. The document reaches a
 * sandboxed frame rather than the user's disk, and its CSP opens no channel of
 * its own — so a card guarding it would fire on every artifact for one residual
 * risk, accepted by decision rather than overlooked: a page may load libraries
 * from the fixed CDNs, and the URL of such a request can carry data the page
 * holds — into the CDN's logs and, on jsDelivr, into the per-package request
 * statistics an npm publisher can read — in every approval mode.
 *
 * `share: true` uploads the page, encrypted, to a place the user configured.
 * No card guards that either: the user's own "Let agents share pages" switch
 * (off by default) is the consent, checked by `ShareService.shareForAgent` on
 * every call.
 *
 * How the pair is matched belongs to {@link isHostToolCall}.
 */
export function isHostArtifactCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_ARTIFACT_TOOL);
}

/**
 * Whether a permission request names geniro's tool that reads back what the user
 * picked on the run's pages. Auto-approved like the page tool itself: it reads
 * only the calling run's own pages, and only what their user picked there.
 */
export function isHostArtifactAnswersCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_ARTIFACT_ANSWERS_TOOL);
}
