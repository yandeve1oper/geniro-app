/** The shape of a hast node, as far as the renderer reads it. */
export interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Elements whose whitespace is the text itself, never layout between blocks. */
const VERBATIM_TAGS = new Set(['pre', 'code']);

/**
 * Lets an image written mid-sentence draw on a line of its own.
 *
 * A paragraph keeps its whitespace (`whitespace-pre-wrap`), so the space or
 * line break an agent wrote around `![…](…)` would sit beside the picture as an
 * indent and a blank line. The picture is a block box, so trimming the text
 * that touches it is all that separates the two.
 */
export function markdownImageBlocks(): (tree: HastNode) => void {
  return (tree) => {
    tidy(tree);
  };
}

function tidy(node: HastNode): void {
  if (node.tagName !== undefined && VERBATIM_TAGS.has(node.tagName)) {
    return;
  }
  if (node.children === undefined) {
    return;
  }
  node.children = trimAroundImages(node.children);
  node.children.forEach(tidy);
}

function trimAroundImages(children: HastNode[]): HastNode[] {
  const emptied = new Set<HastNode>();
  children.forEach((child, index) => {
    if (!isImageBlock(child)) {
      return;
    }
    const before: HastNode | undefined = children[index - 1];
    const after: HastNode | undefined = children[index + 1];
    if (before !== undefined) {
      trimText(before, (value) => value.trimEnd(), emptied);
    }
    if (after !== undefined) {
      trimText(after, (value) => value.trimStart(), emptied);
    }
  });
  return emptied.size === 0
    ? children
    : children.filter((child) => !emptied.has(child));
}

function trimText(
  node: HastNode,
  trim: (value: string) => string,
  emptied: Set<HastNode>,
): void {
  if (node.type !== 'text' || node.value === undefined) {
    return;
  }
  node.value = trim(node.value);
  if (node.value === '') {
    emptied.add(node);
  }
}

/** An image, or a link whose only content is one. */
function isImageBlock(node: HastNode): boolean {
  if (node.tagName === 'img') {
    return true;
  }
  return (
    node.tagName === 'a' &&
    node.children?.length === 1 &&
    node.children[0]?.tagName === 'img'
  );
}
