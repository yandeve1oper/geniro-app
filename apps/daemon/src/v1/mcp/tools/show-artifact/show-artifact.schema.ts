import { MAX_ARTIFACT_HTML_BYTES } from '../../../agents/chat.types';

/**
 * `show_artifact`'s arguments. `share` is listed only while the user lets
 * agents share pages, so an agent is never offered a switch that refuses.
 */
export function showArtifactSchema(
  shareOffered: boolean,
): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description:
          'What the page IS, as its heading and its row in the panel — e.g. "Migration plan". Keep it short.',
      },
      html: {
        type: 'string',
        description:
          'The whole document — or leave it out and pass edits to change a page you already published. ' +
          'Inline <style>/<script>, libraries only from the CDN URLs above, and no ' +
          'fetch of any kind. A picture on this machine goes in as its absolute path in <img src>, not as a ' +
          'data: URI. ' +
          `At most ${Math.floor(MAX_ARTIFACT_HTML_BYTES / 1024)}KB of HTML: a picture named by its path adds only ` +
          'the path, and an oversize page is REFUSED rather than cut short, so write a smaller one.',
      },
      artifact_id: {
        type: 'string',
        description:
          'A short lowercase slug naming this page — e.g. "migration-plan". Pass the SAME one again to ' +
          'revise that page in place; omit it for a page that has nothing to revise.',
      },
      edits: {
        type: 'array',
        description:
          'In place of html, to revise the page named by artifact_id: exact-text replacements applied in ' +
          'order to the HTML you last published for it, the way a file edit works. Each old_string must ' +
          'appear exactly once (unless replace_all), copied exactly, whitespace included; a picture is still ' +
          'named by the path you wrote. All or nothing: if one edit does not apply, nothing is published.',
        items: {
          type: 'object',
          properties: {
            old_string: {
              type: 'string',
              description: 'The exact text to replace.',
            },
            new_string: {
              type: 'string',
              description: 'The text to put in its place.',
            },
            replace_all: {
              type: 'boolean',
              description:
                'true to replace every occurrence of old_string rather than exactly one.',
            },
          },
          required: ['old_string', 'new_string'],
        },
      },
      base_version: {
        type: 'integer',
        description:
          'With edits: the version the last receipt for this page named. If the page has moved on since ' +
          '(another agent revised it), the edits are refused rather than applied to a page you have not seen.',
      },
      summary: {
        type: 'string',
        description:
          'One line under the title in the panel. Optional — leave it out when the title already says it. ' +
          'Each call shows its own, edits included: send it again to keep it.',
      },
      ...(shareOffered
        ? {
            share: {
              type: 'boolean',
              description:
                'true to ALSO upload this page as an end-to-end-encrypted link anyone holding it can open. ' +
                'Only when the user or your instructions ask for the page to be shared. Passing it again ' +
                'when you revise a shared page updates what its link shows; the link stays the same.',
            },
          }
        : {}),
    },
    required: ['title'],
  };
}
