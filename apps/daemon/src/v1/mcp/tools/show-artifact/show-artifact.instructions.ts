import { ARTIFACT_DESIGN_GUIDANCE } from '../../../agents/utils/artifact-design';
import {
  MAX_ARTIFACT_IMAGE_BYTES,
  MAX_ARTIFACT_PAGE_IMAGE_BYTES,
  MAX_ARTIFACT_PAGE_IMAGES,
  megabytes,
} from '../../../agents/utils/artifact-image-policy';
import {
  MAX_ARTIFACT_MEDIA_BYTES,
  MAX_ARTIFACT_PAGE_MEDIA,
  MAX_ARTIFACT_PAGE_MEDIA_BYTES,
} from '../../../agents/utils/artifact-media-policy';

/**
 * What a model reads about `show_artifact`.
 *
 * TWIN PARSER: the tokens, `g-*` classes and Tailwind colours this
 * description names are defined in `agents/utils/artifact-runtime.ts`
 * (ARTIFACT_TOKEN_NAMES, ARTIFACT_KIT_STYLE, ARTIFACT_TAILWIND_THEME)
 * and handed over by the renderer's `THEME_TOKENS`; the description
 * audit in mcp-server.service.spec.ts fails on a name nothing defines.
 *
 * `inTeamRun` adds what only holds in a team run: a page reaches the
 * user from whichever agent publishes it, and its id is the RUN's.
 */
export function showArtifactInstructions(
  inTeamRun: boolean,
  shareOffered: boolean,
): string {
  return (
    'Publish a PAGE you have written — one HTML document this app shows beside the ' +
    'conversation and opens full-screen, with your own layout, your own styling and working ' +
    'interaction. ' +
    'Use it when the answer is a THING TO LOOK AT rather than something to read in order: a plan laid ' +
    'out as phases with their dependencies, a mechanism drawn as a diagram, an architecture the reader ' +
    'should be able to explore, a comparison with controls to filter it, a small calculator they can ' +
    'type into. ' +
    'Do NOT use it for an answer that reads fine as prose — a paragraph, a list, a short table all ' +
    'render in this transcript already, and putting them behind a click makes them harder to read, not ' +
    'easier. ' +
    'Do NOT use it in place of the tools that already draw one shape well: several readings of one ' +
    'measure is show_chart, a few headline figures is show_metrics, options judged against criteria is ' +
    'show_comparison, a set of pictures on disk or the web is show_gallery, and a plan you want APPROVED before ' +
    'you start is propose_plan — that one blocks on the user, this one does not ask them anything. ' +
    'Reach for this when what you need is a layout none of those can express. ' +
    ARTIFACT_DESIGN_GUIDANCE +
    '\n\n' +
    'Write one HTML document: your own markup, inline <style> and <script>. ' +
    'PICTURES on this machine go in by their absolute path — <img src="/tmp/shots/after.png"> — and the app ' +
    'copies each one into the page when you publish it, so the picture survives a restart and a revision, ' +
    'and the HTML stays small. PREFER that to a data: URI, which sits inside the HTML and counts against its ' +
    'size limit. ' +
    'Only <img src> is copied (a path anywhere else on the page does not load), and a click on a picture ' +
    'opens it in the app’s own viewer, so the page needs no click-to-enlarge viewer of its own. ' +
    'A local picture must be a png, jpeg, webp, gif or avif, judged by its contents rather than its name ' +
    `(an svg is refused), at most ${megabytes(MAX_ARTIFACT_IMAGE_BYTES)} MB each, ` +
    `${megabytes(MAX_ARTIFACT_PAGE_IMAGE_BYTES)} MB in all (a picture counts each time the page ` +
    `shows it) and ${MAX_ARTIFACT_PAGE_IMAGES} different pictures per page. A local picture must lie under /tmp, ` +
    'the system temp folder or this run’s project ' +
    'folder. A picture that breaks any of that REFUSES the whole page, with the reason, rather than showing ' +
    'a broken one. Remote pictures do not load. Close every tag, and write a > inside an attribute value as ' +
    '&gt; — a page with a tag that does not close is refused. ' +
    'AUDIO and VIDEO on this machine go in the same way, by absolute path in <audio controls src="…">, ' +
    '<video controls src="…"> or a <source src="…"> inside either, from the same folders: the app copies ' +
    'each file into the page and streams it from there. An mp3, aac, m4a, mp4, mov, wav, ogg, flac or webm, ' +
    `judged by its contents, at most ${megabytes(MAX_ARTIFACT_MEDIA_BYTES)} MB each, ` +
    `${megabytes(MAX_ARTIFACT_PAGE_MEDIA_BYTES)} MB and ${MAX_ARTIFACT_PAGE_MEDIA} files per page; a file that ` +
    'breaks any of that refuses the page. They play in this app only — a saved or shared copy of the page ' +
    'has no audio or video. ' +
    'FOLDER BUTTONS: data-geniro-open="/absolute/path" (no ~) on a button or link shows that path in Finder when ' +
    'the user clicks it — a plain folder opens; a file, an app or a folder whose name has a dot extension ' +
    'is selected in its folder instead, never opened or launched. It works on the user’s own click only, ' +
    'on this Mac only, and a path that is not there tells the user so under the page. ' +
    'ANSWERS the user picks on the page are KEPT, so you can read them later with artifact_answers instead ' +
    'of asking the user to copy them into the chat — never add a "copy for chat" button. Mark each control ' +
    'with data-geniro-answer="<name>": a radio group saves the value picked, several checkboxes a list of ' +
    'the ticked values, one checkbox true or false, a select or text field its value, and a button its ' +
    'value attribute (else its text) when pressed — the pressed one of a group gets aria-pressed="true", so ' +
    'style [aria-pressed="true"]; each is saved as the user changes it and put back when the page opens ' +
    'again, in every version of it. From script, ' +
    'geniro.saveAnswer(name, value) saves any JSON value (null forgets it), geniro.answers() returns them ' +
    'all, and geniro.onAnswers(callback) hears the kept ones when the page opens and again whenever ' +
    'another view of the page saves — keep it idempotent, and use it to redraw state your script derives ' +
    'from them. Put data-geniro-answer on each control itself, never on the row or group around it. ' +
    'LIBRARIES load from public CDNs with a plain <script src> in <head> — these exact URLs ' +
    'are pinned and allowed: ' +
    'ECharts https://cdnjs.cloudflare.com/ajax/libs/echarts/6.1.0/echarts.min.js — draw every chart ' +
    "with `geniro.chart('#el', option)` (the element needs a height), which applies the app's palette " +
    'and follows theme switches; ' +
    'Chart.js https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.5.1/chart.umd.min.js (themed ' +
    'automatically); ' +
    'Mermaid https://cdnjs.cloudflare.com/ajax/libs/mermaid/11.15.0/mermaid.min.js — write flowcharts, ' +
    'sequence, gantt, timeline or kanban diagrams in <pre class="mermaid">, drawn and themed for you; ' +
    'Lucide icons https://cdn.jsdelivr.net/npm/lucide@1.52.0/dist/umd/lucide.min.js — ' +
    '<i data-lucide="check"></i>, drawn on load (call geniro.icons() after adding more); ' +
    'SortableJS https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.7/Sortable.min.js for drag and drop; ' +
    'Grid.js https://cdnjs.cloudflare.com/ajax/libs/gridjs/6.2.0/gridjs.umd.js for sortable, searchable ' +
    'tables (its stylesheet: https://cdnjs.cloudflare.com/ajax/libs/gridjs/6.2.0/theme/mermaid.min.css); ' +
    'highlight.js https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.2/highlight.min.js — ' +
    '<pre><code class="language-ts">, highlighted on load; ' +
    'Tailwind https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.3/dist/index.global.js — its ' +
    'colours bg-surface, text-fg, text-muted, border-border, bg-subtle, text-primary, text-success, ' +
    'text-danger and text-chart-1…5 are the app theme; ' +
    'Preact + htm https://cdn.jsdelivr.net/npm/htm@3.1.1/preact/standalone.umd.js (global htmPreact: ' +
    'html, render, useState) for stateful UI without a build step. ' +
    'For a complex React, Radix or shadcn/ui interface, build in a task-owned folder and bundle all ' +
    'JavaScript, CSS and assets into this one HTML document before publishing. JSX, bare package ' +
    'imports, separate local script/style files and lazy chunks do not run here; the final page must ' +
    'not depend on a dev server, runtime compilation or data fetching. Prefer native HTML or Preact ' +
    'for a small artifact rather than scaffolding an app for it. ' +
    'Other packages from cdnjs, cdn.jsdelivr.net/npm or unpkg load too, and Google Fonts stylesheets. ' +
    'Everything else is blocked without an error: the page has no network of its own, so fetch(), XHR ' +
    'and WebSockets silently fail — put the data in the page. ' +
    'BUILDING BLOCKS in the app’s own look — use them for these standard parts rather than writing CSS ' +
    'for a card, badge, step, callout or table of your own; they are not a mandatory layout: g-card ' +
    '(+ g-card-title), g-grid of g-stat tiles ' +
    '(g-stat-label, g-stat-value, g-delta with g-delta-good / g-delta-bad), g-badge (+ -success, ' +
    '-warning, -danger, -info) for a status or pill, g-table inside a g-table-wrap (g-num on numeric ' +
    'cells and their header), numbered steps as g-step > g-step-num + g-step-body, a note as g-callout ' +
    '(+ -success, -warning, -danger), a folded section as details.g-disclosure > summary + ' +
    'g-disclosure-body, label/value pairs as dl.g-kv, g-nowrap, g-kanban > ' +
    'g-kanban-col > g-kanban-head + g-kanban-list > g-kanban-card, g-btn (+ g-btn-secondary), g-row, ' +
    "g-muted. Your own rules always win over them — except CSS you put in Tailwind's @layer base, which " +
    "ranks below geniro's base styles (body padding, link colour); write those rules unlayered. " +
    "By default, keep the outer page transparent on the app's background and use its theme tokens: " +
    '--geniro-fg, --geniro-muted, --geniro-bg, --geniro-surface, --geniro-subtle, ' +
    '--geniro-border, --geniro-primary, --geniro-primary-fg, --geniro-success, --geniro-warning, ' +
    '--geniro-danger, --geniro-chart-1…5 (series colours, in order), --geniro-radius, --geniro-font ' +
    'and --geniro-font-mono, each with a fallback (`var(--geniro-fg, #111)`). ' +
    'When the brief calls for a distinct brand or a product mockup, define your own scoped palette, ' +
    'surfaces and typography with readable fallbacks; Google Fonts are supported. Pair custom foreground ' +
    'and background colours explicitly. Follow the actual host appearance using geniro.theme().dark ' +
    'and update on the window event geniro:theme; system prefers-color-scheme alone can disagree with ' +
    "the app's selected theme. Keep both appearances legible unless the user explicitly requested a " +
    'fixed theme. The kit is a starting point; your own CSS can change its type, geometry and surfaces. ' +
    'To REVISE a page you already published, call this again with the SAME artifact_id — it replaces ' +
    'the page in place as a new version rather than adding a second one, which is how a plan stays ' +
    'current while you work. A different id, or none, makes a new page. ' +
    'For a SMALL change — a figure, a row, a status, a paragraph — send edits instead of html: ' +
    'exact-text replacements against the HTML you last published, with base_version set to the version ' +
    'the last receipt named, so you never resend the whole page. Send html when you rewrite most of it. ' +
    'Edits against a version that is no longer the latest are refused; the refusal names the latest. ' +
    'Call it ONCE per page, and do not also write the content out as text: the user sees the page, so ' +
    'restating it shows the same thing twice. Say what it SHOWS, and what you want them to notice. ' +
    (inTeamRun ? `${TEAM_RUN_PAGES} ` : '') +
    (shareOffered ? `${SHARING} ` : '') +
    'The result is a short receipt naming the artifact_id and version, never the document.'
  );
}

const TEAM_RUN_PAGES =
  'In this team run a page reaches the user’s chat WHICHEVER agent of the run publishes it: one ' +
  'you publish while answering another agent’s call is shown to the user directly, and that call’s ' +
  'result names its artifact_id, title and version to your caller. So the agent that holds the ' +
  'content publishes the page itself — never hand the HTML to your caller to publish for you. ' +
  'Ids belong to the whole run: publishing an artifact_id any agent of this run already used revises ' +
  'that one page, across calls and thread continuations, instead of adding a second.';

const SHARING =
  'SHARING: with share: true the page is also encrypted on this machine and uploaded to the place the ' +
  'user set up, and the receipt carries "Shared link: <url>" — a link anyone holding it can open, so ' +
  'put it only where the user asked for it (a pull request, a message they named), never in a file ' +
  'committed to a repository. Share only when asked to. When the receipt says "Not shared", say so ' +
  'and why; never invent a link. When it says "Not shared yet" the user was asked to sign in: do not ' +
  'retry — a message with "Shared link: <url>" (or why it failed) starts your next turn once they have.';
